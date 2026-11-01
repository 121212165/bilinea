// 悬停 Alt 单段翻译（T-010）：严格对照 contracts/hover.md v1。
// 用户拍板交互：按住 Alt 悬停段落即翻（�数防抖）+ 浮动译文卡（pointer-events:none，不拦选区）。
// 强不变量：原文 DOM 只读；TRANSLATE_BATCH 经 SW；itr-hover- 前缀；单在途 token++；
// enable 幂等，disable 全摘监听。
import { logger } from '../shared/logger';
import { callRpc, type RpcRequest, type RpcResponse } from '../shared/messaging';
import { UI_STYLE_LIMITS, type UiStyle } from '../shared/ui-style';
import { errorTipText } from './tipbar';

const CARD_CLASS = 'itr-hover-card';
const SRC_CLASS = 'itr-hover-src';
const DST_CLASS = 'itr-hover-dst';
const LOADING_TEXT = '翻译中…';
const MIN_TEXT = 1;
const MAX_TEXT = 5000;
const SRC_TRUNCATE = 120;
/** 锚点偏移兜底 = 共享旋钮默认（T-024：settings.floatOffset 可调，applyUiStyle 注入后覆盖） */
const RECT_PAD_PX = UI_STYLE_LIMITS.floatOffset.default;
const VIEWPORT_PAD_PX = 8;
/** 语义段落选择器：最内层命中（含 X 推文 fallback 的前置候选） */
const PICK_SEL =
  'p,li,td,th,blockquote,dd,dt,h1,h2,h3,h4,h5,h6,figcaption';
/** 自己的浮层（tipbar/划词/悬停卡）不作为翻译目标 */
const OWN_SEL = '.itr-tip,.itr-sel-chip,.itr-sel-bubble,.itr-hover-card';

/** 元素鸭子类型（node 测试环境无 Element 全局，类型层即可，避免 instanceof） */
interface DuckEl {
  closest: (sel: string) => DuckEl | null;
  innerText?: string;
  textContent?: string | null;
  getBoundingClientRect?: () => DOMRect;
}

export interface HoverDeps {
  doc: Document;
  /** 网络出口注入（生产 = callRpc；测试用 fake） */
  request?: (msg: RpcRequest) => Promise<RpcResponse>;
  getTargetLang: () => string;
  /** 防抖毫秒（测试可注入 0） */
  debounceMs?: number;
}

export class HoverCard {
  private readonly doc: Document;
  private readonly request: (msg: RpcRequest) => Promise<RpcResponse>;
  private readonly getTargetLang: () => string;
  private readonly debounceMs: number;

  private enabled = false;
  private altHeld = false;
  private cleanups: Array<() => void> = [];

  private card: HTMLElement | null = null;
  private srcRow: HTMLElement | null = null;
  private dstRow: HTMLElement | null = null;

  /** 单在途令牌（同 selection：dismiss/新目标自增，陈旧响应丢弃） */
  private token = 0;
  /** 防抖计时器 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 当前防抖中的段落文本（同目标合并用） */
  private candidate: string | null = null;
  /** 最近一次成功定位（请求响应仍打到这里） */
  private posX = 100;
  private posY = 100;
  /** T-024 UI 可调：卡字号/锚点偏移（controller.applySettings 注入；null = 默认兜底） */
  private uiStyle: UiStyle | null = null;

  constructor(deps: HoverDeps) {
    this.doc = deps.doc;
    this.request = deps.request ?? callRpc;
    this.getTargetLang = deps.getTargetLang;
    this.debounceMs = deps.debounceMs ?? 300;
  }

  get active(): boolean {
    return this.enabled;
  }

  get isAltHeld(): boolean {
    return this.altHeld;
  }

