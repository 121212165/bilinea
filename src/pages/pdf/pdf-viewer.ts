// T-030 PDF 阅读页拆分：页占位、确定性渲染窗口、缩放、当前页与离屏驱逐。
// 保留原实现的关键纪律：显式窗口替代 IntersectionObserver；epoch 校验所有 await。

import { logger } from '../../shared/logger';
import {
  fitWidthEl,
  nextPageEl,
  pageCountEl,
  pageInputEl,
  pagesEl,
  prevPageEl,
  sidePageEl,
  sideStatusEl,
  translationActionsEl,
  viewerScrollEl,
  zoomInEl,
  zoomLabelEl,
  zoomOutEl,
} from './pdf-dom';
import { applyHighlights } from './pdf-marks';
import {
  decoratePageBlocks,
  followSidebarToCurrentPage,
  renderSidebar,
} from './pdf-sidebar';
import { enqueueCurrentPage, updateTranslationControls } from './pdf-translation';
import { pdfState } from './pdf-state';
import {
  MAX_DPR,
  RENDER_CONCURRENCY,
  RENDER_KEEP_DISTANCE,
  errorName,
  type PdfJsModule,
  type PdfPageProxy,
} from './pdf-types';
import { showNotice } from './pdf-ui';
import {
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
  clampPdfScale,
  formatPdfPercent,
} from './viewer-utils';

export function updateZoomUi(): void {
  zoomLabelEl.textContent = pdfState.pdfDoc ? formatPdfPercent(pdfState.scale) : '–';
  zoomOutEl.disabled = !pdfState.pdfDoc || pdfState.scale <= PDF_MIN_SCALE;
  zoomInEl.disabled = !pdfState.pdfDoc || pdfState.scale >= PDF_MAX_SCALE;
  fitWidthEl.disabled = !pdfState.pdfDoc;
}

export function updatePageUi(): void {
  pageCountEl.textContent = pdfState.pdfDoc ? String(pdfState.pageCount) : '–';
  pageInputEl.max = pdfState.pdfDoc ? String(pdfState.pageCount) : '';
  if (document.activeElement !== pageInputEl) {
    pageInputEl.value = String(pdfState.currentPage);
  }
  prevPageEl.disabled = !pdfState.pdfDoc || pdfState.currentPage <= 1;
  nextPageEl.disabled = !pdfState.pdfDoc || pdfState.currentPage >= pdfState.pageCount;
  sidePageEl.textContent = pdfState.pdfDoc ? `第 ${pdfState.currentPage} 页` : '第 – 页';
  for (let i = 0; i < pdfState.pageEls.length; i++) {
    const el = pdfState.pageEls[i];
    if (el) {
      el.classList.toggle(
        'current',
        pdfState.pdfDoc !== null && i + 1 === pdfState.currentPage,
      );
    }
  }
  if (pdfState.pdfDoc) {
    renderSidebar();
    enqueueCurrentPage();
  }
}

export function setControlsEnabled(enabled: boolean): void {
  const on = enabled && pdfState.pdfDoc !== null;
  prevPageEl.disabled = !on;
  nextPageEl.disabled = !on;
  zoomOutEl.disabled = !on;
  zoomInEl.disabled = !on;
  fitWidthEl.disabled = !on;
  pageInputEl.disabled = !on;
  translationActionsEl.hidden = !on;
  updateTranslationControls();
  if (on) {
    updatePageUi();
    updateZoomUi();
  }
}

export async function loadPdfJs(): Promise<PdfJsModule> {
  if (pdfState.pdfjs) return pdfState.pdfjs;
  const moduleUrl = chrome.runtime.getURL('pdf/pdf.min.mjs');
  const imported = (await import(moduleUrl)) as unknown as PdfJsModule;
  imported.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf/pdf.worker.min.mjs');
  pdfState.pdfjs = imported;
  return imported;
}

export function setupPages(): void {
  pagesEl.replaceChildren();
  pdfState.pageEls.length = 0;
  for (let page = 1; page <= pdfState.pageCount; page++) {
    const dims = pdfState.pageDims.get(page) ?? pdfState.firstPageDims;
    const el = document.createElement('div');
    el.className = 'pdf-page is-placeholder';
    el.dataset.page = String(page);
    el.style.width = `${dims.width * pdfState.scale}px`;
    el.style.height = `${dims.height * pdfState.scale}px`;
    pagesEl.append(el);
    pdfState.pageEls.push(el);
  }
}

