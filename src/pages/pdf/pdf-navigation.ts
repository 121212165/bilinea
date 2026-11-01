// T-030 PDF 阅读页拆分：页码滚动与原文块定位。
// scrollToPage 通过 pdfState.onPageChanged 回调 viewer.updatePageUi，
// 避免 navigation ↔ viewer 的循环依赖。

import type { PdfTextBlock } from '../../shared/pdf-text';
import { viewerScrollEl } from './pdf-dom';
import { blockScreenspace, textLayerOf } from './pdf-page-text';
import { pdfState } from './pdf-state';
import { setStatus } from './pdf-ui';

export function scrollToPage(page: number, smooth = true): void {
  if (!pdfState.pdfDoc || page < 1 || page > pdfState.pageCount) return;
  const el = pdfState.pageEls[page - 1];
  if (!el) return;
  if (smooth) pdfState.navScrollUntil = Date.now() + 1200;
  viewerScrollEl.scrollTo({
    top: Math.max(0, el.offsetTop - 12),
    behavior: smooth ? 'smooth' : 'auto',
  });
  pdfState.currentPage = page;
  pdfState.onPageChanged?.();
}

export function flashSourceBlock(block: PdfTextBlock, retries = 6): void {
  const el = pdfState.pageEls[block.page - 1];
  if (!el) return;
  if (!textLayerOf(block.page)) {
    if (retries > 0) {
      window.setTimeout(() => flashSourceBlock(block, retries - 1), 350);
    }
    return;
  }
  const box = blockScreenspace(block.page, block.rect);
  const flash = document.createElement('div');
  flash.className = 'itr-block-flash';
  flash.style.left = `${Math.round(box.left)}px`;
  flash.style.top = `${Math.round(box.top)}px`;
  flash.style.width = `${Math.max(2, Math.round(box.right - box.left))}px`;
  flash.style.height = `${Math.max(2, Math.round(box.bottom - box.top))}px`;
  el.append(flash);
  window.setTimeout(() => flash.remove(), 1600);
}

export function jumpToSourceBlock(block: PdfTextBlock): void {
  jumpToSource(block.page);
  setStatus(`定位到第 ${block.page} 页 ${block.id}`);
  flashSourceBlock(block);
}

function jumpToSource(page: number): void {
  scrollToPage(page, false);
}
