// 段落抽取器（T-006）：严格对照 .agent/spec/contracts/segmentation.md
// 纯 DOM 逻辑，不碰 chrome / 网络。测试用 jsdom 直接喂 HTML。

/** 与 skip 相关的完整选择器（含祖先命中：closest 一层搞定） */
const SKIP_SELECTOR = [
  'script',
  'style',
  'noscript',
  'code',
  'pre',
  'kbd',
  'samp',
  'textarea',
  'input',
  'select',
  'button',
  'svg',
  'canvas',
  'iframe',
  '[translate="no"]',
  '.notranslate',
  '[contenteditable]',
  '[class*="itr-"]',
].join(',');

const BLOCK_TAGS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'td',
  'th',
  'blockquote',
  'figcaption',
  'dd',
  'dt',
  'summary',
  'caption',
  'option',
];

const INLINE_TAGS = new Set([
  'a',
  'b',
  'strong',
  'i',
  'em',
  'span',
  'sup',
  'sub',
  'img',
  'u',
  'small',
  'mark',
  'cite',
  'q',
  'abbr',
  'bdi',
  'bdo',
  'time',
  'font',
  'wbr',
]);

const URL_EMAIL_RE =
  /https?:\/\/\S+|[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+|\bwww\.\S+/g;

/** 叶子块兜底（契约 T-009 节）：div/span 站点（X 等）的段落容器 */
const LEAF_QUERY = 'div, section, article';
const BLOCKISH_CHILD_TAGS = new Set<string>([
  ...BLOCK_TAGS,
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
  'ul',
  'ol',
  'table',
  'tbody',
  'thead',
  'tr',
  'td',
  'th',
  'dl',
  'dt',
  'dd',
  'form',
  'blockquote',
]);
const MAX_BLOCKS_PER_PAGE = 600;
const LEAF_MIN_CHARS = 20;
const LEAF_MAX_CHARS = 1600;
/** 覆盖选择器通道边界（契约「站点选择器覆盖」）：推文可短于 20 / 长文可超 1600 */
const OVERRIDE_MIN_CHARS = 4;
const OVERRIDE_MAX_CHARS = 4000;

export interface SegBlock {
  id: string;
  el: Element;
  text: string;
  /** [[n]] ↔ inline 节点映射（n = 数组下标 + 1） */
  placeholders: Element[];
}

export interface ExtractOptions {
  /** 会话后缀，保证同页多次抽取 id 不冲突 */
  sessionId?: string;
  /** 可见性判定（浏览器端给 checkVisibility 实现；jsdom 测试注入 () => true） */
  isVisible?: (el: Element) => boolean;
  /** 站点覆盖选择器（契约「站点选择器覆盖」T-013）：命中即优先提取，无视祖先级 skip */
  overrideSelector?: string;
  /** 站点级抽取黑名单（契约「站点级 skipSelector」T-020）：closest 命中即整块跳过 */
  skipSelector?: string;
}

/** 纯数字/纯符号/URL/邮箱占比 > 80% → 噪声（契约 Skip #5） */
export function isNoiseText(text: string): boolean {
  // 先按词间距保留 URL 完整性，再剥离
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length === 0) return true;
  const stripped = normalized.replace(URL_EMAIL_RE, '').replace(/\s+/g, '');
  const total = normalized.replace(/\s+/g, '').length;
  if (total === 0) return true;
  if (stripped.length / total < 0.2) return true;
  const meaningful = stripped.replace(/[\p{N}\p{P}\p{S}]/gu, '');
  return meaningful.length / total < 0.2;
}

interface Gather {
  text: string;
  placeholders: Element[];
}

function isSkippable(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (
    [
      'script',
      'style',
      'noscript',
      'code',
      'pre',
      'kbd',
      'samp',
      'textarea',
      'input',
      'select',
      'button',
      'svg',
      'canvas',
      'iframe',
    ].includes(tag)
  ) {
    return true;
  }
  if (el.getAttribute('translate') === 'no') return true;
  const cls = el.getAttribute('class') ?? '';
  if (cls.split(/\s+/).includes('notranslate') || cls.includes('itr-')) return true;
  if (el.hasAttribute('contenteditable')) return true;
  return false;
}