export function ensureRenderWindow(page: number): void {
  if (!pdfState.pdfDoc) return;
  // 显式窗口渲染（替代 IntersectionObserver）：IO 在程序化滚动时会漏报离开，
  // 导致回收后的页滚回来不重建；按当前页 ±2 页调度是确定性的。
  const from = Math.max(1, page - 1);
  const to = Math.min(pdfState.pageCount, page + 2);
  for (let p = from; p <= to; p++) scheduleRender(p);
}

function scheduleRender(page: number): void {
  if (!pdfState.pdfDoc || page < 1 || page > pdfState.pageCount) return;
  if (pdfState.renderedPages.has(page)) return;
  if (pdfState.pendingPages.get(page) === pdfState.renderEpoch) return;
  pdfState.pendingPages.set(page, pdfState.renderEpoch);
  pdfState.renderQueue.push(page);
  void pumpQueue();
}

async function pumpQueue(): Promise<void> {
  while (
    pdfState.activeRenders < RENDER_CONCURRENCY &&
    pdfState.renderQueue.length > 0
  ) {
    const page = pdfState.renderQueue.shift();
    if (page === undefined) break;
    pdfState.activeRenders += 1;
    void renderPage(page, pdfState.renderEpoch).finally(() => {
      pdfState.activeRenders -= 1;
      void pumpQueue();
    });
  }
}

async function renderPage(pageNumber: number, epoch: number): Promise<void> {
  const activeDoc = pdfState.pdfDoc;
  const lib = pdfState.pdfjs;
  const el = pdfState.pageEls[pageNumber - 1];
  if (!activeDoc || !lib || !el) return;

  let page: PdfPageProxy | null = null;
  try {
    page = await activeDoc.getPage(pageNumber);
    if (epoch !== pdfState.renderEpoch || !pdfState.pdfDoc) return;

    const base = page.getViewport({ scale: 1 });
    const known = pdfState.pageDims.get(pageNumber);
    if (!known) {
      pdfState.pageDims.set(pageNumber, { width: base.width, height: base.height });
      if (
        Math.abs(base.width - pdfState.firstPageDims.width) > 0.5 ||
        Math.abs(base.height - pdfState.firstPageDims.height) > 0.5
      ) {
        el.style.width = `${base.width * pdfState.scale}px`;
        el.style.height = `${base.height * pdfState.scale}px`;
      }
    }

    const viewport = page.getViewport({ scale: pdfState.scale });
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');

    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';
    textDiv.style.setProperty('--total-scale-factor', String(pdfState.scale));
    textDiv.style.setProperty('--scale-round-x', '1px');
    textDiv.style.setProperty('--scale-round-y', '1px');

    el.replaceChildren(canvas, textDiv);
    el.classList.remove('is-placeholder', 'is-error');

    const renderTask = page.render({
      canvasContext: ctx,
      viewport,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
    });
    await renderTask.promise;
    if (epoch !== pdfState.renderEpoch || !pdfState.pdfDoc) return;

    let noText = false;
    try {
      const textLayer = new lib.TextLayer({
        textContentSource: page.streamTextContent({
          includeMarkedContent: true,
          disableNormalization: true,
        }),
        container: textDiv,
        viewport,
      });
      await textLayer.render();
      if (epoch !== pdfState.renderEpoch || !pdfState.pdfDoc) return;
      noText = textLayer.textContentItemsStr.length === 0;
    } catch (error) {
      if (epoch !== pdfState.renderEpoch || !pdfState.pdfDoc) return;
      logger.warn('pdf text layer failed', { page: pageNumber, name: errorName(error) });
    }

    pdfState.renderedPages.add(pageNumber);
    el.classList.remove('is-placeholder');
    decoratePageBlocks(pageNumber);
    applyHighlights();
    if (noText && pageNumber === 1) {
      showNotice('未检测到文本层：这份 PDF 可能是扫描件，当前版本不做 OCR。');
      sideStatusEl.textContent = '未检测到文本层（可能是扫描件）';
    }
  } catch (error) {
    if (epoch !== pdfState.renderEpoch || !pdfState.pdfDoc) return;
    pdfState.renderedPages.add(pageNumber);
    el.classList.remove('is-placeholder');
    el.classList.add('is-error');
    const message = document.createElement('div');
    message.className = 'page-error-msg';
    message.textContent = '此页渲染失败';
    el.replaceChildren(message);
    logger.warn('pdf page render failed', { page: pageNumber, name: errorName(error) });
  } finally {
    if (pdfState.pendingPages.get(pageNumber) === epoch) {
      pdfState.pendingPages.delete(pageNumber);
    }
    if (page) {
      try {
        page.cleanup();
      } catch {
        // ignore
      }
    }
  }
}

