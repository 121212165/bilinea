// T-030 PDF 阅读页拆分：选中草稿、Highlight 渲染、标记持久化与配对删除。
// 高亮保持零 DOM 写入；锚点仍是「块内去空白字符偏移」。

import { logger } from '../../shared/logger';
import {
  PDF_MARKS_STORAGE_KEY,
  PDF_MARKS_VERSION,
  PDF_PREFS_STORAGE_KEY,
  MAX_MARK_TEXT,
  findMarkAt,
  locateMarkText,
  marksForSide,
  newMarkId,
  normalizeMarkText,
  pdfDocKey,
  removeMarks,
  sanitizeMarkStore,
  sideLabel,
  upsertMark,
  type PdfDocIdentity,
  type PdfMark,
  type PdfMarkSide,
} from '../../shared/pdf-marks';
import { clearMarksEl, linkScrollEl, markBtnEl, sideStatusEl, syncMarksEl } from './pdf-dom';
import {
  highlightApi,
  normOffsetAt,
  rangeFromRuns,
  runsText,
  setHighlightRanges,
} from './pdf-highlight';
import {
  blockAtSpan,
  blocksForPage,
  destRuns,
  extractPageBlocks,
  sourceRuns,
} from './pdf-page-text';
import { pdfState } from './pdf-state';
import { errorName, type MarkDraft } from './pdf-types';

export function setDocIdentity(identity: PdfDocIdentity): void {
  pdfState.docKey = pdfDocKey(identity);
}

export async function loadPdfPrefs(): Promise<void> {
  try {
    const got = await chrome.storage.local.get(PDF_PREFS_STORAGE_KEY);
    const raw = got[PDF_PREFS_STORAGE_KEY];
    if (raw && typeof raw === 'object') {
      const prefs = raw as Record<string, unknown>;
      pdfState.syncMarks = prefs.syncMarks !== false;
      pdfState.linkScroll = prefs.linkScroll !== false;
    }
  } catch (error) {
    logger.warn('pdf prefs load failed', error);
  }
  syncMarksEl.checked = pdfState.syncMarks;
  linkScrollEl.checked = pdfState.linkScroll;
}

export function savePdfPrefs(): void {
  void chrome.storage.local
    .set({
      [PDF_PREFS_STORAGE_KEY]: { syncMarks: pdfState.syncMarks, linkScroll: pdfState.linkScroll },
    })
    .catch((error) => logger.warn('pdf prefs save failed', error));
}

export async function loadPdfMarks(): Promise<void> {
  const key = pdfState.docKey;
  if (!key || pdfState.repoLoaded) return;
  pdfState.repoLoaded = true;
  try {
    const got = await chrome.storage.local.get(PDF_MARKS_STORAGE_KEY);
    const all = got[PDF_MARKS_STORAGE_KEY];
    const store = sanitizeMarkStore(
      all && typeof all === 'object' ? (all as Record<string, unknown>)[key] : null,
    );
    if (pdfState.docKey !== key) return;
    // 加载期间可能已新建标记：按 id 合并，本地新增优先。
    const byId = new Map(store.marks.map((mark) => [mark.id, mark]));
    for (const mark of pdfState.marks) byId.set(mark.id, mark);
    pdfState.marks = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  } catch (error) {
    logger.warn('pdf marks load failed', error);
  }
  applyHighlights();
  updateMarkControls();
}

export function persistPdfMarks(): void {
  if (!pdfState.docKey) return;
  pdfState.pendingSave = {
    key: pdfState.docKey,
    marks: pdfState.marks.map((mark) => ({ ...mark })),
  };
  window.clearTimeout(pdfState.marksSaveTimer);
  pdfState.marksSaveTimer = window.setTimeout(() => {
    void flushPdfMarks();
  }, 200);
}

export async function flushPdfMarks(): Promise<void> {
  const job = pdfState.pendingSave;
  if (!job) return;
  pdfState.pendingSave = null;
  try {
    const got = await chrome.storage.local.get(PDF_MARKS_STORAGE_KEY);
    const raw = got[PDF_MARKS_STORAGE_KEY];
    const all: Record<string, unknown> =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>) }
        : {};
    all[job.key] = { version: PDF_MARKS_VERSION, marks: job.marks };
    await chrome.storage.local.set({ [PDF_MARKS_STORAGE_KEY]: all });
  } catch (error) {
    logger.warn('pdf marks save failed', error);
  }
}

