// T-028d PDF 文本分组纯函数：pdf.js text items → 行 → 段落块。
// 故意不 import pdfjs，T-028e 再把 getTextContent() 的 TextItem 映射进来；Vitest 保持轻量。
//
// 输入坐标约定：沿用 PDF 用户空间，transform[4] 是 x，transform[5] 是基线 y（越大越靠上）。
// 输出块按页/栏分组；column=0 表示横跨双栏的整行（标题/表格行），1/2 为左/右栏。

export interface PdfTextItem {
  str: string;
  transform: readonly number[];
  width: number;
  height: number;
  dir?: string;
  fontName?: string;
  hasEOL?: boolean;
}

export interface PdfTextLine {
  page: number;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
  text: string;
}

/** 块在 PDF 用户空间的外接矩形；y 是**块顶**（向上为正），height 向下延伸到末行基线。 */
export interface PdfBlockRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfTextBlock {
  id: string;
  page: number;
  column: number;
  text: string;
  lineCount: number;
  rect: PdfBlockRect;
}

export interface PdfPageText {
  page: number;
  columns: number;
  lines: PdfTextLine[];
  blocks: PdfTextBlock[];
}

interface LayoutItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RawLine {
  y: number;
  x: number;
  width: number;
  height: number;
  items: LayoutItem[];
}

interface LineDraft {
  page: number;
  column: number;
  y: number;
  x: number;
  width: number;
  height: number;
  items: LayoutItem[];
}

const LINE_Y_TOLERANCE = 0.55;
const ITEM_GAP_FACTOR = 0.2;
const SEGMENT_GAP_FACTOR = 0.03;
const PARAGRAPH_GAP_FACTOR = 1.75;
const TERMINAL_GAP_FACTOR = 1.45;
const INDENT_FACTOR = 1.2;
const SHORT_LINE_FACTOR = 2;
const HEADING_SIZE_FACTOR = 1.2;

const CJK_RE =
  /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
const NO_SPACE_BEFORE = new Set([
  ',',
  '.',
  ';',
  ':',
  '!',
  '?',
  '%',
  ')',
  ']',
  '}',
  '’',
  '，',
  '。',
  '；',
  '：',
  '！',
  '？',
  '、',
  '）',
  '》',
  '」',
  '』',
  '】',
]);
const NO_SPACE_AFTER = new Set([
  '(',
  '[',
  '{',
  '‘',
  '“',
  '（',
  '《',
  '「',
  '『',
  '【',
]);
const LIST_MARKER_RE = /^(?:[•·▪◦*\-–—]\s+|\d{1,2}[.)]\s+)/;

function isCjkChar(char: string): boolean {
  return char !== '' && CJK_RE.test(char);
}

function terminalText(text: string): boolean {
  return /[.?!。！？]$/.test(text);
}

function normalizeItemText(text: string): string {
  return text.replace(/\u200b/g, '').replace(/\s+/g, ' ').trim();
}

function toLayoutItems(items: readonly PdfTextItem[]): LayoutItem[] {
  const out: LayoutItem[] = [];
  for (const item of items) {
    const text = normalizeItemText(item.str);
    if (text === '') continue;
    const transform = item.transform;
    const x = Number(transform[4]);
    const y = Number(transform[5]);
    const rawHeight = Number(item.height);
    const height =
      Number.isFinite(rawHeight) && rawHeight > 0
        ? rawHeight
        : Math.abs(Number(transform[3])) || 10;
    const rawWidth = Number(item.width);
    const width =
      Number.isFinite(rawWidth) && rawWidth > 0
        ? rawWidth
        : Math.max(height, text.length * height * 0.5);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width)) continue;
    out.push({ text, x, y, width, height });
  }
  return out;
}

