// M3-1 UI 可调（T-024）：字幕/浮层的五个可调样式旋钮。
// 纯函数 + 常量，无副作用（AGENTS.md shared 层纪律）：sanitize（service）与
// options 页校验共用本文件的默认值与 clamp；content 侧经 pickUiStyle 消费。

import type { ExtensionSettings } from './types';

/** clamp 区间（与 .agent/spec/contracts/messaging.md 核心类型注释一一对应） */
export const UI_STYLE_LIMITS = {
  subtitleFontSize: { min: 12, max: 40, default: 18 },
  subtitleBottom: { min: 0, max: 600, default: 84 },
  bubbleFontSize: { min: 10, max: 28, default: 13 },
  hoverFontSize: { min: 10, max: 28, default: 13 },
  floatOffset: { min: 0, max: 80, default: 12 },
} as const;

export type UiStyleField = keyof typeof UI_STYLE_LIMITS;

/** content 侧消费形态：字段齐全（sanitize 后必有值；未经过 sanitize 的 settings 由 defaults 兜底） */
export interface UiStyle {
  subtitleFontSize: number;
  subtitleBottom: number;
  bubbleFontSize: number;
  hoverFontSize: number;
  floatOffset: number;
}

export function defaultUiStyle(): UiStyle {
  return {
    subtitleFontSize: UI_STYLE_LIMITS.subtitleFontSize.default,
    subtitleBottom: UI_STYLE_LIMITS.subtitleBottom.default,
    bubbleFontSize: UI_STYLE_LIMITS.bubbleFontSize.default,
    hoverFontSize: UI_STYLE_LIMITS.hoverFontSize.default,
    floatOffset: UI_STYLE_LIMITS.floatOffset.default,
  };
}

function clampField(field: UiStyleField, raw: unknown): number {
  const { min, max, default: fallback } = UI_STYLE_LIMITS[field];
  const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** 单字段合法性 → 收口值（sanitize 与 options 页共用） */
export function clampUiField(field: UiStyleField, raw: unknown): number {
  return clampField(field, raw);
}

/** settings（可能未 sanitize / 旧数据缺字段）→ 五字段齐全的 UiStyle */
export function pickUiStyle(settings: ExtensionSettings | null | undefined): UiStyle {
  return {
    subtitleFontSize: clampField('subtitleFontSize', settings?.subtitleFontSize),
    subtitleBottom: clampField('subtitleBottom', settings?.subtitleBottom),
    bubbleFontSize: clampField('bubbleFontSize', settings?.bubbleFontSize),
    hoverFontSize: clampField('hoverFontSize', settings?.hoverFontSize),
    floatOffset: clampField('floatOffset', settings?.floatOffset),
  };
}
