// T-030 PDF 阅读页拆分：页文本块提取、页/块几何、text layer span ↔ run。
// 纯函数分组仍在 shared/pdf-text.ts；这里只做页面状态与 DOM 的桥接。

import { groupPdfText, type PdfBlockRect, type PdfTextBlock } from '../../shared/pdf-text';
import { textRun, type SpanRun } from './pdf-highlight';
import { pdfState } from './pdf-state';
import type { PdfDocumentProxy } from './pdf-types';
import { pdfTextItemsFromContent } from './translation-utils';

export function pageHeightPts(page: number): number {
  return pdfState.pageDims.get(page)?.height ?? pdfState.firstPageDims.height;
}

/** 块矩形（PDF 用户空间，y 为块顶）→ 页面内屏幕坐标。 */
export function blockScreenspace(
  page: number,
  rect: PdfBlockRect,
): { top: number; bottom: number; left: number; right: number } {
  const height = pageHeightPts(page);
  return {
    top: (height - rect.y) * pdfState.scale,
    bottom: (height - rect.y + rect.height) * pdfState.scale,
    left: rect.x * pdfState.scale,
    right: (rect.x + rect.width) * pdfState.scale,
  };
}

export function textLayerOf(page: number): HTMLElement | null {
  return pdfState.pageEls[page - 1]?.querySelector<HTMLElement>('.textLayer') ?? null;
}

export function blockTextLayerSpans(page: number, block: PdfTextBlock): HTMLSpanElement[] {
  const layer = textLayerOf(page);
  if (!layer) return [];
  const box = blockScreenspace(page, block.rect);
  const spans: HTMLSpanElement[] = [];
  for (const span of layer.querySelectorAll<HTMLSpanElement>('span')) {
    const width = span.offsetWidth || 0;
    const height = span.offsetHeight || 0;
    const cx = span.offsetLeft + width / 2;
    const cy = span.offsetTop + height / 2;
    if (cy < box.top - 2 || cy > box.bottom + 2) continue;
    if (cx < box.left - 2 || cx > box.right + 2) continue;
    spans.push(span);
  }
  return spans;
}

export function sourceRuns(page: number, block: PdfTextBlock): SpanRun[] {
  const runs: SpanRun[] = [];
  let offset = 0;
  for (const span of blockTextLayerSpans(page, block)) {
    const node = span.firstChild;
    if (!(node instanceof Text)) continue;
    const run = textRun(node, offset);
    if (!run) continue;
    runs.push(run);
    offset = run.normEnd;
  }
  return runs;
}

export function destBlockEl(blockId: string): HTMLElement | null {
  for (const section of pdfState.sideSections.values()) {
    const found = section.querySelector<HTMLElement>(
      `.trans-block[data-block-id="${blockId}"] .block-text`,
    );
    if (found) return found;
  }
  return null;
}

export function destRuns(blockId: string): SpanRun[] {
  const el = destBlockEl(blockId);
  if (!el) return [];
  const runs: SpanRun[] = [];
  let offset = 0;
  for (const node of Array.from(el.childNodes)) {
    if (!(node instanceof Text)) continue;
    const run = textRun(node, offset);
    if (!run) continue;
    runs.push(run);
    offset = run.normEnd;
  }
  return runs;
}

export function blockAtSpan(page: number, node: Node): PdfTextBlock | null {
  const el = node instanceof Element ? node : node.parentElement;
  const span = el?.closest<HTMLSpanElement>('.textLayer span');
  if (!span) return null;
  const blocks = blocksForPage(page);
  const cx = span.offsetLeft + (span.offsetWidth || 0) / 2;
  const cy = span.offsetTop + (span.offsetHeight || 0) / 2;
  for (const block of blocks) {
    const box = blockScreenspace(page, block.rect);
    if (cy >= box.top - 2 && cy <= box.bottom + 2 && cx >= box.left - 2 && cx <= box.right + 2) {
      return block;
    }
  }
  return null;
}

/** 页面文本块：译文状态里的优先（同一次分组结果），其次本地缓存。 */
export function blocksForPage(page: number): PdfTextBlock[] {
  return pdfState.pageTranslations.get(page)?.blocks ?? pdfState.pageTextCache.get(page) ?? [];
}

export async function extractPageBlocks(
  doc: PdfDocumentProxy,
  page: number,
): Promise<PdfTextBlock[]> {
  const cached = pdfState.pageTextCache.get(page);
  if (cached) return cached;
  const inflight = pdfState.pageTextPending.get(page);
  if (inflight) return inflight;
  const task = (async () => {
    const proxy = await doc.getPage(page);
    try {
      const content = await proxy.getTextContent({ disableNormalization: true });
      const blocks = groupPdfText(pdfTextItemsFromContent(content), page).blocks;
      // 换文档后旧结果不得写回新缓存。
      if (pdfState.pdfDoc === doc) pdfState.pageTextCache.set(page, blocks);
      return blocks;
    } finally {
      try {
        proxy.cleanup();
      } catch {
        // ignore
      }
    }
  })();
  pdfState.pageTextPending.set(page, task);
  try {
    return await task;
  } finally {
    pdfState.pageTextPending.delete(page);
  }
}
