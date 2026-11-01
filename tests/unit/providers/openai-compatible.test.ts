// T-002 验收：正常 / 429退避 / 超时 / abort / 超长自动分片 五场景
import { describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from '../../../src/service/providers/openai-compatible';
import type { FetchFn } from '../../../src/service/providers/util';
import type { Segment } from '../../../src/shared/types';

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function seg(id: string, text = `text-${id}`): Segment {
  return { id, text };
}

function jsonRes(obj: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => obj,
  } as unknown as Response;
}

/** mock fetch：每次调用依序执行 script 工厂，越界时沿用最后一个工厂 */
function scriptedFetch(
  script: Array<(body: Record<string, unknown>) => Response | Promise<Response>>,
): { fetchFn: FetchFn; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const reqInit = (init ?? {}) as RequestInit;
    const headers = Object.fromEntries(new Headers(reqInit.headers).entries());
    const body = JSON.parse(reqInit.body as unknown as string) as Record<string, unknown>;
    calls.push({ url: String(url), headers, body });
    const factory = script[Math.min(calls.length - 1, script.length - 1)];
    return await factory(body);
  };
  return { fetchFn, calls };
}

/** 仿真 OpenAI 响应：取第一条可解析的 JSON payload（{...）的 items 回放为任意加工后的 JSON 数组 */
function openAiReplies(
  fn: (texts: string[]) => string[],
): (body: Record<string, unknown>) => Response {
  return (body) => {
    const messages = (body as { messages: Array<{ role: string; content: string }> }).messages;
    const payloadMsg = messages.find(
      (m) => m.role === 'user' && m.content.trimStart().startsWith('{'),
    );
    const items = JSON.parse(payloadMsg?.content ?? '{}') as { items: Array<{ text: string }> };
    return jsonRes({
      choices: [{ message: { content: JSON.stringify(fn(items.items.map((i) => i.text))) } }],
    });
  };
}

function userItems(call: RecordedCall): unknown[] {
  const messages = call.body.messages as Array<{ role: string; content: string }>;
  const payloadMsg = messages.find(
    (m) => m.role === 'user' && m.content.trimStart().startsWith('{'),
  );
  return (JSON.parse(payloadMsg?.content ?? '{}') as { items: unknown[] }).items;
}

const baseCfg = {
  type: 'openai-compatible' as const,
  enabled: true,
  baseUrl: 'https://api.test/v1',
  apiKey: 'sk-test',
  model: 'test-model',
};
const opts = { baseDelayMs: 1, timeoutMs: 30 };

