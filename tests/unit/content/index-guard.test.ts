// content 入口幂等防护单测（契约 messaging.md「指令投递可靠性」T-016）：
// 同一 isolated world（测试中 = 同一 jsdom window + 全局 chrome mock）内
// 重复执行 index.ts 不允许二次注册监听（双监听 → toggle 双触发 → 重复译文块）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { ExtensionSettings } from '../../../src/shared/types';

const baseSettings = (): ExtensionSettings => ({
  providers: [],
  targetLang: 'zh-CN',
  autoTranslateSites: [],
  styleMode: 'bilingual',
  theme: 'light',
  hoverEnabled: false,
  selectionEnabled: false,
  pdfEntryEnabled: true,
});

async function runTwiceInSameWindow(): Promise<number> {
  vi.resetModules();
  const dom = new JSDOM('<!doctype html><html><body><p>x</p></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  const addListener = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: {
      onMessage: { addListener },
      // callRpc（GET_SETTINGS）走这里；本地直接给 SETTINGS 形状
      sendMessage: vi.fn(async () => ({ type: 'SETTINGS', settings: baseSettings() })),
    },
  });
  await import('../../../src/content/index');
  await import('../../../src/content/index'); // 模拟补注入竞态下的第二次执行
  await new Promise((r) => setTimeout(r, 10));
  return addListener.mock.calls.length;
}

describe('content 入口幂等（契约 T-016）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('同一 world 二次执行 index.ts：onMessage 监听只注册一次', async () => {
    expect(await runTwiceInSameWindow()).toBe(1);
  });
});
