// 双语渲染器（T-007）：契约 .agent/spec/contracts/segmentation.md「渲染规则」
// 红线：原文节点一律不动；翻译可完全撤销（clearAll 后 DOM 逐字节还原）。
import { logger } from '../shared/logger';
import type { StyleMode, Theme } from '../shared/types';
import type { SegBlock } from './extractor';
import { ensureStyleInjected, removeStyle } from './styles';

const PLACEHOLDER_RE = /\[\[(\d+)\]\]/g;
export const CONTAINER_CLASS = 'itr-translation';
export const HIDDEN_CLASS = 'itr-original-hidden';

/** 布局安全上移层数上限（契约 segmentation.md「布局安全插入锚点」T-017） */
const MAX_CLIMB = 4;

/**
 * 布局安全插入锚点：inline / 横向 flex / grid 父容器里直接 afterend 会挤坏布局；
 * 此时锚点上移到该父容器（译文出现在整行之后），最多 4 层，到 body 停。
 * 只改「插在哪」，绝不改任何原文内容。
 */
export function safeAnchor(el: Element): Element {
  let anchor: Element = el;
  for (let hops = 0; hops < MAX_CLIMB; hops += 1) {
    const parent: Element | null = anchor.parentElement;
    if (!parent || parent === el.ownerDocument.body) break;
    const view = parent.ownerDocument.defaultView;
    if (!view) break;
    const cs = view.getComputedStyle(parent);
    if (!cs) break;
    const display = cs.display;
    if (display.startsWith('inline')) {
      anchor = parent; // inline 上下文：允许上移
      continue;
    }
    if (display === 'flex') {
      const dir = cs.flexDirection;
      if (dir === 'column' || dir === 'column-reverse') break; // 纵向 flex：追加一行安全
      anchor = parent; // 横向 flex：上移出整行
      continue;
    }
    if (display === 'grid' || display === 'inline-grid') {
      anchor = parent; // grid：上移出整格
      continue;
    }
    break;
  }
  return anchor;
}

export class PageRenderer {
  private blocks = new Map<string, SegBlock>();
  private containers = new Map<string, HTMLElement>();
  /** 我们添加过 hidden 类的原文元素（值 = 添加前的 class 属性；null 表示原本没有） */
  private originalHidden = new Map<Element, string | null>();
  /** clamp 释放三连动过的元素（值 = 添加前的 style 属性；null 表示原本没有）
   *  （契约 segmentation.md「clamp 释放三连」T-020b；clearAll 还原保证可撤销） */
  private originalStyle = new Map<Element, string | null>();

  constructor(
    private readonly doc: Document,
    private styleMode: StyleMode = 'bilingual',
    private theme: Theme = 'auto',
  ) {}

  /** 请求开始：登记本轮 blocks + 注入样式 + 按 translation-only 预隐藏 */
  begin(blocks: SegBlock[]): void {
    ensureStyleInjected(this.doc, this.theme, this.styleMode);
    for (const block of blocks) {
      this.blocks.set(block.id, block);
      if (this.styleMode === 'translation-only') this.hideOriginal(block.el);
    }
  }

  /** 原文 el 是否已有本插入的译文容器（SPA / 重复触发的幂等判断入口） */
  isTranslated(el: Element): boolean {
    // 契约 segmentation.md「布局安全插入锚点」T-017：与插入用同一锚点算法
    const next = safeAnchor(el).nextElementSibling;
    return next?.classList.contains(CONTAINER_CLASS) ?? false;
  }

  /** 取/建译文容器：插在布局安全锚点 afterend；长文本子段多次追加进同一容器 */
  private ensureContainer(block: SegBlock): HTMLElement {
    const existing = this.containers.get(block.id);
    if (existing) return existing;
    const anchor = safeAnchor(block.el);
    // DOM 幂等防御（契约 segmentation.md「容器获取幂等」T-016）：
    // 有他方会话/竞态遗留的容器时复用并清空重填，绝不堆叠第二个译文块
    const next = anchor.nextElementSibling;
    if (next?.classList.contains(CONTAINER_CLASS)) {
      this.containers.set(block.id, next as HTMLElement);
      next.replaceChildren();
      return next as HTMLElement;
    }
    const container = this.doc.createElement('div');
    container.className = CONTAINER_CLASS;
    container.setAttribute('data-itr-id', block.id);
    container.setAttribute('data-itr-theme', this.theme);
    anchor.insertAdjacentElement('afterend', container);
    this.containers.set(block.id, container);
    // H4（契约「clamp 释放三连」T-020b）：YouTube 标题/描述常态 line-clamp 截行，
    // 译文行也会被截；对锚点及其父、祖父追加释放样式（首建容器时一次即可）
    this.releaseClamp(anchor);
    return container;
  }