function lineBounds(items: LayoutItem[]): { x: number; width: number; height: number } {
  let minX = Number.POSITIVE_INFINITY;
  let maxRight = Number.NEGATIVE_INFINITY;
  let height = 0;
  for (const item of items) {
    minX = Math.min(minX, item.x);
    maxRight = Math.max(maxRight, item.x + item.width);
    height = Math.max(height, item.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(maxRight)) {
    return { x: 0, width: 0, height: 0 };
  }
  return { x: minX, width: Math.max(0, maxRight - minX), height };
}

/** 把同一基线的 item 聚成原始行；双栏行此时会先合在一起，稍后再按栏拆开。 */
function groupRawLines(items: LayoutItem[]): RawLine[] {
  const sorted = items.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: RawLine[] = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (
      last &&
      Math.abs(last.y - item.y) <=
        Math.max(last.height, item.height) * LINE_Y_TOLERANCE
    ) {
      last.items.push(item);
      last.y = (last.y + item.y) / 2;
      const bounds = lineBounds(last.items);
      last.x = bounds.x;
      last.width = bounds.width;
      last.height = Math.max(last.height, item.height);
      continue;
    }
    const bounds = lineBounds([item]);
    lines.push({
      y: item.y,
      x: bounds.x,
      width: bounds.width,
      height: bounds.height,
      items: [item],
    });
  }
  for (const line of lines) line.items.sort((a, b) => a.x - b.x);
  return lines;
}

function needsSpace(prev: LayoutItem, next: LayoutItem): boolean {
  const left = prev.text[prev.text.length - 1] ?? '';
  const right = next.text[0] ?? '';
  if (left === '' || right === '') return false;
  if (left === '\u00ad' || right === '\u00ad') return false;
  if (isCjkChar(left) && isCjkChar(right)) return false;
  if (NO_SPACE_BEFORE.has(right) || NO_SPACE_AFTER.has(left)) return false;
  if (left === '-' || left === '/' || left === '—') return false;
  const gap = next.x - (prev.x + prev.width);
  return gap > Math.max(prev.height, next.height) * ITEM_GAP_FACTOR;
}

function joinLineItems(items: LayoutItem[]): string {
  const sorted = items.slice().sort((a, b) => a.x - b.x);
  let out = '';
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    if (!item) continue;
    const prev = i > 0 ? sorted[i - 1] : undefined;
    if (prev && needsSpace(prev, item)) out += ' ';
    out += item.text;
  }
  return out.replace(/[ \t]+/g, ' ').trim();
}

