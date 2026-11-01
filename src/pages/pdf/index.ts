// T-030 PDF 阅读页拆分后的组合根：只做事件接线与启动，不再承载渲染/翻译/标记实现。
// 模块依赖方向见 .agent/plan/tasks/T-030.md；本文件不反向被任何模块 import。

import {
  clearMarksEl,
  dropOverlayEl,
  emptyEl,
  emptyPickEl,
  errorPickEl,
  errorRetryEl,
  fileInputEl,
  fitWidthEl,
  linkScrollEl,
  markBtnEl,
  nextPageEl,
  noticeCloseEl,
  openFileEl,
  pageInputEl,
  prevPageEl,
  sideBodyEl,
  stopTranslateEl,
  syncMarksEl,
  translateAllEl,
  translatePageEl,
  viewerScrollEl,
  zoomInEl,
  zoomOutEl,
} from './pdf-dom';
import {
  clearCurrentPageMarks,
  flushPdfMarks,
  hideMarkButton,
  loadPdfPrefs,
  placeMarkButton,
  savePdfPrefs,
  scheduleDraftFromSelection,
  toggleDraftMark,
} from './pdf-marks';
import { scrollToPage } from './pdf-navigation';
import { openFromFile, openFromUrl, pickFile, resetViewer, showError } from './pdf-loader';
import { followSidebarToCurrentPage, followViewerToSidebarPage } from './pdf-sidebar';
import { pdfState } from './pdf-state';
import {
  handleRuntimeMessage,
  loadTargetLang,
  startTranslation,
  stopTranslation,
} from './pdf-translation';
import { hideLoading, hideNotice, setStatus } from './pdf-ui';
import { applyScale, updateCurrentPage, updatePageUi } from './pdf-viewer';
import { fitPdfScale, parsePdfSource, stepPdfScale } from './viewer-utils';

function hasFilePayload(event: DragEvent): boolean {
  if ((event.dataTransfer?.files?.length ?? 0) > 0) return true;
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes('Files') : false;
}

