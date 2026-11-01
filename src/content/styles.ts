// 样式注入：所有类名带 itr- 前缀（契约 ADR：样式隔离命名空间）。
// 主题通过容器 data-itr-theme 属性切换｜auto 用 prefers-color-scheme 媒体查询。

export const ITR_CSS = `
.itr-translation {
  --itr-fg: #1f2328;
  --itr-bg: rgba(127, 127, 127, 0.07);
  font: inherit;
  line-height: inherit;
  letter-spacing: inherit;
  color: var(--itr-fg);
  background: var(--itr-bg);
  border-left: 3px solid rgba(74, 108, 247, 0.55);
  margin: 3px 0;
  padding: 1px 8px;
  border-radius: 0 5px 5px 0;
  white-space: pre-wrap;
}
.itr-translation[data-itr-theme='dark'] {
  --itr-fg: #e6e6e6;
  --itr-bg: rgba(0, 0, 0, 0.28);
  border-left-color: rgba(122, 143, 255, 0.6);
}
@media (prefers-color-scheme: dark) {
  .itr-translation[data-itr-theme='auto'] {
    --itr-fg: #e6e6e6;
    --itr-bg: rgba(0, 0, 0, 0.28);
    border-left-color: rgba(122, 143, 255, 0.6);
  }
}
.itr-original-hidden {
  display: none !important;
}
.itr-error {
  font-style: italic;
  opacity: 0.75;
  cursor: help;
}
.itr-tip {
  --tip-fg: #22252b;
  --tip-bg: rgba(255, 255, 255, 0.94);
  position: fixed;
  bottom: 16px;
  right: 16px;
  z-index: 2147483647;
  max-width: min(420px, 86vw);
  padding: 10px 14px;
  border-radius: 10px;
  box-shadow:
    0 6px 24px rgba(0, 0, 0, 0.16),
    0 1px 3px rgba(0, 0, 0, 0.1);
  backdrop-filter: blur(10px);
  font: 12.5px/1.5 system-ui, sans-serif;
  color: var(--tip-fg);
  background: var(--tip-bg);
  border: 1px solid rgba(127, 127, 127, 0.16);
}
.itr-tip[data-itr-theme='dark'] {
  --tip-fg: #e6e6e6;
  --tip-bg: rgba(30, 32, 37, 0.94);
}
@media (prefers-color-scheme: dark) {
  .itr-tip[data-itr-theme='auto'] {
    --tip-fg: #e6e6e6;
    --tip-bg: rgba(30, 32, 37, 0.94);
  }
}
.itr-tip-close {
  cursor: pointer;
  margin-left: 10px;
  opacity: 0.55;
  transition: opacity 0.15s;
}
.itr-tip-close:hover {
  opacity: 1;
}
.itr-caption-line {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: var(--itr-caption-bottom, 84px);
  max-width: 88%;
  padding: 5px 12px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.66);
  color: #fff;
  /* T-024：字号/离底由设置经 --itr-caption-* 变量注入（applyUiStyle），余量保持固定 */
  font-family: Roboto, 'YouTube Noto', system-ui, sans-serif;
  font-weight: 500;
  font-size: var(--itr-caption-font-size, 18px);
  line-height: 1.45;
  letter-spacing: 0.3px;
  text-align: center;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
  white-space: pre-wrap;
  z-index: 60;
  pointer-events: none;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
}
.itr-caption-line[data-itr-hidden='true'] {
  display: none;
}
/* T-025（M3-2 仅双语）：双语条根内双行——src 原文行 + dst 译文行，整体配对 */
.itr-caption-src {
  display: block;
  font-size: 0.92em;
  color: rgba(255, 255, 255, 0.86);
  white-space: pre-wrap;
}
.itr-caption-dst {
  display: block;
  margin-top: 2px;
  white-space: pre-wrap;
}
/* T-027 关键帧热区按钮：overlay 根 pointer-events:none 的唯一 auto 例外（契约 subtitles.md「三入口」） */
.itr-caption-line .itr-caption-shot {
  position: absolute;
  top: 4px;
  right: 6px;
  padding: 2px 9px;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font: inherit;
  font-size: 11px;
  line-height: 1.5;
  cursor: pointer;
  pointer-events: auto;
  opacity: 0.8;
  transition: opacity 0.15s, background 0.15s;
}
.itr-caption-line .itr-caption-shot:hover {
  opacity: 1;
  background: rgba(0, 0, 0, 0.78);
}
.itr-caption-line .itr-caption-shot.itr-caption-shot-ok {
  border-color: rgba(130, 235, 130, 0.85);
}
/* 原字幕视觉退场：只对原生容器加 visibility（保布局/保观察器事件），退场幂等可撤 */
.itr-caption-native-hidden {
  visibility: hidden !important;
}
.itr-sel-chip {
  position: fixed;
  z-index: 2147483646;
  padding: 4px 12px;
  border: 1px solid rgba(127, 127, 127, 0.2);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.95);
  color: #22252b;
  font: 12.5px/1.5 system-ui, sans-serif;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.14);
}
.itr-sel-chip:hover {
  background: rgba(74, 108, 247, 0.92);
  color: #fff;
}
.itr-sel-bubble {
  position: fixed;
  z-index: 2147483646;
  max-width: min(360px, 84vw);
  max-height: min(320px, 60vh);
  overflow: auto;
  padding: 8px 12px;
  border: 1px solid rgba(127, 127, 127, 0.18);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.96);
  color: #1f2328;
  /* T-024：译文字号可调（applyUiStyle 注入变量） */
  font-family: system-ui, sans-serif;
  font-size: var(--itr-sel-bubble-font-size, 13px);
  line-height: 1.6;
  box-shadow:
    0 6px 24px rgba(0, 0, 0, 0.16),
    0 1px 3px rgba(0, 0, 0, 0.1);
}
.itr-sel-bubble[data-itr-sel-error='1'] {
  font-style: italic;
  opacity: 0.8;
}
/* T-010 悬停单段翻译浮卡：pointer-events:none 不拦选区/页面交互 */
.itr-hover-card {
  position: fixed;
  z-index: 2147483646;
  max-width: min(420px, 88vw);
  max-height: min(300px, 56vh);
  overflow: auto;
  padding: 6px 10px;
  border: 1px solid rgba(127, 127, 127, 0.18);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.96);
  color: #1f2328;
  /* T-024：卡字号可调（applyUiStyle 注入变量）；src 行用 em 相对缩放 */
  font-family: system-ui, sans-serif;
  font-size: var(--itr-hover-font-size, 13px);
  line-height: 1.6;
  box-shadow:
    0 6px 24px rgba(0, 0, 0, 0.16),
    0 1px 3px rgba(0, 0, 0, 0.1);
  pointer-events: none;
}
.itr-hover-src {
  color: #6a6f78;
  font-size: 0.885em; /* ≈13px 基准下 11.5px，随卡字号等比缩放（T-024） */
  line-height: 1.45;
  margin-bottom: 2px;
}
.itr-hover-dst {
  white-space: pre-wrap;
}
`;

/** 幂等注入；同一 head 只插入一次，主题/模式以属性滚动更新 */
export function ensureStyleInjected(
  doc: Document,
  theme: string,
  mode: string,
): HTMLStyleElement {
  let styleEl = doc.head?.querySelector<HTMLStyleElement>('style[data-itr-style]');
  if (!styleEl) {
    styleEl = doc.createElement('style');
    styleEl.setAttribute('data-itr-style', '1');
    styleEl.textContent = ITR_CSS;
    doc.head?.append(styleEl);
  }
  styleEl.setAttribute('data-itr-theme', theme);
  styleEl.setAttribute('data-itr-mode', mode);
  return styleEl;
}

export function removeStyle(doc: Document): void {
  doc.head?.querySelector('style[data-itr-style]')?.remove();
}