  /** T-024（M3-1 UI 可调）：卡字号注入；浮卡已挂载时字号即时生效并重新内收。
   * 偏移量对下一次 rectAnchorX/Y 计算生效（悬停卡锚点在 mousemove 时重算）。 */
  applyUiStyle(style: UiStyle): void {
    this.uiStyle = style;
    if (this.card) {
      this.card.style.setProperty('--itr-hover-font-size', `${style.hoverFontSize}px`);
      this.place(this.card);
    }
  }

  /** enable 幂等（契约 §0.4） */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    const doc = this.doc;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        this.hideAll();
        return;
      }
      // 纯 Alt 按下（Ctrl/Shift/Meta 组合器不驻留，避免与整页 Alt+Shift+T 语义混淆）
      if (e.key === 'Alt' && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        this.altHeld = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.key === 'Alt' && this.altHeld) {
        this.altHeld = false;
        this.hideAll();
      }
    };
    const onBlur = (): void => {
      if (this.altHeld) {
        this.altHeld = false;
        this.hideAll();
      }
    };
    const onMouseMove = (e: MouseEvent): void => this.onMouseMove(e);
    const onScroll = (): void => {
      // 段落 rect 已错位 → 收敛（契约 §1；token++ 使在途渲染作废）
      this.hideAll();
    };
    doc.addEventListener('keydown', onKeyDown, true);
    doc.addEventListener('keyup', onKeyUp, true);
    doc.addEventListener('mousemove', onMouseMove, true);
    doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
    doc.defaultView?.addEventListener('blur', onBlur);
    this.cleanups = [
      () => doc.removeEventListener('keydown', onKeyDown, true),
      () => doc.removeEventListener('keyup', onKeyUp, true),
      () => doc.removeEventListener('mousemove', onMouseMove, true),
      () => doc.removeEventListener('scroll', onScroll, { capture: true }),
      () => doc.defaultView?.removeEventListener('blur', onBlur),
    ];
  }

  /** disable：浮层清空 + 监听全摘 + 防抖/在途作废（契约 §0.4） */
  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.altHeld = false;
    this.clearTimer();
    this.hideAll();
    for (const c of this.cleanups) c();
    this.cleanups = [];
  }

  /** 页面级 STOP / ESC / Alt 松开 / 滚动：只清 UI 与在途，监听仍由开关管理 */
  hideAll(): void {
    this.token += 1; // 任何 dismissal 场景迟到响应不再渲染
    this.clearTimer();
    this.candidate = null;
    this.card?.remove();
    this.card = null;
    this.srcRow = null;
    this.dstRow = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  // ---------- 触发（契约 §1） ----------

  private onMouseMove(e: MouseEvent): void {
    if (!this.altHeld) return;
    const picked = this.pickParagraph(e.target);
    // 无目标：保持现状（不闪卡；卡片若在也不撤——用户可能只是在段落间过渡）
    if (!picked) return;
    if (picked.text === this.candidate) return; // 同目标合并（防抖重触发跳过）
    // 换目标：作废旧防抖与在途
    this.clearTimer();
    this.token += 1;
    this.card?.remove();
    this.card = null;
    this.srcRow = null;
    this.dstRow = null;
    this.candidate = picked.text;
    this.posX = this.rectAnchorX(picked.el);
    this.posY = this.rectAnchorY(picked.el);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.enabled || !this.altHeld || !this.candidate) return;
      void this.translate(this.candidate);
    }, this.debounceMs);
  }

  /** 选段（契约 §2）：最内层语义段落；未命中用 target 自身（X 推文 span 等叶子容器） */
  private pickParagraph(node: EventTarget | null): { text: string; el: DuckEl } | null {
    const cand = node as Partial<DuckEl> | null;
    if (!cand || typeof cand.closest !== 'function') return null;
    const from = cand as unknown as DuckEl;
    if (from.closest(OWN_SEL)) return null; // 自家浮层不翻译
    if (from.closest('input,textarea,[contenteditable],code,pre,kbd,samp,script,style')) {
      return null;
    }
    const el = from.closest(PICK_SEL) ?? from;
    const text = (el.innerText ?? el.textContent ?? '').trim();
    if (text.length < MIN_TEXT || text.length > MAX_TEXT) return null;
    return { text, el };
  }

  /** 浮卡锚点（契约 §3）：段落 rect 旁 + 偏移（settings.floatOffset 可调）；兜底 (100,100)；viewport 内收在 place() */
  private rectAnchorX(el: DuckEl): number {
    const rect = el.getBoundingClientRect?.();
    return rect ? rect.right + (this.uiStyle?.floatOffset ?? RECT_PAD_PX) : 100;
  }

  private rectAnchorY(el: DuckEl): number {
    const rect = el.getBoundingClientRect?.();
    return rect ? rect.top + (this.uiStyle?.floatOffset ?? RECT_PAD_PX) : 100;
  }

  // ---------- 翻译与渲染（契约 §3） ----------

  private async translate(text: string): Promise<void> {
    const myToken = ++this.token;
    this.showCard(text, LOADING_TEXT);
    const target = this.getTargetLang();
    try {
      const res = await this.request({
        type: 'TRANSLATE_BATCH',
        segments: [{ id: 'hover-1', text }],
        source: 'auto',
        target,
        requestId: `hover-req-${myToken}`,
      });
      if (myToken !== this.token) return; // 陈旧响应忽略（换目标/收起过的请求）
      if (!this.enabled) return;
      const item = res?.type === 'TRANSLATION' ? res.items[0] : undefined;
      if (item && item.text) {
        this.showCard(text, item.text);
      } else {
        const code = res?.type === 'TRANSLATION' && res.error ? res.error.code : 'E_PROVIDER_DOWN';
        this.showCard(text, errorTipText(code));
      }
    } catch (e) {
      if (myToken !== this.token) return;
      logger.warn('hover translate failed', e);
      this.showCard(text, errorTipText('E_PROVIDER_DOWN'));
    }
  }

  private showCard(srcText: string, dstText: string): void {
    let card = this.card;
    let srcRow = this.srcRow;
    let dstRow = this.dstRow;
    if (!card || !srcRow || !dstRow) {
      card = this.doc.createElement('div');
      card.className = CARD_CLASS;
      if (this.uiStyle) {
        card.style.setProperty('--itr-hover-font-size', `${this.uiStyle.hoverFontSize}px`);
      }
      srcRow = this.doc.createElement('div');
      srcRow.className = SRC_CLASS;
      dstRow = this.doc.createElement('div');
      dstRow.className = DST_CLASS;
      card.append(srcRow, dstRow);
      this.doc.body?.append(card);
      this.card = card;
      this.srcRow = srcRow;
      this.dstRow = dstRow;
    }
    const src = srcText.length > SRC_TRUNCATE ? `${srcText.slice(0, SRC_TRUNCATE)}…` : srcText;
    srcRow.textContent = src;
    dstRow.textContent = dstText;
    dstRow.style.whiteSpace = 'pre-wrap';
    this.place(card);
  }

  /** viewport 内收 */
  private place(el: HTMLElement): void {
    const win = this.doc.defaultView;
    const wpx = win?.innerWidth ?? 1280;
    const hpx = win?.innerHeight ?? 800;
    const rect = el.getBoundingClientRect();
    let px = this.posX;
    let py = this.posY;
    if (px + rect.width > wpx - VIEWPORT_PAD_PX) {
      px = Math.max(VIEWPORT_PAD_PX, wpx - rect.width - VIEWPORT_PAD_PX);
    }
    if (py + rect.height > hpx - VIEWPORT_PAD_PX) {
      py = Math.max(VIEWPORT_PAD_PX, hpx - rect.height - VIEWPORT_PAD_PX);
    }
    el.style.left = `${Math.round(px)}px`;
    el.style.top = `${Math.round(py)}px`;
  }
}