function wireEvents(): void {
  openFileEl.addEventListener('click', pickFile);
  emptyPickEl.addEventListener('click', pickFile);
  errorPickEl.addEventListener('click', pickFile);
  fileInputEl.addEventListener('change', () => {
    const file = fileInputEl.files?.[0];
    if (file) void openFromFile(file);
  });

  prevPageEl.addEventListener('click', () => scrollToPage(pdfState.currentPage - 1));
  nextPageEl.addEventListener('click', () => scrollToPage(pdfState.currentPage + 1));
  pageInputEl.addEventListener('focus', () => pageInputEl.select());
  pageInputEl.addEventListener('change', () => {
    const page = Number(pageInputEl.value);
    if (Number.isInteger(page) && page >= 1 && page <= pdfState.pageCount) scrollToPage(page);
    else pageInputEl.value = String(pdfState.currentPage);
  });
  pageInputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      pageInputEl.blur();
    }
  });

  zoomOutEl.addEventListener('click', () => {
    applyScale(stepPdfScale(pdfState.scale, -0.1), { anchorPage: pdfState.currentPage });
  });
  zoomInEl.addEventListener('click', () => {
    applyScale(stepPdfScale(pdfState.scale, 0.1), { anchorPage: pdfState.currentPage });
  });
  fitWidthEl.addEventListener('click', () => {
    pdfState.autoFit = true;
    applyScale(fitPdfScale(viewerScrollEl.clientWidth, pdfState.firstPageDims.width), {
      keepAutoFit: true,
      anchorPage: pdfState.currentPage,
    });
  });

  viewerScrollEl.addEventListener(
    'scroll',
    () => {
      if (pdfState.scrollRaf !== 0) return;
      pdfState.scrollRaf = window.requestAnimationFrame(() => {
        pdfState.scrollRaf = 0;
        if (pdfState.markDraft) placeMarkButton();
        updateCurrentPage();
      });
    },
    { passive: true },
  );
  viewerScrollEl.addEventListener('scrollend', () => {
    if (pdfState.navScrollUntil === 0) return;
    pdfState.navScrollUntil = 0;
    updateCurrentPage();
  });

  // 侧栏滚动：用户一碰就暂时压制反向联动，避免两边互相拉扯。
  sideBodyEl.addEventListener(
    'wheel',
    () => {
      pdfState.sidebarUserScrollUntil = Date.now() + 1200;
    },
    { passive: true },
  );
  sideBodyEl.addEventListener(
    'pointerdown',
    () => {
      pdfState.sidebarUserScrollUntil = Date.now() + 1200;
    },
    { passive: true },
  );
  sideBodyEl.addEventListener(
    'scroll',
    () => {
      if (pdfState.sidebarRaf !== 0) return;
      pdfState.sidebarRaf = window.requestAnimationFrame(() => {
        pdfState.sidebarRaf = 0;
        if (pdfState.markDraft) placeMarkButton();
        followViewerToSidebarPage();
      });
    },
    { passive: true },
  );

  window.addEventListener('resize', () => {
    if (!pdfState.autoFit || !pdfState.pdfDoc) return;
    window.clearTimeout(pdfState.resizeTimer);
    pdfState.resizeTimer = window.setTimeout(() => {
      if (!pdfState.pdfDoc || !pdfState.autoFit) return;
      applyScale(fitPdfScale(viewerScrollEl.clientWidth, pdfState.firstPageDims.width), {
        keepAutoFit: true,
        anchorPage: pdfState.currentPage,
      });
    }, 150);
  });

  errorRetryEl.addEventListener('click', () => {
    if (pdfState.currentFile) void openFromFile(pdfState.currentFile);
    else if (pdfState.currentFileUrl) void openFromUrl(pdfState.currentFileUrl);
    else pickFile();
  });

  noticeCloseEl.addEventListener('click', hideNotice);

  translatePageEl.addEventListener('click', () => startTranslation('page'));
  translateAllEl.addEventListener('click', () => startTranslation('all'));
  stopTranslateEl.addEventListener('click', stopTranslation);
  chrome.runtime.onMessage.addListener(handleRuntimeMessage);

  markBtnEl.addEventListener('mousedown', (event) => event.preventDefault());
  markBtnEl.addEventListener('click', () => toggleDraftMark());
  document.addEventListener('mouseup', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('#itr-mark-btn')) return;
    scheduleDraftFromSelection();
  });
  document.addEventListener('selectionchange', () => {
    if (markBtnEl.hidden) return;
    window.clearTimeout(pdfState.markHideTimer);
    pdfState.markHideTimer = window.setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) hideMarkButton();
    }, 160);
  });

  clearMarksEl.addEventListener('click', clearCurrentPageMarks);
  syncMarksEl.addEventListener('change', () => {
    pdfState.syncMarks = syncMarksEl.checked;
    savePdfPrefs();
  });
  linkScrollEl.addEventListener('change', () => {
    pdfState.linkScroll = linkScrollEl.checked;
    savePdfPrefs();
    if (pdfState.linkScroll) followSidebarToCurrentPage();
  });

  document.addEventListener('dragenter', (event) => {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    pdfState.dragDepth += 1;
    dropOverlayEl.hidden = false;
  });
  document.addEventListener('dragover', (event) => {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('dragleave', () => {
    if (pdfState.dragDepth === 0) return;
    pdfState.dragDepth -= 1;
    if (pdfState.dragDepth === 0) dropOverlayEl.hidden = true;
  });
  document.addEventListener('drop', (event) => {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    pdfState.dragDepth = 0;
    dropOverlayEl.hidden = true;
    const file = event.dataTransfer?.files?.[0];
    if (file) void openFromFile(file);
  });

  window.addEventListener('keydown', (event) => {
    if (!pdfState.pdfDoc || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
    ) {
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      applyScale(stepPdfScale(pdfState.scale, 0.1), { anchorPage: pdfState.currentPage });
    } else if (event.key === '-') {
      event.preventDefault();
      applyScale(stepPdfScale(pdfState.scale, -0.1), { anchorPage: pdfState.currentPage });
    }
  });

  window.addEventListener('pagehide', () => {
    stopTranslation();
    void flushPdfMarks();
    pdfState.loadAbort?.abort();
    const task = pdfState.loadingTask;
    if (task) void task.destroy().catch(() => {});
  });
}

function boot(): void {
  const source = parsePdfSource(location.search);
  if (source.kind === 'ok') {
    void openFromUrl(source.url);
    return;
  }
  if (source.kind === 'bad') {
    showError('链接无效', '仅支持 http/https 的 PDF 链接；本地文件请直接拖入。', {
      retry: false,
    });
    return;
  }
  resetViewer();
  emptyEl.hidden = false;
  hideLoading();
  setStatus('');
}

// navigation.scrollToPage 不直接 import viewer：由组合根把页面 UI 同步回调装上。
// 显式放在启动前，避免依赖模块求值顺序。
pdfState.onPageChanged = updatePageUi;

wireEvents();
void loadPdfPrefs();
void loadTargetLang();
boot();