  /** 锚点及父、祖父（≤2 代）追加 `-webkit-line-clamp` 释放三连；原 style 记录待还原 */
  private releaseClamp(anchor: Element): void {
    let node: Element | null = anchor;
    for (let hops = 0; hops < 3 && node; hops += 1) {
      if (!this.originalStyle.has(node)) {
        this.originalStyle.set(node, node.getAttribute('style'));
        const style = (node as HTMLElement).style;
        if (style) {
          style.cssText += ';-webkit-line-clamp: unset; max-height: none; height: auto;';
        }
      }
      node = node.parentElement;
    }
  }

  /** 写入译文（或长文本的第 k 段）。丢失占位符：静默删除 + warn（契约兜底） */
  appendTranslation(block: SegBlock, translated: string): void {
    const container = this.ensureContainer(block);
    fillContainer(this.doc, container, translated, block.placeholders);
  }

  /** 失败态：错误占位样式；code 挂 title 便于 hover 排查 */
  appendError(block: SegBlock, code: string): void {
    const container = this.ensureContainer(block);
    const span = this.doc.createElement('span');
    span.className = 'itr-error';
    span.setAttribute('data-itr-error-code', code);
    span.title = `error: ${code}`;
    span.textContent = '⚠ 此段翻译失败';
    container.append(span);
  }

  /** 切换显示模式（bilingual ↔ translation-only），样式表同步滚动更新 */
  setStyleMode(mode: StyleMode): void {
    this.styleMode = mode;
    ensureStyleInjected(this.doc, this.theme, mode);
    if (mode === 'translation-only') {
      for (const block of this.blocks.values()) this.hideOriginal(block.el);
      return;
    }
    this.unhideAll();
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    ensureStyleInjected(this.doc, theme, this.styleMode);
    for (const container of this.containers.values()) {
      container.setAttribute('data-itr-theme', theme);
    }
  }

  /** 完全撤销：移除译文容器 + 摘除隐藏类 + 还原 clamp 样式 + 移除样式表；还原程度可测 */
  clearAll(): number {
    let removed = 0;
    for (const container of this.containers.values()) {
      container.remove();
      removed += 1;
    }
    this.containers.clear();
    this.unhideAll();
    this.restoreClamp();
    removeStyle(this.doc);
    this.blocks.clear();
    return removed;
  }

  private hideOriginal(el: Element): void {
    if (this.originalHidden.has(el)) return;
    const originalClass = el.getAttribute('class');
    el.classList.add(HIDDEN_CLASS);
    this.originalHidden.set(el, originalClass);
  }

  /** 摘除我们加的隐藏类；若 class 属性本是我们引入的（原为 null 且已空），整个摘除，保证字节级还原 */
  private unhideAll(): void {
    for (const [el, originalClass] of this.originalHidden) {
      el.classList.remove(HIDDEN_CLASS);
      if (originalClass === null && el.classList.length === 0) {
        el.removeAttribute('class');
      }
    }
    this.originalHidden.clear();
  }

  /** 还原 clamp 释放三连动过的 style 属性（原无 → 整个移除，字节级还原） */
  private restoreClamp(): void {
    for (const [el, originalStyle] of this.originalStyle) {
      if (originalStyle === null) {
        el.removeAttribute('style');
      } else {
        el.setAttribute('style', originalStyle);
      }
    }
    this.originalStyle.clear();
  }
}

/** [[n]] 还原：文本间隙建 text node；占位符克隆原 inline 节点（链接可点） */
function fillContainer(
  doc: Document,
  container: HTMLElement,
  translated: string,
  placeholders: readonly Element[],
): void {
  PLACEHOLDER_RE.lastIndex = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = PLACEHOLDER_RE.exec(translated)) !== null) {
    if (match.index > last) {
      container.append(doc.createTextNode(translated.slice(last, match.index)));
    }
    const index = Number(match[1]) - 1;
    const node = placeholders[index];
    if (!node) {
      logger.warn(`译文占位符 [[${match[1]}]] 无对应 inline 节点，已静默移除`);
    } else {
      container.append(node.cloneNode(true));
    }
    last = match.index + match[0].length;
  }
  if (last < translated.length) {
    container.append(doc.createTextNode(translated.slice(last)));
  }
}