export function applyHighlights(): void {
  const api = highlightApi();
  if (!api) return;
  const srcRanges: Range[] = [];
  const dstRanges: Range[] = [];

  for (const mark of marksForSide(pdfState.marks, 'src')) {
    const block = blocksForPage(mark.page).find((item) => item.id === mark.blockId);
    if (!block) continue;
    // 在 text layer 的实际文本序列里定位：块文本的拼接空格与 span 拼接不一定逐字相同。
    const runs = sourceRuns(mark.page, block);
    const hay = runsText(runs);
    const located =
      locateMarkText(hay, mark.text, mark.start) ??
      // 同步标记的对侧是整块：拼接口径有差异时退化为整块高亮。
      (mark.start === 0 && mark.end >= normalizeMarkText(block.text).length && hay !== ''
        ? { start: 0, end: hay.length }
        : null);
    if (!located) continue;
    const range = rangeFromRuns(runs, located.start, located.end);
    if (range) srcRanges.push(range);
  }

  for (const mark of marksForSide(pdfState.marks, 'dst')) {
    const state = pdfState.pageTranslations.get(mark.page);
    const translated = state?.items.get(mark.blockId)?.text ?? '';
    if (translated === '') continue;
    const runs = destRuns(mark.blockId);
    const located = locateMarkText(runsText(runs), mark.text, mark.start);
    if (!located) continue;
    const range = rangeFromRuns(runs, located.start, located.end);
    if (range) dstRanges.push(range);
  }

  setHighlightRanges(api, 'itr-mark-src', srcRanges);
  setHighlightRanges(api, 'itr-mark-dst', dstRanges);
}

export function readSelectionDraft(): MarkDraft | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (range.collapsed) return null;
  const text = selection.toString().trim();
  if (text === '' || text.length > MAX_MARK_TEXT) return null;
  const startEl = range.startContainer.parentElement;
  const endEl = range.endContainer.parentElement;
  if (!startEl) return null;

  const srcPage = startEl.closest<HTMLElement>('.pdf-page');
  if (srcPage) {
    if (!endEl || endEl.closest('.pdf-page') !== srcPage) return null;
    const page = Number(srcPage.dataset.page);
    if (!Number.isInteger(page) || page < 1) return null;
    const startBlock = blockAtSpan(page, range.startContainer);
    const endBlock = blockAtSpan(page, range.endContainer);
    if (!startBlock || endBlock?.id !== startBlock.id) return null;
    const runs = sourceRuns(page, startBlock);
    const start = normOffsetAt(runs, range.startContainer, range.startOffset);
    const end = normOffsetAt(runs, range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start) return null;
    const existing = findMarkAt(pdfState.marks, 'src', startBlock.id, start);
    return {
      side: 'src',
      page,
      blockId: startBlock.id,
      text,
      start,
      end,
      ...(existing ? { existingId: existing.id } : {}),
    };
  }

  const dstBlock = startEl.closest<HTMLElement>('.trans-block');
  if (dstBlock) {
    if (!endEl || endEl.closest('.trans-block') !== dstBlock) return null;
    const page = Number(dstBlock.dataset.page);
    const blockId = dstBlock.dataset.blockId ?? '';
    if (!Number.isInteger(page) || page < 1 || blockId === '') return null;
    const runs = destRuns(blockId);
    const start = normOffsetAt(runs, range.startContainer, range.startOffset);
    const end = normOffsetAt(runs, range.endContainer, range.endOffset);
    if (start === null || end === null || end <= start) return null;
    const existing = findMarkAt(pdfState.marks, 'dst', blockId, start);
    return {
      side: 'dst',
      page,
      blockId,
      text,
      start,
      end,
      ...(existing ? { existingId: existing.id } : {}),
    };
  }
  return null;
}

export function showMarkButton(draft: MarkDraft): void {
  pdfState.markDraft = draft;
  markBtnEl.textContent = draft.existingId ? '取消标记' : '高亮';
  markBtnEl.title = `${sideLabel(draft.side)} · ${draft.blockId}`;
  markBtnEl.hidden = false;
  placeMarkButton();
}

/** 滚动后选区会移动：跟着选区走，选区滚出视口或已消失才收起按钮。 */
export function placeMarkButton(): void {
  if (!pdfState.markDraft) return;
  const selection = window.getSelection();
  const rect =
    selection && selection.rangeCount > 0 && !selection.isCollapsed
      ? selection.getRangeAt(0).getBoundingClientRect()
      : null;
  if (!rect || (rect.width === 0 && rect.height === 0)) {
    hideMarkButton();
    return;
  }
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    hideMarkButton();
    return;
  }
  const x = rect.left + rect.width / 2;
  const y = rect.bottom + 8;
  markBtnEl.style.left = `${Math.round(Math.max(28, Math.min(window.innerWidth - 28, x)))}px`;
  markBtnEl.style.top = `${Math.round(Math.max(8, Math.min(window.innerHeight - 36, y)))}px`;
}

