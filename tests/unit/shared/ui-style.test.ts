// T-024（M3-1 UI 可调）：五旋钮纯函数层单测（shared/ui-style.ts）。
// clamp/默认值是存储层 sanitize 与 options 页收口的共同事实源。
import { describe, expect, it } from 'vitest';
import {
  clampUiField,
  defaultUiStyle,
  pickUiStyle,
  UI_STYLE_LIMITS,
  type UiStyleField,
} from '../../../src/shared/ui-style';
import type { ExtensionSettings } from '../../../src/shared/types';

describe('defaultUiStyle / UI_STYLE_LIMITS', () => {
  it('五字段默认值与 limits 表一一对应', () => {
    const d = defaultUiStyle();
    for (const f of Object.keys(UI_STYLE_LIMITS) as UiStyleField[]) {
      expect(d[f]).toBe(UI_STYLE_LIMITS[f].default);
    }
  });
});

describe('clampUiField', () => {
  it('合法值原样通过（非整数四舍五入）', () => {
    expect(clampUiField('subtitleFontSize', 26)).toBe(26);
    expect(clampUiField('subtitleBottom', 120.4)).toBe(120);
    expect(clampUiField('floatOffset', 30.5)).toBe(31);
  });

  it('NaN/Infinity/非数字 → 默认值', () => {
    for (const f of Object.keys(UI_STYLE_LIMITS) as UiStyleField[]) {
      expect(clampUiField(f, Number.NaN)).toBe(UI_STYLE_LIMITS[f].default);
      expect(clampUiField(f, Number.POSITIVE_INFINITY)).toBe(UI_STYLE_LIMITS[f].default);
      expect(clampUiField(f, '20px' as unknown)).toBe(UI_STYLE_LIMITS[f].default);
    }
  });

  it('越界 → 收到边界', () => {
    expect(clampUiField('subtitleFontSize', 4)).toBe(12);
    expect(clampUiField('subtitleFontSize', 99)).toBe(40);
    expect(clampUiField('subtitleBottom', -5)).toBe(0);
    expect(clampUiField('subtitleBottom', 9999)).toBe(600);
    expect(clampUiField('bubbleFontSize', 3)).toBe(10);
    expect(clampUiField('hoverFontSize', 400)).toBe(28);
    expect(clampUiField('floatOffset', -1)).toBe(0);
    expect(clampUiField('floatOffset', 1000)).toBe(80);
  });
});

describe('pickUiStyle', () => {
  it('null / 空对象 → 全默认（旧 storage 缺字段兼容）', () => {
    expect(pickUiStyle(null)).toEqual(defaultUiStyle());
    expect(pickUiStyle({} as ExtensionSettings)).toEqual(defaultUiStyle());
  });

  it('部分字段 + 越界 → 缺省补默认、越界收编', () => {
    const s = pickUiStyle({
      subtitleFontSize: 99,
      floatOffset: 30,
    } as ExtensionSettings);
    expect(s.subtitleFontSize).toBe(40);
    expect(s.floatOffset).toBe(30);
    expect(s.subtitleBottom).toBe(UI_STYLE_LIMITS.subtitleBottom.default);
    expect(s.bubbleFontSize).toBe(UI_STYLE_LIMITS.bubbleFontSize.default);
    expect(s.hoverFontSize).toBe(UI_STYLE_LIMITS.hoverFontSize.default);
  });
});
