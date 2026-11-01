// T-030 PDF 阅读页拆分：打开 URL/本地文件、挂载 pdf.js、错误态与重置。
// loadToken / AbortController / disposeDoc 三层防线原样保留。

import { logger } from '../../shared/logger';
import {
  emptyEl,
  errorDetailEl,
  errorEl,
  errorNativeEl,
  errorRetryEl,
  errorTitleEl,
  fileInputEl,
  pagesEl,
  sideBodyEl,
  sidePageEl,
  sideStatusEl,
  sideTogglesEl,
  translationActionsEl,
  viewerScrollEl,
} from './pdf-dom';
import {
  flushPdfMarks,
  loadPdfMarks,
  resetMarkState,
  setDocIdentity,
  updateMarkControls,
} from './pdf-marks';
import { pdfState } from './pdf-state';
import {
  LoadError,
  MAX_PDF_BYTES,
  errorName,
  type PdfDocumentProxy,
  type PdfJsModule,
} from './pdf-types';
import {
  hideError,
  hideLoading,
  hideNotice,
  setDocTitle,
  setStatus,
  showLoading,
} from './pdf-ui';
import {
  applyScale,
  ensureRenderWindow,
  loadPdfJs,
  setControlsEnabled,
  setupPages,
  updatePageUi,
  updateZoomUi,
} from './pdf-viewer';
import { renderSidebar } from './pdf-sidebar';
import {
  clearTranslationState,
  stopTranslation,
  updateTranslationControls,
} from './pdf-translation';
import { fitPdfScale, pdfTitleFromUrl } from './viewer-utils';

export function setSidebarEmpty(): void {
  sidePageEl.textContent = '第 – 页';
  sideBodyEl.replaceChildren();
  const box = document.createElement('div');
  box.className = 'side-empty';
  const p1 = document.createElement('p');
  p1.textContent = '打开 PDF 后，译文会按页显示在这里。';
  const p2 = document.createElement('p');
  p2.className = 'muted';
  p2.textContent = '左侧原文可选中复制；阅读器不接管默认 PDF 查看器。';
  box.append(p1, p2);
  sideBodyEl.append(box);
  sideStatusEl.textContent = '';
  translationActionsEl.hidden = true;
  sideTogglesEl.hidden = true;
  pdfState.sideSections.clear();
  pdfState.sideSignatures.clear();
  updateMarkControls();
  updateTranslationControls();
}

export function setSidebarReady(): void {
  translationActionsEl.hidden = false;
  sideTogglesEl.hidden = false;
  updateTranslationControls();
  renderSidebar();
}

export function resetViewer(): void {
  stopTranslation();
  clearTranslationState();
  if (pdfState.pendingSave) {
    window.clearTimeout(pdfState.marksSaveTimer);
    void flushPdfMarks();
  }
  resetMarkState();
  pdfState.renderEpoch += 1;
  pdfState.renderQueue.length = 0;
  pdfState.pendingPages.clear();
  pdfState.renderedPages.clear();
  pdfState.pageDims.clear();
  pdfState.pageEls.length = 0;
  pagesEl.replaceChildren();
  pdfState.pdfDoc = null;
  pdfState.pageCount = 0;
  pdfState.currentPage = 1;
  pdfState.scale = 1;
  pdfState.firstPageDims = { width: 612, height: 792 };
  hideNotice();
  hideError();
  hideLoading();
  emptyEl.hidden = true;
  setDocTitle('PDF 阅读器');
  setControlsEnabled(false);
  updatePageUi();
  updateZoomUi();
  setSidebarEmpty();
  setStatus('');
}

export async function disposeDoc(): Promise<void> {
  const task = pdfState.loadingTask;
  pdfState.loadingTask = null;
  pdfState.pdfDoc = null;
  if (!task) return;
  try {
    await task.destroy();
  } catch {
    // worker 可能已被销毁，忽略
  }
}

