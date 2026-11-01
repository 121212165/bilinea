import { describe, expect, it } from 'vitest';
import { MicrosoftFreeProvider } from '../../../src/service/providers/microsoft-free';
import type { Segment } from '../../../src/shared/types';

function seg(id: string, text = `t-${id}`): Segment {
  return { id, text };
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function scripted(
  script: Array<() => Response | Promise<Response>>,
): { fetchFn: (u: string | URL, i?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: (u: string | URL, i?: RequestInit) => Promise<Response> = async (u, i) => {
    const init = (i ?? {}) as RequestInit;
    calls.push({
      url: String(u),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    return await script[Math.min(calls.length - 1, script.length - 1)]();
  };
  return { fetchFn, calls };
}

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const JWT = `fake.${btoa(JSON.stringify({ exp: 9999999999 })).replace(/\+/g, '-').replace(/\//g, '_')}.sig`;

describe('MicrosoftFreeProvider', () => {
  it('正常批量：翻译结果按 target 语言取值，头带 Bearer', async () => {
    const { fetchFn, calls } = scripted([
      () => Promise.resolve(new Response(JWT, { status: 200 })),
      () =>
        json(200, [
          { detectedLanguage: { language: 'en' }, translations: [{ text: '你', to: 'zh-CN' }] },
          { translations: [{ text: '世界', to: 'zh-CN' }] },
        ]),
    ]);
    const p = new MicrosoftFreeProvider(fetchFn);
    const out = await p.translateBatch([seg('a'), seg('b')], 'auto', 'zh-CN');
    expect(out.map((o) => o.text)).toEqual(['你', '世界']);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.authorization).toBe(`Bearer ${JWT}`);
    expect(calls[1]?.url).toContain('to=zh-CN');
    expect(calls[1]?.body).toEqual([{ Text: 't-a' }, { Text: 't-b' }]);
  });

  it('token 复用：两次 translateBatch 只取一次票据', async () => {
    const { fetchFn, calls } = scripted([
      () => Promise.resolve(new Response(JWT, { status: 200 })),
      () =>
        json(200, [{ translations: [{ text: '一', to: 'zh-CN' }] }, { translations: [{ text: '二', to: 'zh-CN' }] }]),
      () => json(200, [{ translations: [{ text: '三', to: 'zh-CN' }] }]),
    ]);
    const p = new MicrosoftFreeProvider(fetchFn);
    await p.translateBatch([seg('a'), seg('b')], 'auto', 'zh-CN');
    await p.translateBatch([seg('c')], 'auto', 'zh-CN');
    expect(calls.filter((c) => c.url.includes('/translate/auth'))).toHaveLength(1);
  });

  it('持续 429 → E_RATE_LIMITED（不抛异常）', async () => {
    const { fetchFn, calls } = scripted([
      () => Promise.resolve(new Response(JWT, { status: 200 })),
      () => json(429, {}),
    ]);
    const p = new MicrosoftFreeProvider(fetchFn, { baseDelayMs: 1 });
    const out = await p.translateBatch([seg('a')], 'auto', 'zh-CN');
    expect(out[0]?.error?.code).toBe('E_RATE_LIMITED');
    expect(calls).toHaveLength(5); // auth + 4
  });

  it('形状不对 → 段级 E_PROVIDER_DOWN', async () => {
    const { fetchFn } = scripted([
      () => Promise.resolve(new Response(JWT, { status: 200 })),
      () => json(200, [{ translations: [{ text: 'x', to: 'zh-CN' }] }]),
    ]);
    const p = new MicrosoftFreeProvider(fetchFn);
    const out = await p.translateBatch([seg('a'), seg('b')], 'auto', 'zh-CN');
    expect(out.every((o) => o.error?.code === 'E_PROVIDER_DOWN')).toBe(true);
  });

  it('detectLanguage：从 detectedLanguage 读取', async () => {
    const { fetchFn } = scripted([
      () => Promise.resolve(new Response(JWT, { status: 200 })),
      () => json(200, [{ detectedLanguage: { language: 'de' }, translations: [] }]),
    ]);
    const p = new MicrosoftFreeProvider(fetchFn);
    expect(await p.detectLanguage('hallo')).toBe('de');
  });
});
