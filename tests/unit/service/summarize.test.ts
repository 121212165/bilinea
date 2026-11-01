// T-026 SUMMARIZE_TEXT 通道（契约 messaging.md §SUMMARIZE_TEXT + translation-provider.md「附加通道」）
import { describe, expect, it } from 'vitest';
import { summarizeText } from '../../../src/service/summarize';
import type { ExtensionSettings, ProviderConfig } from '../../../src/shared/types';
import type { FetchFn } from '../../../src/service/providers/util';

const cfg = (over: Partial<ProviderConfig> = {}): ProviderConfig =>
  ({
    type: 'openai-compatible',
    enabled: true,
    apiKey: 'sk-test',
    baseUrl: 'https://api.test/v1',
    model: 'm-1',
    ...over,
  }) as ProviderConfig;

const settings = (providers: ProviderConfig[]): ExtensionSettings =>
  ({ providers, targetLang: 'zh-CN' }) as ExtensionSettings;

const jsonFetch = (status: number, body: unknown): FetchFn =>
  (() => Promise.resolve(new Response(JSON.stringify(body), { status }))) as FetchFn;

describe('summarizeText（SUMMARIZE_TEXT 通道）', () => {
  it('成功：取第一个启用的 openai-compatible 行，system 含目标语言、body 透传文本并 trim', async () => {
    const settingsX = settings([
      cfg({ enabled: false }), // 跳过：未启用
      cfg({ model: 'm-2' }),
    ]);
    let seenUrl = '';
    let seenBody = '';
    const fetchFn: FetchFn = ((url: unknown, init?: RequestInit) => {
      seenUrl = String(url);
      seenBody = String(init?.body ?? '');
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: '  概要内容  ' } }] }), { status: 200 }),
      );
    }) as unknown as FetchFn;
    const res = await summarizeText(settingsX, '台词一\n台词二', 'zh-CN', fetchFn);
    expect(res).toEqual({ text: '概要内容' });
    expect(seenUrl.endsWith('/chat/completions')).toBe(true);
    const parsed = JSON.parse(seenBody) as { model: string; messages: Array<{ role: string; content: string }> };
    expect(parsed.model).toBe('m-2');
    expect(parsed.messages[0].role).toBe('system');
    expect(parsed.messages[0].content).toContain('zh-CN');
    expect(parsed.messages[1].content).toBe('台词一\n台词二');
  });

  it('无可用行（缺 apiKey / 全部未启用）→ E_NO_KEY 且不发请求', async () => {
    const noKey = settings([cfg({ apiKey: '' })]);
    const disabled = settings([cfg({ enabled: false })]);
    let calls = 0;
    const fetchFn: FetchFn = (() => {
      calls += 1;
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as FetchFn;
    expect(await summarizeText(noKey, 'x', 'zh-CN', fetchFn)).toEqual({ error: { code: 'E_NO_KEY' } });
    expect(await summarizeText(disabled, 'x', 'zh-CN', fetchFn)).toEqual({ error: { code: 'E_NO_KEY' } });
    expect(calls).toBe(0);
  });

  it('HTTP 500 → E_PROVIDER_DOWN（不裸抛）', async () => {
    const res = await summarizeText(
      settings([cfg()]),
      'x',
      'zh-CN',
      jsonFetch(500, { error: { message: 'boom' } }),
    );
    if (!('error' in res)) throw new Error('expected error result');
    expect(res.error.code).toBe('E_PROVIDER_DOWN');
  });

  it('空回复 → E_PROVIDER_DOWN(empty summary)', async () => {
    const res = await summarizeText(
      settings([cfg()]),
      'x',
      'zh-CN',
      jsonFetch(200, { choices: [{ message: { content: '' } }] }),
    );
    if (!('error' in res)) throw new Error('expected error result');
    expect(res.error.code).toBe('E_PROVIDER_DOWN');
  });
});
