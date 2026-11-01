import { describe, expect, it } from 'vitest';
import { GoogleFreeProvider } from '../../../src/service/providers/google-free';
import type { Segment } from '../../../src/shared/types';

const SEP = '@@@itrsep@@@';

function seg(id: string, text = `t-${id}`): Segment {
  return { id, text };
}

function res(
  status: number,
  bodyFactory: () => { body?: unknown; text?: string; headers?: Headers },
): Response {
  const { body, text, headers } = bodyFactory();
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headers ?? new Headers(),
    text: async () => text ?? '',
    json: async () => body,
  } as unknown as Response;
}

/** gtx 响应：rows = data[0] */
function gtx(combined: string | string[]): Response {
  const pieces = Array.isArray(combined) ? combined : [combined];
  return res(200, () => ({
    text: JSON.stringify([pieces.map((p) => [p, 'orig', null, null, 10]), null, 'en', '', 0, 0]),
  }));
}

function rate(): Response {
  return res(429, () => ({ body: {} }));
}

interface Call {
  url: string;
}
function fetchScript(
  script: Array<() => Response | Promise<Response>>,
): { fetchFn: (u: string | URL) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: (u: string | URL, i?: RequestInit) => Promise<Response> = async (u) => {
    calls.push({ url: String(u) });
    return await script[Math.min(calls.length - 1, script.length - 1)]();
  };
  return { fetchFn, calls };
}

const slowOpts = { baseDelayMs: 1 };

describe('GoogleFreeProvider', () => {
  it('批量：拼接分隔符成功还原各段顺序', async () => {
    const { fetchFn, calls } = fetchScript([() => gtx(`你好\n\n${SEP}\n\n世界`)]);
    const p = new GoogleFreeProvider(fetchFn, slowOpts);
    const out = await p.translateBatch([seg('a'), seg('b')], 'auto', 'zh-CN');
    expect(out.map((o) => o.text)).toEqual(['你好', '世界']);
    expect(calls).toHaveLength(1);
  });

  it('批量解析段数不匹配 → 回退逐段，顺序仍对齐', async () => {
    const { fetchFn, calls } = fetchScript([
      () => gtx('你好 世界'), // 分隔符被破坏
      () => gtx('你好'),
      () => gtx('世界'),
    ]);
    const p = new GoogleFreeProvider(fetchFn, slowOpts);
    const out = await p.translateBatch([seg('a'), seg('b')], 'auto', 'zh-CN');
    expect(calls).toHaveLength(3);
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.error === undefined)).toBe(true);
  });

  it('持续 429：整窗错误，不逐段放大（1+3 次调用）', async () => {
    const { fetchFn, calls } = fetchScript([rate]);
    const p = new GoogleFreeProvider(fetchFn, slowOpts);
    const out = await p.translateBatch([seg('a'), seg('b')], 'auto', 'zh-CN');
    expect(calls).toHaveLength(4);
    expect(out.every((o) => o.error?.code === 'E_RATE_LIMITED')).toBe(true);
  });

  it('逐段中某段仍失败 → 该段带错误，其余成功', async () => {
    const { fetchFn, calls } = fetchScript([
      () => gtx('无分隔破坏'),
      () => gtx('第一'),
      () => rate(),
      () => rate(),
      () => rate(),
      () => rate(),
    ]);
    const p = new GoogleFreeProvider(fetchFn, slowOpts);
    const out = await p.translateBatch([seg('a'), seg('b')], 'auto', 'zh-CN');
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(out[0]?.text).toBe('第一');
    expect(out[1]?.error?.code).toBe('E_RATE_LIMITED');
  });

  it('detectLanguage：取 data[2]', async () => {
    const { fetchFn } = fetchScript([() => res(200, () => ({ text: JSON.stringify([[], null, 'fr']) }))]);
    const p = new GoogleFreeProvider(fetchFn, slowOpts);
    expect(await p.detectLanguage('bonjour')).toBe('fr');
  });

  it('T-018 分桶：中英混批按 dominantScript 分桶串行，各段按 id 回排', async () => {
    // 复现 staging 实测：gtx auto 是整批检测——含中文的批次里英文段被原样复制跳过；
    // 纯拉丁批次正常翻译。分桶后英文段独立成批，不再被中文段拖进 auto 误判。
    const calls: Call[] = [];
    const fetchFn = async (u: string | URL): Promise<Response> => {
      const url = String(u);
      calls.push({ url });
      const q = decodeURIComponent(url.split('&q=')[1] ?? '');
      const translated = /[\u4e00-\u9fff]/.test(q) ? q : `${q}·汉化`;
      return gtx(translated);
    };
    const p = new GoogleFreeProvider(fetchFn, slowOpts);
    const out = await p.translateBatch(
      [seg('a', 'Hello world this is plain English'), seg('b', '这是一条中文内容段落'), seg('c', '1234 5678')],
      'auto',
      'zh-CN',
    );
    expect(calls).toHaveLength(3); // cjk / latin / other 各一桶，桶间串行
    expect(out[0]?.text).toBe('Hello world this is plain English·汉化');
    expect(out[1]?.text).toBe('这是一条中文内容段落'); // zh→zh 空转回原文（staging 实测行为）
    expect(out[2]?.text).toBe('1234 5678·汉化');
    expect(out.map((o) => o.id)).toEqual(['a', 'b', 'c']); // 原窗口顺序回排
  });
});
