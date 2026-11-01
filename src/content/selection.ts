// 划词翻译气泡（T-009）：严格对照 contracts/selection.md v1。
// 强不变量：原文 DOM 只读；翻译请求 TRANSLATE_BATCH 经 SW（content 不持 Key）；
// 样式 itr-sel- 前缀；单在途、陈旧响应忽略；enable 幂等，disable/stop 全摘监听。
import { logger } from '../shared/logger';
import { callRpc, type RpcRequest, type RpcResponse } from '../shared/messaging';
import { UI_STYLE_LIMITS, type UiStyle } from '../shared/ui-style';
import { errorTipText } from './tipbar';

const CHIP_CLASS = 'itr-sel-chip';
const BUBBLE_CLASS = 'itr-sel-bubble';
const CHIP_TEXT = '翻译';
const LOADING_TEXT = '翻译中…';
const MIN_TEXT = 1;
const MAX_TEXT = 5000;
/** chip / bubble 相对鼠标的偏移兜底 = 共享旋钮默认（T-024 可调）+ 边缘安全距（契约 §3） */
const OFFSET_PX = UI_STYLE_LIMITS.floatOffset.default;
const VIEWPORT_PAD_PX = 8;

export interface SelectionDeps {
  doc: Document;
  /** 网络出口注入（生产 = callRpc；测试用 fake） */
  request?: (msg: RpcRequest) => Promise<RpcResponse>;
  getTargetLang: () => string;
}

export class SelectionBubble {
  private readonly doc: Document;
  private readonly request: (msg: RpcRequest) => Promise<RpcResponse>;
  private readonly getTargetLang: () => string;

  private enabled = false;
  private cleanups: Array<() => void> = [];

  private chip: HTMLElement | null = null;
  private bubble: HTMLElement | null = null;
  private chipX = 0;
  private chipY = 0;
  /** bubble 最近一次挂载锚点：applyUiStyle 实时生效时重排用（T-024） */
  private bubbleX = 0;
  private bubbleY = 0;
  /** T-024 UI 可调：字号/偏移（controller.applySettings 注入；null = CSS/常量默认） */
  private uiStyle: UiStyle | null = null;
  /** chip 挂载时的选区快照（浏览器在 chip mousedown 清选区时的兜底，T-009a） */
  private chipText: string | null = null;

  /** 单在途令牌：新请求自增，旧请求响应与它不等号即忽略（契约 §2.3） */
  private token = 0;

  constructor(deps: SelectionDeps) {
    this.doc = deps.doc;
    this.request = deps.request ?? callRpc;
    this.getTargetLang = deps.getTargetLang;
  }

  get active(): boolean {
    return this.enabled;
  }

  /** T-024（M3-1 UI 可调）：气泡字号与锚点偏移注入；chip/bubble 已挂载时即时生效 */
  applyUiStyle(style: UiStyle): void {
    this.uiStyle = style;
    if (this.bubble) {
      this.applyFontSize(this.bubble, style.bubbleFontSize);
      this.place(this.bubble, this.bubbleX, this.bubbleY);
    }
    if (this.chip) this.place(this.chip, this.chipX, this.chipY);
  }

  private applyFontSize(el: HTMLElement, px: number): void {
    el.style.setProperty('--itr-sel-bubble-font-size', `${px}px`);
  }

  /** 当前生效的锚点偏移（T-024 可调，未注入 = 默认 12） */
  private offsetPx(): number {
    return this.uiStyle?.floatOffset ?? OFFSET_PX;
  }