/** 仅用于检测栏位：按大间距把一行切成片段。 */
function splitSegments(line: RawLine, contentWidth: number): LayoutItem[][] {
  const threshold = Math.max(line.height * 1.5, contentWidth * SEGMENT_GAP_FACTOR);
  const segments: LayoutItem[][] = [];
  let current: LayoutItem[] = [];
  for (const item of line.items) {
    const prev = current[current.length - 1];
    if (prev && item.x - (prev.x + prev.width) > threshold) {
      segments.push(current);
      current = [item];
    } else {
      current.push(item);
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/**
 * 双栏检测：只看「恰好两个片段」的行，取左片段最大右缘与右片段最小左缘的中点。
 * 标题等整行 item 不会被误当成栏；表格行通常有 3+ 片段，也不会参与。
 */
function detectColumnSplit(
  rawLines: RawLine[],
  contentMinX: number,
  contentMaxX: number,
): number | null {
  const contentWidth = contentMaxX - contentMinX;
  if (contentWidth < 80) return null;
  let candidates = 0;
  let maxLeftEnd = Number.NEGATIVE_INFINITY;
  let minRightStart = Number.POSITIVE_INFINITY;
  for (const line of rawLines) {
    const segments = splitSegments(line, contentWidth);
    if (segments.length !== 2) continue;
    const [left, right] = segments;
    if (!left || !right) continue;
    const leftBounds = lineBounds(left);
    const rightBounds = lineBounds(right);
    const leftEnd = leftBounds.x + leftBounds.width;
    const rightStart = rightBounds.x;
    if (rightStart <= leftEnd) continue;
    candidates += 1;
    maxLeftEnd = Math.max(maxLeftEnd, leftEnd);
    minRightStart = Math.min(minRightStart, rightStart);
  }
  if (candidates < 2 || maxLeftEnd >= minRightStart) return null;
  const split = (maxLeftEnd + minRightStart) / 2;
  const fraction = (split - contentMinX) / contentWidth;
  if (fraction < 0.25 || fraction > 0.75) return null;
  return split;
}

function makeLine(
  items: LayoutItem[],
  page: number,
  column: number,
  y: number,
): LineDraft | null {
  if (items.length === 0) return null;
  const bounds = lineBounds(items);
  const text = joinLineItems(items);
  if (text === '') return null;
  return {
    page,
    column,
    y,
    x: bounds.x,
    width: bounds.width,
    height: bounds.height,
    items: items.slice().sort((a, b) => a.x - b.x),
  };
}

function splitRawLineByColumns(
  line: RawLine,
  page: number,
  split: number,
  contentWidth: number,
): LineDraft[] {
  const segments = splitSegments(line, contentWidth);
  if (segments.length === 0) return [];

  const allItems = segments.flat();
  const leftOfSplit = allItems.every((item) => item.x + item.width <= split);
  const rightOfSplit = allItems.every((item) => item.x >= split);
  if (leftOfSplit) {
    const draft = makeLine(allItems, page, 1, line.y);
    return draft ? [draft] : [];
  }
  if (rightOfSplit) {
    const draft = makeLine(allItems, page, 2, line.y);
    return draft ? [draft] : [];
  }

  // 横跨栏缝的整行（标题、通栏表格）保持整行。
  if (allItems.some((item) => item.x < split && item.x + item.width > split)) {
    const draft = makeLine(allItems, page, 0, line.y);
    return draft ? [draft] : [];
  }

  if (segments.length === 2) {
    const [left, right] = segments;
    if (!left || !right) return [];
    const leftEnd = lineBounds(left).x + lineBounds(left).width;
    const rightStart = lineBounds(right).x;
    if (leftEnd <= split && rightStart >= split) {
      const leftDraft = makeLine(left, page, 1, line.y);
      const rightDraft = makeLine(right, page, 2, line.y);
      return [leftDraft, rightDraft].filter(
        (draft): draft is LineDraft => draft !== null,
      );
    }
  }

  // 片段都在同一侧（栏内有一条大间距），整行归到该栏；否则按通栏处理。
  const centers = segments.map((seg) => {
    const bounds = lineBounds(seg);
    return bounds.x + bounds.width / 2;
  });
  if (centers.every((center) => center < split)) {
    const draft = makeLine(allItems, page, 1, line.y);
    return draft ? [draft] : [];
  }
  if (centers.every((center) => center > split)) {
    const draft = makeLine(allItems, page, 2, line.y);
    return draft ? [draft] : [];
  }
  const draft = makeLine(allItems, page, 0, line.y);
  return draft ? [draft] : [];
}

function singleColumnLines(rawLines: RawLine[], page: number): LineDraft[] {
  const lines: LineDraft[] = [];
  for (const raw of rawLines) {
    const draft = makeLine(raw.items, page, 1, raw.y);
    if (draft) lines.push(draft);
  }
  return lines;
}

/** 行内切分：行距正常时并成一段；大间距/首行缩进/列表符/字号变化另起一段。 */
function buildBlocks(lines: LineDraft[], page: number, column: number): PdfTextBlock[] {
  if (lines.length === 0) return [];
  const ordered = lines.slice().sort((a, b) => b.y - a.y || a.x - b.x);
  let columnLeft = Number.POSITIVE_INFINITY;
  let columnRight = Number.NEGATIVE_INFINITY;
  for (const line of ordered) {
    columnLeft = Math.min(columnLeft, line.x);
    columnRight = Math.max(columnRight, line.x + line.width);
  }

  const blocks: PdfTextBlock[] = [];
  let current: LineDraft[] = [];
  let currentText = '';
  let index = 0;

  const flush = (): void => {
    if (current.length === 0) return;
    if (currentText !== '') {
      index += 1;
      let minX = Number.POSITIVE_INFINITY;
      let maxRight = Number.NEGATIVE_INFINITY;
      let minBottom = Number.POSITIVE_INFINITY;
      let maxTop = Number.NEGATIVE_INFINITY;
      for (const line of current) {
        minX = Math.min(minX, line.x);
        maxRight = Math.max(maxRight, line.x + line.width);
        minBottom = Math.min(minBottom, line.y);
        maxTop = Math.max(maxTop, line.y + line.height);
      }
      blocks.push({
        id: `p${page}-c${column}-b${index}`,
        page,
        column,
        text: currentText,
        lineCount: current.length,
        rect: {
          x: minX,
          y: maxTop,
          width: Math.max(0, maxRight - minX),
          height: Math.max(0, maxTop - minBottom),
        },
      });
    }
    current = [];
    currentText = '';
  };

  for (const line of ordered) {
    const prev = current[current.length - 1];
    let nextParagraph = false;
    if (prev) {
      const pitch = Math.max(prev.height, line.height, 1);
      const gap = prev.y - line.y;
      const prevText = joinLineItems(prev.items);
      const currentTextLine = joinLineItems(line.items);
      const prevShort = prev.x + prev.width < columnRight - pitch * SHORT_LINE_FACTOR;
      const indented = line.x > columnLeft + pitch * INDENT_FACTOR;
      const listMarker = LIST_MARKER_RE.test(currentTextLine);
      const prevListMarker = LIST_MARKER_RE.test(prevText);
      const sizeDrop =
        prev.height > line.height * HEADING_SIZE_FACTOR && gap > pitch * 0.8;
      nextParagraph =
        gap > pitch * PARAGRAPH_GAP_FACTOR ||
        sizeDrop ||
        (listMarker && !prevListMarker) ||
        (gap > pitch * TERMINAL_GAP_FACTOR && terminalText(prevText)) ||
        (indented && prevShort && terminalText(prevText));
      if (nextParagraph) flush();
    }

    if (current.length === 0) currentText = '';
    const lineText = joinLineItems(line.items);
    currentText = current.length === 0 ? lineText : joinBlockLines(currentText, lineText);
    current.push(line);
  }
  flush();
  return blocks;
}

function joinBlockLines(prevText: string, nextText: string): string {
  const left = prevText.trimEnd();
  const right = nextText.trimStart();
  if (left === '') return right;
  if (right === '') return left;
  const last = left[left.length - 1] ?? '';
  const first = right[0] ?? '';
  if (last === '\u00ad') return left.slice(0, -1) + right;
  if (last === '-') {
    if (/[a-z]/.test(first)) return left.slice(0, -1) + right;
    return left + right;
  }
  if (isCjkChar(last) || isCjkChar(first)) return left + right;
  if (NO_SPACE_BEFORE.has(first) || NO_SPACE_AFTER.has(last)) return left + right;
  if (last === '—' || last === '/' || first === '\u00ad') return left + right;
  return `${left} ${right}`;
}

function cleanBlockText(text: string): string {
  return text.replace(/\u00ad/g, '').replace(/[ \t]+/g, ' ').trim();
}

function toPublicLine(line: LineDraft): PdfTextLine {
  return {
    page: line.page,
    column: line.column,
    x: line.x,
    y: line.y,
    width: line.width,
    height: line.height,
    text: joinLineItems(line.items),
  };
}

/**
 * 主入口：把一页 pdf.js text items 分组为行和段落块。
 * 双栏时先输出通栏行（column=0），再输出左栏（1）和右栏（2）；
 * 单栏时所有行/块 column=1。空页返回空 lines/blocks、columns=1。
 */
export function groupPdfText(
  items: readonly PdfTextItem[],
  page = 1,
): PdfPageText {
  const pageNo = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
  const layout = toLayoutItems(items);
  if (layout.length === 0) {
    return { page: pageNo, columns: 1, lines: [], blocks: [] };
  }

  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  for (const item of layout) {
    minX = Math.min(minX, item.x);
    maxX = Math.max(maxX, item.x + item.width);
  }
  const contentWidth = maxX - minX;
  const rawLines = groupRawLines(layout);
  const split = detectColumnSplit(rawLines, minX, maxX);

  if (split === null) {
    const drafts = singleColumnLines(rawLines, pageNo);
    const blocks = buildBlocks(drafts, pageNo, 1).map((block) => ({
      ...block,
      text: cleanBlockText(block.text),
    }));
    return {
      page: pageNo,
      columns: 1,
      lines: drafts.map(toPublicLine),
      blocks,
    };
  }

  const full: LineDraft[] = [];
  const left: LineDraft[] = [];
  const right: LineDraft[] = [];
  for (const line of rawLines) {
    const parts = splitRawLineByColumns(line, pageNo, split, contentWidth);
    for (const part of parts) {
      if (part.column === 0) full.push(part);
      else if (part.column === 1) left.push(part);
      else right.push(part);
    }
  }

  if (left.length === 0 || right.length === 0) {
    const drafts = singleColumnLines(rawLines, pageNo);
    return {
      page: pageNo,
      columns: 1,
      lines: drafts.map(toPublicLine),
      blocks: buildBlocks(drafts, pageNo, 1).map((block) => ({
        ...block,
        text: cleanBlockText(block.text),
      })),
    };
  }

  const drafts = [...full, ...left, ...right];
  const blocks = [
    ...buildBlocks(full, pageNo, 0),
    ...buildBlocks(left, pageNo, 1),
    ...buildBlocks(right, pageNo, 2),
  ].map((block) => ({ ...block, text: cleanBlockText(block.text) }));
  return {
    page: pageNo,
    columns: 2,
    lines: drafts.map(toPublicLine),
    blocks,
  };
}