export function hideMarkButton(): void {
  pdfState.markDraft = null;
  markBtnEl.hidden = true;
}

export function scheduleDraftFromSelection(): void {
  window.clearTimeout(pdfState.markHideTimer);
  pdfState.markHideTimer = window.setTimeout(() => {
    const draft = readSelectionDraft();
    if (draft) {
      showMarkButton(draft);
      return;
    }
    // 原文页没翻译过也能标记：先本地抽取该页文本块，再重试一次。
    const page = selectionSourcePage();
    const doc = pdfState.pdfDoc;
    if (page === null || !doc) return;
    void extractPageBlocks(doc, page)
      .then(() => {
        if (pdfState.pdfDoc !== doc) return;
        const retry = readSelectionDraft();
        if (retry) showMarkButton(retry);
      })
      .catch((error) =>
        logger.warn('pdf page text extract failed', { page, name: errorName(error) }),
      );
  }, 10);
}

/** 选区落在原文页且该页还没有文本块时返回页码。 */
function selectionSourcePage(): number | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const anchor = selection.getRangeAt(0).startContainer;
  const el = anchor instanceof Element ? anchor : anchor.parentElement;
  const pageEl = el?.closest<HTMLElement>('.pdf-page');
  if (!pageEl) return null;
  const page = Number(pageEl.dataset.page);
  if (!Number.isInteger(page) || page < 1) return null;
  return blocksForPage(page).length === 0 ? page : null;
}

/** 同步标记：对侧整块标记（段落级对齐，不做句级对齐）。 */
function buildSyncedMark(mark: PdfMark, pairId: string): PdfMark | null {
  const otherSide: PdfMarkSide = mark.side === 'src' ? 'dst' : 'src';
  const state = pdfState.pageTranslations.get(mark.page);
  const block = state?.blocks.find((item) => item.id === mark.blockId);
  if (!block) return null;
  const text =
    otherSide === 'dst' ? (state?.items.get(mark.blockId)?.text ?? '') : block.text;
  const norm = normalizeMarkText(text);
  if (norm === '') return null;
  return {
    id: newMarkId(),
    side: otherSide,
    page: mark.page,
    blockId: mark.blockId,
    text: text.slice(0, MAX_MARK_TEXT),
    start: 0,
    end: norm.length,
    createdAt: Date.now(),
    pairId,
  };
}

export function toggleDraftMark(): void {
  const draft = pdfState.markDraft;
  if (!draft) return;
  if (draft.existingId) {
    pdfState.marks = removeMarks(pdfState.marks, new Set([draft.existingId]));
  } else {
    const pairId = pdfState.syncMarks ? newMarkId() : '';
    const mark: PdfMark = {
      id: newMarkId(),
      side: draft.side,
      page: draft.page,
      blockId: draft.blockId,
      text: draft.text.slice(0, MAX_MARK_TEXT),
      start: draft.start,
      end: draft.end,
      createdAt: Date.now(),
      ...(pairId ? { pairId } : {}),
    };
    pdfState.marks = upsertMark(pdfState.marks, mark);
    if (pairId) {
      const paired = buildSyncedMark(mark, pairId);
      if (paired) pdfState.marks = upsertMark(pdfState.marks, paired);
    }
  }
  hideMarkButton();
  window.getSelection()?.removeAllRanges();
  applyHighlights();
  updateMarkControls();
  persistPdfMarks();
  sideStatusEl.textContent =
    pdfState.marks.length > 0
      ? `标记 ${pdfState.marks.length} 处 · 选中文字可再次标记`
      : '本地解析 · 仅发送文本块到翻译引擎';
}

export function updateMarkControls(): void {
  const count = pdfState.marks.filter((mark) => mark.page === pdfState.currentPage).length;
  clearMarksEl.hidden = count === 0;
  clearMarksEl.textContent = count > 0 ? `清除本页标记（${count}）` : '清除本页标记';
}

export function clearCurrentPageMarks(): void {
  const ids = new Set(
    pdfState.marks
      .filter((mark) => mark.page === pdfState.currentPage)
      .map((mark) => mark.id),
  );
  if (ids.size === 0) return;
  pdfState.marks = removeMarks(pdfState.marks, ids);
  applyHighlights();
  updateMarkControls();
  persistPdfMarks();
}

/** 换文档时只清文档键/内存标记；高亮与按钮由 clearTranslationState 统一收。 */
export function resetMarkState(): void {
  pdfState.docKey = '';
  pdfState.marks = [];
  pdfState.repoLoaded = false;
}
