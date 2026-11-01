import { describe, expect, it } from 'vitest';
import {
  sanitizeSettings,
  saveSettings,
  type StorageLike,
} from '../../../src/service/storage'; // 路径: tests/unit -> src/service

describe('sanitizeSettings', () => {
  it('空数据 → 默认值', () => {
    const s = sanitizeSettings(undefined);
    expect(s.targetLang).toBe('zh-CN');
    expect(s.providers.map((p) => p.type)).toEqual(['openai-compatible', 'google-free']);
    expect(s.styleMode).toBe('bilingual');
  });

  it('非法 provider 类型被丢弃、enabled 缺省为 false', () => {
    const s = sanitizeSettings({
      providers: [
        { type: 'not-a-type', enabled: true },
        { type: 'google-free' },
        { type: 'openai-compatible', enabled: true, apiKey: ' k ', baseUrl: ' https://x/v1 ' },
      ],
    });
    expect(s.providers.map((p) => p.type)).toEqual(['google-free', 'openai-compatible']);
    const o = s.providers[1] as { apiKey?: string; baseUrl?: string };
    expect(o.apiKey).toBe('k');
    expect(o.baseUrl).toBe('https://x/v1');
    expect(o.baseUrl?.endsWith('/v1')).toBe(true); // 转义后无尾斜杠
  });

  it('非法目标语言回落 zh-CN；非法站点被剔除', () => {
    const s = sanitizeSettings({
      targetLang: 'zzz!',
      autoTranslateSites: ['a.com', '', 42, 'b.org'],
      styleMode: 'nope',
      theme: 'dark',
    });
    expect(s.targetLang).toBe('zh-CN');
    expect(s.autoTranslateSites).toEqual(['a.com', 'b.org']);
    expect(s.styleMode).toBe('bilingual');
    expect(s.theme).toBe('dark');
    expect(s.hoverEnabled).toBe(true);
  });

  it('booleans 仅在显式 false 时关闭', () => {
    expect(sanitizeSettings({ hoverEnabled: false }).hoverEnabled).toBe(false);
    expect(sanitizeSettings({ selectionEnabled: false }).selectionEnabled).toBe(false);
    expect(sanitizeSettings({}).selectionEnabled).toBe(true);
  });

  it('pdfEntryEnabled（T-028f）：缺省开启，仅显式 false 关闭', () => {
    expect(sanitizeSettings({}).pdfEntryEnabled).toBe(true);
    expect(sanitizeSettings({ pdfEntryEnabled: false }).pdfEntryEnabled).toBe(false);
    expect(sanitizeSettings({ pdfEntryEnabled: true }).pdfEntryEnabled).toBe(true);
  });
});

describe('saveSettings', () => {
  it('增量 patch 合并到现有设置', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const store: StorageLike = {
      async get(key) {
        if (key === 'itr_settings') {
          return calls.at(0) ?? {};
        }
        return {};
      },
      async set(items) {
        calls.push(items);
      },
      async remove() {
        /* no-op for test */
      },
    };
    // 第一次保存：基础设置
    await saveSettings({ targetLang: 'en', autoTranslateSites: ['x.com'] }, store);
    // 第二次：仅改 styleMode
    await saveSettings({ styleMode: 'translation-only' }, store);
    expect(calls).toHaveLength(2);
    const second = calls[1]?.itr_settings as { targetLang: string; autoTranslateSites: string[]; styleMode: string };
    expect(second.targetLang).toBe('en'); // 保留了前一次的值
    expect(second.autoTranslateSites).toEqual(['x.com']);
    expect(second.styleMode).toBe('translation-only');
  });
});

describe('UI 可调字段（T-024 / M3-1）', () => {
  it('未存字段 → 默认值', () => {
    const s = sanitizeSettings({});
    expect(s.subtitleFontSize).toBe(18);
    expect(s.subtitleBottom).toBe(84);
    expect(s.bubbleFontSize).toBe(13);
    expect(s.hoverFontSize).toBe(13);
    expect(s.floatOffset).toBe(12);
  });

  it('非法/越界值 clamp 收口', () => {
    const s = sanitizeSettings({
      subtitleFontSize: 4,
      subtitleBottom: 9999,
      bubbleFontSize: Number.NaN,
      hoverFontSize: '20px',
      floatOffset: -3,
    });
    expect(s.subtitleFontSize).toBe(12);
    expect(s.subtitleBottom).toBe(600);
    expect(s.bubbleFontSize).toBe(13);
    expect(s.hoverFontSize).toBe(13);
    expect(s.floatOffset).toBe(0);
  });

  it('合法值原样保留（四舍五入）；patch 合并不丢已存旋钮', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const store: StorageLike = {
      async get(key) {
        return key === 'itr_settings' ? (calls.at(0) ?? {}) : {};
      },
      async set(items) {
        calls.push(items);
      },
      async remove() {
        /* no-op for test */
      },
    };
    await saveSettings({ subtitleFontSize: 26, subtitleBottom: 120.6, floatOffset: 30 }, store);
    const first = calls[0]?.itr_settings as {
      subtitleFontSize: number;
      subtitleBottom: number;
      floatOffset: number;
    };
    expect(first.subtitleFontSize).toBe(26);
    expect(first.subtitleBottom).toBe(121);
    expect(first.floatOffset).toBe(30);

    await saveSettings({ targetLang: 'en' }, store);
    const second = calls[1]?.itr_settings as Record<string, unknown>;
    expect(second.subtitleFontSize).toBe(26);
    expect(second.subtitleBottom).toBe(121);
    expect(second.floatOffset).toBe(30);
    expect(second.targetLang).toBe('en');
  });
});
