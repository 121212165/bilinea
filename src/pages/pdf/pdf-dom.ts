// T-030 PDF 阅读页拆分：DOM 引用集中处。
// 所有 id 都来自 src/pages/pdf/index.html；缺元素时启动即抛错，保持原行为。

export function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export const docTitleEl = byId<HTMLSpanElement>('doc-title');
export const statusEl = byId<HTMLDivElement>('status');
export const noticeEl = byId<HTMLDivElement>('notice');
export const noticeTextEl = byId<HTMLSpanElement>('notice-text');
export const noticeCloseEl = byId<HTMLButtonElement>('notice-close');
export const openFileEl = byId<HTMLButtonElement>('open-file');
export const fileInputEl = byId<HTMLInputElement>('file-input');
export const prevPageEl = byId<HTMLButtonElement>('prev-page');
export const nextPageEl = byId<HTMLButtonElement>('next-page');
export const pageInputEl = byId<HTMLInputElement>('page-input');
export const pageCountEl = byId<HTMLSpanElement>('page-count');
export const zoomOutEl = byId<HTMLButtonElement>('zoom-out');
export const zoomInEl = byId<HTMLButtonElement>('zoom-in');
export const zoomLabelEl = byId<HTMLSpanElement>('zoom-label');
export const fitWidthEl = byId<HTMLButtonElement>('fit-width');
export const viewerScrollEl = byId<HTMLDivElement>('viewer-scroll');
export const pagesEl = byId<HTMLDivElement>('pages');
export const emptyEl = byId<HTMLDivElement>('empty');
export const emptyPickEl = byId<HTMLButtonElement>('empty-pick');
export const loadingEl = byId<HTMLDivElement>('loading');
export const loadingTextEl = byId<HTMLParagraphElement>('loading-text');
export const errorEl = byId<HTMLDivElement>('error');
export const errorTitleEl = byId<HTMLHeadingElement>('error-title');
export const errorDetailEl = byId<HTMLParagraphElement>('error-detail');
export const errorRetryEl = byId<HTMLButtonElement>('error-retry');
export const errorPickEl = byId<HTMLButtonElement>('error-pick');
export const errorNativeEl = byId<HTMLAnchorElement>('error-native');
export const dropOverlayEl = byId<HTMLDivElement>('drop-overlay');
export const sidePageEl = byId<HTMLSpanElement>('side-page');
export const sideBodyEl = byId<HTMLDivElement>('side-body');
export const sideStatusEl = byId<HTMLDivElement>('side-status');
export const translationActionsEl = byId<HTMLDivElement>('translation-actions');
export const translatePageEl = byId<HTMLButtonElement>('translate-page');
export const translateAllEl = byId<HTMLButtonElement>('translate-all');
export const stopTranslateEl = byId<HTMLButtonElement>('stop-translate');
export const translationTargetEl = byId<HTMLSpanElement>('translation-target');
export const sideTogglesEl = byId<HTMLDivElement>('side-toggles');
export const syncMarksEl = byId<HTMLInputElement>('sync-marks');
export const linkScrollEl = byId<HTMLInputElement>('link-scroll');
export const clearMarksEl = byId<HTMLButtonElement>('clear-marks');
export const markBtnEl = byId<HTMLButtonElement>('itr-mark-btn');