/** 深度优先收集文本：inline 边界 → 占位符；skip 子树 → 整体剥除（契约 skip #1 子树语义）。
 *  叶子块通道（unwrapSpan）：span 视为正文展开——div 站点正文整体在 span 内，转占位符会导致正文无法被翻译。 */
function gather(node: Node, out: Gather, unwrapSpan = false): void {
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      out.text += child.nodeValue ?? '';
      return;
    }
    if (child.nodeType !== 1) return;
    const childEl = child as Element;
    if (isSkippable(childEl)) return;
    const inlineSpan = unwrapSpan && childEl.tagName.toLowerCase() === 'span';
    if (INLINE_TAGS.has(childEl.tagName.toLowerCase()) && !inlineSpan) {
      const inner = (childEl.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (inner.length > 0 || childEl.tagName.toLowerCase() === 'img') {
        out.placeholders.push(childEl);
        out.text += `[[${out.placeholders.length}]]`;
      }
      return;
    }
    gather(childEl, out, unwrapSpan);
  });
}
export function extractBlocks(root: Element, opts: ExtractOptions = {}): SegBlock[] {
  const sessionId = opts.sessionId ?? Math.random().toString(36).slice(2, 6);
  const isVisible = opts.isVisible ?? ((el: Element) => el.checkVisibility?.() ?? true);
  const skipSel = opts.skipSelector;
  /** T-020 三通道统一的站点黑名单；命中即整块跳过 */
  const siteSkipped = (el: Element): boolean =>
    skipSel !== undefined && el.closest(skipSel) !== null;
  const blocks: SegBlock[] = [];
  let counter = 0;
  const pushBlock = (el: Element, text: string, placeholders: Element[]): void => {
    counter += 1;
    blocks.push({
      id: `b${counter.toString(36)}-${sessionId}`,
      el,
      text,
      placeholders,
    });
  };

  // 站点覆盖通道（契约「站点选择器覆盖」T-013）：
  // 命中选择器的元素优先提取；无视祖先级 skip（如根节点 translate=no 整页拉黑），
  // 元素自身 skip 仍生效；祖先同样命中覆盖选择器时只取最外层（嵌套去重）。
  if (opts.overrideSelector) {
    const overrideSel: string = opts.overrideSelector;
    const overrideEls = Array.from(root.querySelectorAll(overrideSel));
    for (const el of overrideEls) {
      if (blocks.length >= MAX_BLOCKS_PER_PAGE) break;
      if (isSkippable(el)) continue; // 自身 skip 生效；closest 祖先检查刻意不做
      if (siteSkipped(el)) continue; // T-020 站点黑名单
      if (!isVisible(el)) continue;
      if (el.parentElement?.closest(overrideSel)) continue; // 只取最外层
      const out: Gather = { text: '', placeholders: [] };
      gather(el, out, true); // 叶子通道语义：span 展开为正文（推文正文在 nested spans 里）
      const text = out.text.replace(/\s+/g, ' ').trim();
      // T-020 降内联：整块无裸文本字符（全成 [[n]] 占位符，如 <h3><a>标题</a></h3>）
      // → 平铺重抽，避免「零可译文本」块被长度下限直接弃掉（契约「覆盖通道降内联」）
      if (text.replace(/\[\[\d+\]\]/g, '').length === 0 && el.textContent?.trim()) {
        const flat: Gather = { text: '', placeholders: [] };
        gatherFlat(el, flat);
        const flatText = flat.text.replace(/\s+/g, ' ').trim();
        if (flatText.length >= OVERRIDE_MIN_CHARS && flatText.length <= OVERRIDE_MAX_CHARS) {
          if (!isNoiseText(flatText)) pushBlock(el, flatText, flat.placeholders);
          continue;
        }
      }
      if (text.length < OVERRIDE_MIN_CHARS || text.length > OVERRIDE_MAX_CHARS) continue;
      if (isNoiseText(text)) continue;
      pushBlock(el, text, out.placeholders);
    }
  }

  // 主白名单候选（契约 skip #1~#5）
  const candidates = Array.from(root.querySelectorAll(BLOCK_TAGS.join(',')));
  for (const el of candidates) {
    if (blocks.length >= MAX_BLOCKS_PER_PAGE) break;
    // Skip #1/#2 + 祖先在 skip 子树（如 <li> 嵌在 <button> 里）
    if (el.closest(SKIP_SELECTOR)) continue;
    if (siteSkipped(el)) continue; // T-020 站点黑名单
    if (!isVisible(el)) continue;

    const out: Gather = { text: '', placeholders: [] };
    gather(el, out);
    const text = out.text.replace(/\s+/g, ' ').trim();
    // Skip #4：长度边界
    if (text.length < 2 || text.length > 8000) continue;
    // Skip #5：噪声
    if (isNoiseText(text)) continue;

    pushBlock(el, text, out.placeholders);
  }

  // 叶子块兜底：div/section/article 中无块级直接子元素者（X/推文等 div 站）
  const leaves = Array.from(root.querySelectorAll(LEAF_QUERY));
  for (const el of leaves) {
    if (blocks.length >= MAX_BLOCKS_PER_PAGE) break;
    if (el.closest(SKIP_SELECTOR)) continue;
    if (siteSkipped(el)) continue; // T-020 站点黑名单
    if (!isVisible(el)) continue;
    if (hasBlockishChild(el)) continue;
    // T-020b（契约「叶子块兜底」）：内部命中覆盖目标的叶子整块放弃——区域文本
    // 已由覆盖目标单独成块，leaf 整吞会产生重复块（watch #snippet vs #snippet-text）
    if (opts.overrideSelector) {
      const ovHost = el.querySelector(opts.overrideSelector);
      if (ovHost && !isSkippable(ovHost) && !siteSkipped(ovHost)) continue;
    }

    const out: Gather = { text: '', placeholders: [] };
    gather(el, out, true); // 叶子通道：span 展开为正文（契约「叶子块兜底」）
    const text = out.text.replace(/\s+/g, ' ').trim();
    // 叶子阈值：≥20 防把 UI 碎文本当段落（契约「叶子块兜底」）
    if (text.length < LEAF_MIN_CHARS || text.length > LEAF_MAX_CHARS) continue;
    if (isNoiseText(text)) continue;

    pushBlock(el, text, out.placeholders);
  }
  return blocks;
}