function httpError(status: number): LoadError {
  if (status === 401 || status === 403) {
    return new LoadError(
      '需要登录或无权访问',
      `服务器返回 HTTP ${status}。请先在浏览器登录该站点，或下载文件后拖入这里。`,
    );
  }
  if (status === 404) {
    return new LoadError('文件不存在', '服务器返回 HTTP 404，请检查链接是否有效。');
  }
  if (status >= 500) {
    return new LoadError('服务器错误', `服务器返回 HTTP ${status}，请稍后重试。`);
  }
  return new LoadError('无法读取 PDF', `服务器返回 HTTP ${status}。`);
}

export function showError(
  title: string,
  detail: string,
  opts: { retry?: boolean; nativeUrl?: string } = {},
): void {
  // 错误态必须让在途 fetch/解析失效，否则后到的成功结果会覆盖错误提示。
  pdfState.loadToken += 1;
  pdfState.loadAbort?.abort();
  pdfState.loadAbort = null;
  void disposeDoc();
  resetViewer();
  hideLoading();
  errorTitleEl.textContent = title;
  errorDetailEl.textContent = detail;
  errorRetryEl.hidden = opts.retry !== true;
  const nativeUrl = opts.nativeUrl ?? '';
  errorNativeEl.hidden = nativeUrl === '';
  if (nativeUrl !== '') errorNativeEl.href = nativeUrl;
  emptyEl.hidden = true;
  errorEl.hidden = false;
  sideStatusEl.textContent = '未能打开 PDF';
  setStatus('打开失败');
}

function failLoad(error: unknown, nativeUrl?: string): void {
  if (error instanceof DOMException && error.name === 'AbortError') return;
  const name = errorName(error);
  let title = '无法打开 PDF';
  let detail = '文件可能损坏，或使用了当前版本不支持的格式。';
  let canRetry = true;
  if (error instanceof LoadError) {
    title = error.title;
    detail = error.message;
  } else if (name === 'PasswordException') {
    title = 'PDF 已加密';
    detail =
      '当前版本不支持密码保护文件。请在原生查看器中解锁后另存为无密码版本，再拖入这里。';
    canRetry = false;
  } else if (name === 'InvalidPDFException') {
    title = '不是有效的 PDF';
    detail = '文件内容无法被解析，请确认文件完整。';
    canRetry = false;
  } else if (name === 'MissingPDFException') {
    title = '文件不存在';
    detail = '服务器没有返回 PDF 内容。';
  } else if (name === 'UnexpectedResponseException') {
    title = '服务器响应异常';
    detail = '服务器没有返回可识别的 PDF 内容。';
  }
  logger.warn('pdf load failed', { name });
  showError(title, detail, { retry: canRetry, nativeUrl });
}

async function prepareLoad(token: number): Promise<boolean> {
  pdfState.loadAbort?.abort();
  pdfState.loadAbort = null;
  await disposeDoc();
  if (token !== pdfState.loadToken) return false;
  resetViewer();
  hideError();
  emptyEl.hidden = true;
  showLoading('正在准备…');
  setStatus('读取中…');
  return true;
}