export function applyScale(
  nextScale: number,
  opts: { keepAutoFit?: boolean; anchorPage?: number } = {},
): void {
  if (!pdfState.pdfDoc) return;
  const next = clampPdfScale(nextScale);
  if (Math.abs(next - pdfState.scale) < 0.001) {
    if (!opts.keepAutoFit) pdfState.autoFit = false;
    updateZoomUi();
    ensureRenderWindow(pdfState.currentPage);
    return;
  }

  const anchor = opts.anchorPage ?? pdfState.currentPage;
  const anchorEl = pdfState.pageEls[anchor - 1];
  const beforeTop = anchorEl ? anchorEl.getBoundingClientRect().top : 0;

  pdfState.scale = next;
  pdfState.renderEpoch += 1;
  pdfState.renderedPages.clear();
  pdfState.pendingPages.clear();
  pdfState.renderQueue.length = 0;

  for (let i = 0; i < pdfState.pageEls.length; i++) {
    const el = pdfState.pageEls[i];
    if (!el) continue;
    const dims = pdfState.pageDims.get(i + 1) ?? pdfState.firstPageDims;
    el.style.width = `${dims.width * pdfState.scale}px`;
    el.style.height = `${dims.height * pdfState.scale}px`;
    el.replaceChildren();
    el.classList.add('is-placeholder');
    el.classList.remove('is-error', 'current');
  }

  if (!opts.keepAutoFit) pdfState.autoFit = false;
  const afterTop = anchorEl ? anchorEl.getBoundingClientRect().top : 0;
  viewerScrollEl.scrollTop += afterTop - beforeTop;

  updateZoomUi();
  updatePageUi();
  ensureRenderWindow(pdfState.currentPage);
  updateCurrentPage();
}

export function updateCurrentPage(): void {
  if (!pdfState.pdfDoc || pdfState.pageEls.length === 0) return;
  if (Date.now() < pdfState.navScrollUntil) {
    ensureRenderWindow(pdfState.currentPage);
    evictDistantPages(pdfState.currentPage);
    return;
  }
  const probe = viewerScrollEl.scrollTop + 100;
  let page = 1;
  for (let i = 0; i < pdfState.pageEls.length; i++) {
    const el = pdfState.pageEls[i];
    if (!el) continue;
    if (el.offsetTop <= probe) page = i + 1;
    else break;
  }
  if (page !== pdfState.currentPage) {
    pdfState.currentPage = page;
    updatePageUi();
    followSidebarToCurrentPage();
  }
  ensureRenderWindow(page);
  evictDistantPages(page);
}

/**
 * 释放远离当前页的已渲染 canvas：长文档滚动后否则会保留每一页的位图。
 * 只回收「不相交、不在途、离当前页 > RENDER_KEEP_DISTANCE、且不承载选区」的页；
 * 滚回来时由 ensureRenderWindow 重新调度渲染，角标与高亮在 renderPage 尾部重建。
 */
function evictDistantPages(page: number): void {
  if (pdfState.renderedPages.size <= RENDER_KEEP_DISTANCE + 2) return;
  const selection = window.getSelection();
  const anchor = selection && selection.rangeCount > 0 ? selection.anchorNode : null;
  const root = viewerScrollEl.getBoundingClientRect();
  for (const rendered of [...pdfState.renderedPages]) {
    if (Math.abs(rendered - page) <= RENDER_KEEP_DISTANCE) continue;
    if (pdfState.pendingPages.has(rendered)) continue;
    const el = pdfState.pageEls[rendered - 1];
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    // 用几何判断而不是 IntersectionObserver 状态：IO 在快速程序化滚动时会漏报离开。
    if (rect.bottom > root.top - 300 && rect.top < root.bottom + 300) continue;
    if (anchor && el.contains(anchor)) continue;
    el.replaceChildren();
    el.classList.add('is-placeholder');
    pdfState.renderedPages.delete(rendered);
  }
}