/** 直接子元素中是否含块级容器（含即非叶子，交给候选/其子层处理）。
 *  T-020b：custom element（tagName 含 `-`，如 ytd-* 或 yt-lockup-view-model）同为
 *  块级——浏览器默认块级渲染。watch 侧栏 #contents / ytLockupViewModelHost 的
 *  直接子全是 custom element / inline a，此前被误判叶子 → 整树吞文本
 *  （用户症状「时长戳两两成对」的根因；feed 页因 host 直接子含真 div 侥幸免触发）。 */
function hasBlockishChild(el: Element): boolean {
  return Array.from(el.children).some((child) =>
    BLOCKISH_CHILD_TAGS.has(child.tagName.toLowerCase()) || child.tagName.includes('-'),
  );
}

/** T-020 降内联平铺：inline 元素只递归取其文本，不进占位符（链接文本当正文） */
function gatherFlat(node: Node, out: Gather): void {
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      out.text += child.nodeValue ?? '';
      return;
    }
    if (child.nodeType !== 1) return;
    const childEl = child as Element;
    if (isSkippable(childEl)) return;
    if (INLINE_TAGS.has(childEl.tagName.toLowerCase())) {
      out.text += ` ${childEl.textContent ?? ''}`;
      return;
    }
    gatherFlat(childEl, out);
  });
}

/**
 * 长文本（>4000 chars）按句子边界切成 ≤ 4000 的子段（契约「长文本」节）。
 * 贪心扫描：始终记录最近句界；到达 max 时切在句界，无句界则硬切。
 * 不变量：parts 连续拼接 == 原文，且每段 ≤ max。
 */
export function splitLongText(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let start = 0;
  let lastBoundary = -1; // 最近句界字符的下一位
  for (let i = 0; i < text.length; i += 1) {
    if (isSentenceBoundary(text, i)) lastBoundary = i + 1;
    if (i - start + 1 === max) {
      const end = lastBoundary > start ? lastBoundary : i + 1;
      parts.push(text.slice(start, end));
      start = end;
      lastBoundary = -1;
    }
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

function isSentenceBoundary(text: string, i: number): boolean {
  const ch = text[i] ?? '';
  return '.。!?！？\n'.includes(ch);
}