async function mountDocument(bytes: Uint8Array, title: string, token: number): Promise<void> {
  let lib: PdfJsModule;
  try {
    lib = await loadPdfJs();
  } catch {
    throw new LoadError('PDF 引擎加载失败', '扩展内的 pdf.js 资产缺失或损坏，请重新构建扩展。');
  }
  if (token !== pdfState.loadToken) return;

  const task = lib.getDocument({
    data: bytes,
    cMapUrl: chrome.runtime.getURL('pdf/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL('pdf/standard_fonts/'),
  });
  pdfState.loadingTask = task;
  task.onProgress = ({ loaded, total }) => {
    if (token !== pdfState.loadToken) return;
    if (total > 0) {
      const pct = Math.min(99, Math.round((loaded / total) * 100));
      showLoading(`正在解析 PDF… ${pct}%`);
      setStatus(`解析 ${pct}%`);
    } else {
      showLoading('正在解析 PDF…');
    }
  };

  let next: PdfDocumentProxy;
  try {
    next = await task.promise;
  } catch (error) {
    if (pdfState.loadingTask === task) pdfState.loadingTask = null;
    try {
      await task.destroy();
    } catch {
      // ignore
    }
    throw error;
  }
  if (token !== pdfState.loadToken) {
    try {
      await task.destroy();
    } catch {
      // ignore
    }
    return;
  }

  pdfState.pdfDoc = next;
  pdfState.pageCount = next.numPages;
  if (pdfState.pageCount < 1) throw new LoadError('空 PDF', '文件没有页面。');

  const first = await next.getPage(1);
  const base = first.getViewport({ scale: 1 });
  pdfState.firstPageDims = { width: base.width, height: base.height };
  pdfState.pageDims.set(1, pdfState.firstPageDims);
  try {
    first.cleanup();
  } catch {
    // ignore
  }
  if (token !== pdfState.loadToken) return;

  setDocTitle(title);
  setupPages();
  pdfState.autoFit = true;
  applyScale(fitPdfScale(viewerScrollEl.clientWidth, pdfState.firstPageDims.width), {
    keepAutoFit: true,
    anchorPage: 1,
  });
  setControlsEnabled(true);
  updatePageUi();
  updateZoomUi();
  setSidebarReady();
  void loadPdfMarks();
  hideLoading();
  setStatus(
    pdfState.pageCount > 200 ? `${pdfState.pageCount} 页 · 按需渲染` : `${pdfState.pageCount} 页`,
  );
  ensureRenderWindow(pdfState.currentPage);
}

async function openFromUrl(url: string): Promise<void> {
  const token = ++pdfState.loadToken;
  const ready = await prepareLoad(token);
  if (!ready) return;

  pdfState.currentFileUrl = url;
  pdfState.currentFile = null;
  const title = pdfTitleFromUrl(url);
  setDocTitle(title);
  setDocIdentity({ url });

  const controller = new AbortController();
  pdfState.loadAbort = controller;
  try {
    const response = await fetch(url, { credentials: 'include', signal: controller.signal });
    if (!response.ok) throw httpError(response.status);
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('text/html')) {
      throw new LoadError(
        '需要登录或链接已失效',
        '服务器返回了网页而不是 PDF。请先在浏览器登录该站点，或下载文件后拖入这里。',
      );
    }
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > MAX_PDF_BYTES) {
      throw new LoadError('文件过大', '当前上限为 200 MB，请先压缩或拆分 PDF。');
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_PDF_BYTES) {
      throw new LoadError('文件过大', '当前上限为 200 MB，请先压缩或拆分 PDF。');
    }
    if (token !== pdfState.loadToken || controller.signal.aborted) return;
    await mountDocument(new Uint8Array(buffer), title, token);
  } catch (error) {
    if (controller.signal.aborted || token !== pdfState.loadToken) return;
    failLoad(error, url);
  } finally {
    if (pdfState.loadAbort === controller) pdfState.loadAbort = null;
  }
}

async function openFromFile(file: File): Promise<void> {
  if (!isPdfFile(file)) {
    showError('不是 PDF 文件', '请选择后缀为 .pdf 的文件。', { retry: false });
    return;
  }
  if (file.size > MAX_PDF_BYTES) {
    showError('文件过大', '当前上限为 200 MB，请先压缩或拆分 PDF。', { retry: false });
    return;
  }

  const token = ++pdfState.loadToken;
  const ready = await prepareLoad(token);
  if (!ready) return;

  pdfState.currentFile = file;
  pdfState.currentFileUrl = null;
  const title = file.name || '本地 PDF';
  setDocTitle(title);
  setDocIdentity({
    file: { name: file.name, size: file.size, lastModified: file.lastModified },
  });
  try {
    const buffer = await file.arrayBuffer();
    if (token !== pdfState.loadToken) return;
    await mountDocument(new Uint8Array(buffer), title, token);
  } catch (error) {
    if (token !== pdfState.loadToken) return;
    failLoad(error);
  }
}

function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
}

export function pickFile(): void {
  fileInputEl.value = '';
  fileInputEl.click();
}

export { openFromFile, openFromUrl };
