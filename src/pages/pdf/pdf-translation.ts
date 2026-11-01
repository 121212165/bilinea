// T-030 PDF 阅读页拆分：页面级翻译队列、RPC 进度、停止与公共设置。
// 队列仍是「每页一个 TRANSLATE_BATCH + 串行」；所有迟到响应由 token/requestId 拦截。

import { logger } from '../../shared/logger';
import { callRpc } from '../../shared/messaging';
import type { ProviderError, TranslatedSegment } from '../../shared/types';
import {
  sideStatusEl,
  stopTranslateEl,
  translateAllEl,
  translatePageEl,
  translationTargetEl,
} from './pdf-dom';
import { clearHighlightRegistry } from './pdf-highlight';
import { hideMarkButton } from './pdf-marks';
import { extractPageBlocks } from './pdf-page-text';
import { pdfState } from './pdf-state';
import { errorName, type PageTranslationState } from './pdf-types';
import { renderSidebar, updateSidebarStatus } from './pdf-sidebar';
import { blocksToSegments } from './translation-utils';

export function updateTranslationControls(): void {
  const on = pdfState.pdfDoc !== null;
  translatePageEl.disabled = !on;
  translateAllEl.disabled = !on;
  const busy =
    pdfState.translationMode !== null ||
    pdfState.activeTranslation !== null ||
    pdfState.translationQueue.size > 0;
  stopTranslateEl.hidden = !busy;
  translationTargetEl.textContent = on ? `目标：${pdfState.translationTarget}` : '';
}