describe('OpenAICompatibleProvider', () => {
  it('正常翻译：结果按输入顺序对齐，请求带 model 与 Authorization', async () => {
    const { fetchFn, calls } = scriptedFetch([openAiReplies((ts) => ts.map((t) => `译:${t}`))]);
    const p = new OpenAICompatibleProvider(baseCfg, fetchFn, opts);
    const out = await p.translateBatch([seg('a'), seg('b')], 'auto', 'zh-CN');
    expect(out.map((o) => o.text)).toEqual(['译:text-a', '译:text-b']);
    expect(out.every((o) => o.error === undefined)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.model).toBe('test-model');
    expect(calls[0]?.headers.authorization).toBe('Bearer sk-test');
  });

  it('占位符 [[1]] 原样透传', async () => {
    const { fetchFn } = scriptedFetch([openAiReplies((ts) => ts)]);
    const p = new OpenAICompatibleProvider(baseCfg, fetchFn, opts);
    const out = await p.translateBatch([seg('x', 'Hello [[1]] world')], 'auto', 'zh-CN');
    expect(out[0]?.text).toContain('[[1]]');
  });

  it('25 段按 batchLimit=10 分 3 个请求，顺序不乱', async () => {
    const { fetchFn, calls } = scriptedFetch([openAiReplies((ts) => ts.map((t) => `T{${t}}`))]);
    const p = new OpenAICompatibleProvider(baseCfg, fetchFn, opts);
    const segs = Array.from({ length: 25 }, (_, i) => seg(`i${i}`));
    const out = await p.translateBatch(segs, 'auto', 'zh-CN');
    expect(calls).toHaveLength(3);
    expect(out).toHaveLength(25);
    expect(out.map((o) => o.id)).toEqual(segs.map((s) => s.id));
    expect(userItems(calls[0] as RecordedCall)).toHaveLength(10);
    expect(userItems(calls[2] as RecordedCall)).toHaveLength(5);
  });

  it('429 两次后退避重试成功（共 3 次调用）', async () => {
    const rateRes = () => jsonRes({ error: 'rate' }, 429);
    const { fetchFn, calls } = scriptedFetch([rateRes, rateRes, openAiReplies((ts) => ts.map((t) => `ok:${t}`))]);
    const p = new OpenAICompatibleProvider(baseCfg, fetchFn, opts);
    const out = await p.translateBatch([seg('q')], 'auto', 'zh-CN');
    expect(calls).toHaveLength(3);
    expect(out[0]?.text).toBe('ok:text-q');
  });

  it('持续 429 → E_RATE_LIMITED，不抛异常', async () => {
    const { fetchFn, calls } = scriptedFetch([() => jsonRes({ error: 'rate' }, 429)]);
    const p = new OpenAICompatibleProvider(baseCfg, fetchFn, opts);
    const out = await p.translateBatch([seg('q')], 'auto', 'zh-CN');
    expect(calls).toHaveLength(4); // 首次 + 3 次重试
    expect(out[0]?.error?.code).toBe('E_RATE_LIMITED');
  });

  it('超时 → E_TIMEOUT', async () => {
    const fetchFn: FetchFn = (_u, i) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = (i as RequestInit).signal as AbortSignal;
        signal.addEventListener('abort', () => {
          reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
        });
      });
    const p = new OpenAICompatibleProvider(baseCfg, fetchFn, { ...opts, timeoutMs: 10 });
    const out = await p.translateBatch([seg('t')], 'auto', 'zh-CN');
    expect(out[0]?.error?.code).toBe('E_TIMEOUT');
  });

  it('abort：abort() 后未开始的窗口立即 E_ABORTED', async () => {
    const { fetchFn } = scriptedFetch([openAiReplies((ts) => ts)]);
    const p = new OpenAICompatibleProvider(baseCfg, fetchFn, opts);
    p.abort();
    const out = await p.translateBatch([seg('a'), seg('b')], 'auto', 'zh-CN');
    expect(out.every((o) => o.error?.code === 'E_ABORTED')).toBe(true);
  });

  it('缺配置 → 全部 E_NO_KEY，零网络请求', async () => {
    const { fetchFn, calls } = scriptedFetch([openAiReplies((ts) => ts)]);
    const p = new OpenAICompatibleProvider({ ...baseCfg, apiKey: undefined }, fetchFn, opts);
    const out = await p.translateBatch([seg('k')], 'auto', 'zh-CN');
    expect(out[0]?.error?.code).toBe('E_NO_KEY');
    expect(calls).toHaveLength(0);
  });

  it('500 → E_PROVIDER_DOWN', async () => {
    const { fetchFn } = scriptedFetch([() => jsonRes({ error: 'boom' }, 500)]);
    const p = new OpenAICompatibleProvider(baseCfg, fetchFn, opts);
    const out = await p.translateBatch([seg('c')], 'auto', 'zh-CN');
    const err = out[0]?.error;
    expect(err?.code).toBe('E_PROVIDER_DOWN');
    expect(err?.code === 'E_PROVIDER_DOWN' ? err.detail : undefined).toBe('HTTP 500');
  });

  it('宽松解析：带 ```json 围栏也能解析', async () => {
    const { fetchFn } = scriptedFetch([
      () =>
        jsonRes({
          choices: [{ message: { content: '```json\n["你好","世界"]\n```' } }],
        }),
    ]);
    const p = new OpenAICompatibleProvider(baseCfg, fetchFn, opts);
    const out = await p.translateBatch([seg('1'), seg('2')], 'auto', 'zh-CN');
    expect(out.map((o) => o.text)).toEqual(['你好', '世界']);
  });

  it('长度不匹配：第二次宽容重试后成功', async () => {
    const bad = () => jsonRes({ choices: [{ message: { content: '["只回了一条"]' } }] });
    const { fetchFn, calls } = scriptedFetch([bad, openAiReplies((ts) => ts.map((t) => `T:${t}`))]);
    const p = new OpenAICompatibleProvider(baseCfg, fetchFn, opts);
    const out = await p.translateBatch([seg('a'), seg('b')], 'auto', 'zh-CN');
    expect(calls).toHaveLength(2);
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.error === undefined)).toBe(true);
  });
});