  /** enable 幂等：重复调用不重复挂监听（契约 §0.4） */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    const doc = this.doc;
    const onMouseDown = (e: Event): void => this.onMouseDown(e);
    const onMouseUp = (e: MouseEvent): void => this.onMouseUp(e);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        this.hideAll();
        return;
      }
      // Alt+X：有选区直接翻译，跳过 chip（契约 §1 热键路径）；keydown 无鼠标坐标，
      // 气泡定位走选区矩形（translate 内 fallback）
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.key === 'x' || e.key === 'X')) {
        const text = this.readSelection();
        if (text) {
          e.preventDefault();
          e.stopPropagation();
          this.translate(text);
        }
      }
    };
    doc.addEventListener('mousedown', onMouseDown, true);
    doc.addEventListener('mouseup', onMouseUp, true);
    // capture 级 keydown（X 等 SPA 的 React 键盘管理会 stopPropagation 拦 window 冒泡——
    // T-023 真机回归实锤：受信 ESC 到达 window 冒泡监听前被中间层吃掉，chip/bubble 不收；
    // hover.ts 同场景已用 capture，selection 对齐）
    doc.defaultView?.addEventListener('keydown', onKey, true);
    this.cleanups = [
      () => doc.removeEventListener('mousedown', onMouseDown, true),
      () => doc.removeEventListener('mouseup', onMouseUp, true),
      () => doc.defaultView?.removeEventListener('keydown', onKey, true),
    ];
  }

  /** disable：UI 清空 + listener 全摘 + 在途作废（契约 §0.4） */
  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    this.token += 1; // 在途响应作废
    this.hideAll();
    for (const c of this.cleanups) c();
    this.cleanups = [];
  }

  /** 页面级 STOP：只清 UI 与在途，保持监听（开关仍由 settings 驱动）。
   * token 自增 = 任何 dismiss 场景下迟到响应不再渲染（用户已挥手）。 */
  hideAll(): void {
    this.token += 1;
    this.chipText = null;
    this.chip?.remove();
    this.bubble?.remove();
    this.chip = null;
    this.bubble = null;
  }

  // ---------- 触发 ----------

  private onMouseDown(e: Event): void {
    const t = e.target as Node | null;
    if (this.chip?.contains(t) || this.bubble?.contains(t)) {
      // 真浏览器：mousedown 默认清空文本选区 → click 时 readSelection() 已拿不到原文
      //（T-009a 真机 bug）。preventDefault 保住选区，还支持连点重试。
      e.preventDefault();
      return;
    }
    this.hideAll(); // document mousedown 在 chip/bubble 外 → 消失（契约 §1）
  }

  private onMouseUp(e: MouseEvent): void {
    // 选区折叠（点击/拖空）→ chip 消失（契约 §1）
    const text = this.readSelection();
    if (!text) {
      if (this.chip) this.hideAll();
      return;
    }
    // mousedown 在 chip 上点按后松开也会触发 mouseup；chip 内与 bubble 内的松开不算「新划词」
    const t = e.target as Node | null;
    if (this.chip?.contains(t) || this.bubble?.contains(t)) return;
    this.chipText = text; // 快照：chip 挂载瞬间选区必然有效
    this.showChip(e.clientX, e.clientY);
  }

  private showChip(x: number, y: number): void {
    if (!this.chip) {
      const btn = this.doc.createElement('button') as HTMLButtonElement;
      btn.className = CHIP_CLASS;
      btn.type = 'button';
      btn.addEventListener('click', () => {
        // 选区可能与快照不同步（浏览器已在 chip mousedown 清过）→ 快照优先
        const live = this.readSelection();
        const text = live ?? this.chipText;
        if (text) this.translate(text, this.chipX, this.chipY);
      });
      this.doc.body?.append(btn);
      this.chip = btn;
    }
    this.chipX = x;
    this.chipY = y;
    this.chip.textContent = CHIP_TEXT;
    this.place(this.chip, x, y);
  }

  /** 选区提取（契约 §1 边界）：editable 内零容忍；长度 1..5000 */
  private readSelection(): string | null {
    const sel = this.doc.getSelection?.();
    if (!sel || sel.isCollapsed) return null;
    const anchor = sel.anchorNode ?? null;
    if (anchor && this.isEditable(anchor)) return null;
    const text = sel.toString().trim();
    if (text.length < MIN_TEXT || text.length > MAX_TEXT) return null;
    return text;
  }

  private isEditable(node: Node): boolean {
    // 不用 `instanceof Element`（node 单测环境无该全局）；以 nodeType 驱动 closest 探测
    const target =
      node.nodeType === this.doc.ELEMENT_NODE
        ? (node as unknown as { closest?: (sel: string) => unknown })
        : (node.parentElement as unknown as { closest?: (sel: string) => unknown } | null);
    return !!target?.closest?.('input, textarea, [contenteditable], [contenteditable="true"]');
  }

  // ---------- 翻译与渲染 ----------

  private async translate(text: string, x?: number, y?: number): Promise<void> {
    // 无鼠标坐标（Alt+X 热键路径）→ 以选区矩形右下角附近定位（契约 §3 兜底）
    let bx = x;
    let by = y;
    if (bx === undefined || by === undefined) {
      const sel = this.doc.getSelection?.();
      // jsdom 的 Range 无 getBoundingClientRect（真浏览器有）→ 可选调用 + 兜底
      const rect =
        sel && sel.rangeCount > 0
          ? (sel.getRangeAt(0).getBoundingClientRect as (() => DOMRect) | undefined)?.()
          : null;
      bx = bx ?? (rect ? rect.right : 100);
      by = by ?? (rect ? rect.bottom : 100);
    }
    const myToken = ++this.token;
    this.showBubble(bx, by, LOADING_TEXT, false);
    const target = this.getTargetLang();
    try {
      const res = await this.request({
        type: 'TRANSLATE_BATCH',
        segments: [{ id: 'sel-1', text }],
        source: 'auto',
        target,
        requestId: `sel-req-${myToken}`,
      });
      if (myToken !== this.token) return; // 陈旧响应忽略（契约 §2.3）
      if (!this.enabled) return;
      const item = res?.type === 'TRANSLATION' ? res.items[0] : undefined;
      if (item && item.text) {
        this.showBubble(bx, by, item.text, false);
      } else {
        const code = res?.type === 'TRANSLATION' && res.error ? res.error.code : 'E_PROVIDER_DOWN';
        this.showBubble(bx, by, errorTipText(code), true);
      }
    } catch (e) {
      if (myToken !== this.token) return;
      logger.warn('selection translate failed', e);
      this.showBubble(bx, by, errorTipText('E_PROVIDER_DOWN'), true);
    }
  }

  private showBubble(x: number, y: number, text: string, isError: boolean): void {
    if (!this.bubble) {
      this.bubble = this.doc.createElement('div');
      this.bubble.className = BUBBLE_CLASS;
      this.doc.body?.append(this.bubble);
      if (this.uiStyle) this.applyFontSize(this.bubble, this.uiStyle.bubbleFontSize);
    }
    this.bubbleX = x;
    this.bubbleY = y;
    if (isError) this.bubble.setAttribute('data-itr-sel-error', '1');
    else this.bubble.removeAttribute('data-itr-sel-error');
    this.bubble.textContent = text; // textContent 纯文本，防注入（契约 §3）
    this.bubble.style.whiteSpace = 'pre-wrap';
    this.place(this.bubble, x, y);
  }

  /** viewport 压缩定位（契约 §3）：靠右/底时内收；偏移量 = settings.floatOffset（T-024 可调） */
  private place(el: HTMLElement, x: number, y: number): void {
    const win = this.doc.defaultView;
    const wpx = win?.innerWidth ?? 1280;
    const hpx = win?.innerHeight ?? 800;
    const offset = this.offsetPx();
    const rect = el.getBoundingClientRect();
    let px = x + offset;
    let py = y + offset;
    if (px + rect.width > wpx - VIEWPORT_PAD_PX) {
      px = Math.max(VIEWPORT_PAD_PX, x - rect.width - offset);
    }
    if (py + rect.height > hpx - VIEWPORT_PAD_PX) {
      py = Math.max(VIEWPORT_PAD_PX, y - rect.height - offset);
    }
    el.style.left = `${Math.round(px)}px`;
    el.style.top = `${Math.round(py)}px`;
  }
}