function isProviderError(value: unknown): value is ProviderError {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

function isTranslatedSegment(value: unknown): value is TranslatedSegment {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { id?: unknown; text?: unknown; error?: unknown };
  if (typeof record.id !== 'string' || typeof record.text !== 'string') return false;
  if (record.error === undefined) return true;
  return isProviderError(record.error);
}

function consumeTranslatedItem(state: PageTranslationState, item: TranslatedSegment): void {
  state.items.set(item.id, item);
  const source = state.blocks.find((block) => block.id === item.id);
  if (!source) return;
  // 队列按“同文本唯一段”发进度；把结果同步给同文本的重复 block。
  for (const block of state.blocks) {
    if (block.id !== item.id && block.text === source.text) {
      state.items.set(block.id, { ...item, id: block.id });
    }
  }
}

export function handleRuntimeMessage(message: unknown): void {
  if (typeof message !== 'object' || message === null) return;
  const event = message as {
    type?: unknown;
    requestId?: unknown;
    done?: unknown;
    total?: unknown;
    items?: unknown;
    error?: unknown;
  };
  if (event.type !== 'TRANSLATION_PROGRESS' && event.type !== 'TRANSLATION_DONE') return;
  if (typeof event.requestId !== 'string' || !pdfState.activeTranslation) return;
  if (event.requestId !== pdfState.activeTranslation.requestId) return;
  const state = pdfState.pageTranslations.get(pdfState.activeTranslation.page);
  if (!state) return;

  if (event.type === 'TRANSLATION_PROGRESS') {
    if (typeof event.done === 'number' && Number.isFinite(event.done)) {
      state.done = Math.max(state.done, event.done);
    }
    if (typeof event.total === 'number' && Number.isFinite(event.total) && event.total > 0) {
      state.total = event.total;
    }
    if (Array.isArray(event.items)) {
      for (const raw of event.items) {
        if (isTranslatedSegment(raw)) consumeTranslatedItem(state, raw);
      }
    }
  } else {
    // DONE 只用于确认进度；最终 items 以 RPC 响应为准（含重复文本段）。
    if (state.total > 0) state.done = state.total;
    if (event.error !== undefined && state.error === null && isProviderError(event.error)) {
      state.error = event.error;
    }
  }
  if (pdfState.activeTranslation.page === pdfState.currentPage) renderSidebar();
  else updateSidebarStatus();
}

function enqueuePage(page: number, front = false): boolean {
  if (!pdfState.pdfDoc || page < 1 || page > pdfState.pageCount) return false;
  const state = pdfState.pageTranslations.get(page);
  if (state?.status === 'done' || state?.status === 'empty') return false;
  if (pdfState.activeTranslation?.page === page) return false;
  return pdfState.translationQueue.enqueue(page, front);
}

export function enqueueCurrentPage(): void {
  if (pdfState.translationMode === null) return;
  enqueuePage(pdfState.currentPage, true);
}

export function startTranslation(mode: 'page' | 'all'): void {
  if (!pdfState.pdfDoc) return;
  if (mode === 'all') pdfState.translationMode = 'all';
  else if (pdfState.translationMode === null) pdfState.translationMode = 'page';

  if (mode === 'all') {
    for (let page = 1; page <= pdfState.pageCount; page++) enqueuePage(page);
  } else {
    enqueuePage(pdfState.currentPage, true);
  }
  if (!pdfState.activeTranslation && pdfState.translationQueue.size === 0) {
    pdfState.translationMode = null;
  }
  updateTranslationControls();
  renderSidebar();
  void pumpTranslation();
}

function finishTranslationIfIdle(): void {
  if (pdfState.activeTranslation || pdfState.translationQueue.size > 0) return;
  pdfState.translationMode = null;
}

async function pumpTranslation(): Promise<void> {
  if (pdfState.activeTranslation || !pdfState.pdfDoc) {
    updateTranslationControls();
    return;
  }

  let page: number | null = null;
  while (pdfState.translationQueue.size > 0) {
    const candidate = pdfState.translationQueue.take();
    if (candidate === null) break;
    const known = pdfState.pageTranslations.get(candidate);
    if (known?.status === 'done' || known?.status === 'empty') continue;
    page = candidate;
    break;
  }
  if (page === null) {
    finishTranslationIfIdle();
    updateTranslationControls();
    if (pdfState.pdfDoc) renderSidebar();
    return;
  }

  const doc = pdfState.pdfDoc;
  const token = pdfState.translationToken;
  pdfState.translationSeq += 1;
  const requestId = `pdf-${page}-${Date.now().toString(36)}-${pdfState.translationSeq.toString(36)}`;
  const state: PageTranslationState = {
    page,
    status: 'extracting',
    blocks: [],
    items: new Map(),
    total: 0,
    done: 0,
    error: null,
  };
  pdfState.pageTranslations.set(page, state);
  pdfState.activeTranslation = { page, requestId, token };
  updateTranslationControls();
  renderSidebar();

  try {
    const blocks = await extractPageBlocks(doc, page);
    if (
      token !== pdfState.translationToken ||
      pdfState.pdfDoc !== doc ||
      pdfState.activeTranslation?.requestId !== requestId
    ) {
      return;
    }
    state.blocks = blocks;
    state.total = new Set(blocks.map((block) => block.text)).size;
    if (blocks.length === 0) {
      state.status = 'empty';
      return;
    }

    state.status = 'translating';
    renderSidebar();
    const res = await callRpc({
      type: 'TRANSLATE_BATCH',
      segments: blocksToSegments(blocks),
      source: 'auto',
      target: pdfState.translationTarget,
      requestId,
    });
    if (
      token !== pdfState.translationToken ||
      pdfState.pdfDoc !== doc ||
      pdfState.activeTranslation?.requestId !== requestId
    ) {
      return;
    }
    if (res.type === 'TRANSLATION') {
      for (const item of res.items) consumeTranslatedItem(state, item);
      const itemError = res.items.find((item) => item.error)?.error;
      state.error = res.error ?? itemError ?? null;
      state.done = state.total;
      state.status = state.error ? 'error' : 'done';
    } else {
      state.error = { code: 'E_PROVIDER_DOWN' };
      state.status = 'error';
    }
  } catch (error) {
    if (
      token === pdfState.translationToken &&
      pdfState.pdfDoc === doc &&
      pdfState.activeTranslation?.requestId === requestId
    ) {
      state.error = { code: 'E_PROVIDER_DOWN' };
      state.status = 'error';
      logger.warn('pdf translation failed', { page, name: errorName(error) });
    }
  } finally {
    if (pdfState.activeTranslation?.requestId === requestId) pdfState.activeTranslation = null;
    if (token === pdfState.translationToken) {
      finishTranslationIfIdle();
      updateTranslationControls();
      renderSidebar();
      void pumpTranslation();
    }
  }
}

export function stopTranslation(): void {
  const active = pdfState.activeTranslation;
  pdfState.translationToken += 1;
  pdfState.translationMode = null;
  pdfState.translationQueue.clear();
  pdfState.activeTranslation = null;
  if (active) {
    const state = pdfState.pageTranslations.get(active.page);
    if (state && (state.status === 'extracting' || state.status === 'translating')) {
      state.status = 'stopped';
    }
    void callRpc({ type: 'CANCEL', requestId: active.requestId }).catch(() => undefined);
  }
  updateTranslationControls();
  if (pdfState.pdfDoc) {
    renderSidebar();
    if (active) {
      const kept = pdfState.pageTranslations.get(active.page)?.items.size ?? 0;
      sideStatusEl.textContent = kept > 0 ? `已停止翻译 · 已保留 ${kept} 段` : '已停止翻译';
    }
  }
}

export function clearTranslationState(): void {
  pdfState.pageTranslations.clear();
  pdfState.pageTextCache.clear();
  pdfState.pageTextPending.clear();
  pdfState.translationQueue.clear();
  pdfState.translationMode = null;
  pdfState.activeTranslation = null;
  pdfState.translationToken += 1;
  pdfState.sideSections.clear();
  pdfState.sideSignatures.clear();
  pdfState.markDraft = null;
  hideMarkButton();
  clearHighlightRegistry();
}

export async function loadTargetLang(): Promise<void> {
  try {
    const res = await callRpc({ type: 'GET_PUBLIC_SETTINGS' });
    if (res.type === 'PUBLIC_SETTINGS') {
      const target = res.settings.targetLang;
      if (typeof target === 'string' && target.trim() !== '') {
        pdfState.translationTarget = target;
      }
      updateTranslationControls();
      if (pdfState.pdfDoc) renderSidebar();
    }
  } catch (error) {
    logger.warn('pdf public settings failed', error);
  }
}
