// T-030 PDF 阅读页拆分：连续全文侧栏、块角标、双向定位与滚动联动。
// 关键行为原样保留：节签名增量重建、已就位节点不搬家、三把时间锁。

import type { PdfTextBlock } from '../../shared/pdf-text';
import { sideBodyEl, sidePageEl, sideStatusEl } from './pdf-dom';
import { applyHighlights, updateMarkControls } from './pdf-marks';
import { jumpToSourceBlock, scrollToPage } from './pdf-navigation';
import { blockScreenspace, textLayerOf } from './pdf-page-text';
import { pdfState } from './pdf-state';
import type { PageTranslationState } from './pdf-types';
import { translationErrorText } from './translation-utils';
import { setStatus } from './pdf-ui';

// ---------- T-028e 翻译侧栏 ----------

function translationBlockText(state: PageTranslationState, block: PdfTextBlock): string {
  const item = state.items.get(block.id);
  if (item?.error) return translationErrorText(item.error);
  if (item && item.text !== '') return item.text;
  if (state.status === 'done') return '（本段未返回译文）';
  if (state.status === 'error') return '（本段翻译失败）';
  if (state.status === 'stopped') return '（未翻译，已停止）';
  return '翻译中…';
}

function renderTranslationBlock(
  state: PageTranslationState,
  block: PdfTextBlock,
  index: number,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'trans-block';
  el.dataset.blockId = block.id;
  el.dataset.page = String(block.page);
  const item = state.items.get(block.id);
  if (item?.error || (!item && (state.status === 'error' || state.status === 'done'))) {
    el.classList.add('is-error');
  } else if (!item) {
    el.classList.add('is-pending');
  }
  const text = document.createElement('span');
  text.className = 'block-text';
  text.textContent = translationBlockText(state, block);
  const jump = document.createElement('button');
  jump.type = 'button';
  jump.className = 'block-jump';
  jump.textContent = String(index);
  jump.title = `定位到第 ${block.page} 页原文 · ${block.id}`;
  jump.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    jumpToSourceBlock(block);
  });
  el.append(text, jump);
  return el;
}

/** 侧栏要展示的页：已有翻译状态 + 仍在队列 + 当前页（全文模式）。 */
function sidebarPageSet(): number[] {
  const pages = new Set<number>(pdfState.pageTranslations.keys());
  for (const page of pdfState.translationQueue.toArray()) pages.add(page);
  if (pdfState.translationMode !== null) pages.add(pdfState.currentPage);
  return [...pages].sort((a, b) => a - b);
}

function sectionSignature(state: PageTranslationState | undefined, queued: boolean): string {
  if (!state) return `queued:${queued ? 1 : 0}`;
  return [
    state.status,
    state.done,
    state.total,
    state.items.size,
    state.blocks.length,
    state.error?.code ?? '',
    queued ? 1 : 0,
  ].join('|');
}

function buildPageSection(
  page: number,
  state: PageTranslationState | undefined,
  queued: boolean,
): HTMLElement {
  const section = document.createElement('section');
  section.className = 'trans-page-section';
  section.dataset.page = String(page);

  const head = document.createElement('div');
  head.className = 'trans-page-head';
  const heading = document.createElement('h2');
  heading.className = 'trans-page-title';
  heading.textContent = `第 ${page} 页`;
  const meta = document.createElement('span');
  meta.className = 'trans-page-meta';
  head.append(heading, meta);
  section.append(head);

  if (!state || state.status === 'idle') {
    meta.textContent = queued ? '排队中' : '尚未翻译';
    if (!queued) {
      const empty = document.createElement('div');
      empty.className = 'trans-empty';
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = '点击「翻译本页」开始，或点「翻译全文」按页排队。';
      empty.append(p);
      section.append(empty);
    }
    return section;
  }

  if (state.status === 'extracting') meta.textContent = '提取文本…';
  else if (state.status === 'translating') meta.textContent = `${state.done}/${state.total} 段`;
  else meta.textContent = `${state.blocks.length} 段 · ${pdfState.translationTarget}`;

  if (state.error) {
    const error = document.createElement('div');
    error.className = 'trans-error';
    error.setAttribute('role', 'alert');
    error.textContent = translationErrorText(state.error);
    section.append(error);
  }

  if (state.total > 0 && (state.status === 'translating' || state.status === 'error')) {
    const track = document.createElement('div');
    track.className = 'trans-progress';
    const bar = document.createElement('span');
    const pct = Math.min(100, Math.round((state.done / state.total) * 100));
    bar.style.width = `${pct}%`;
    track.append(bar);
    section.append(track);
  }

  if (state.blocks.length === 0) {
    const box = document.createElement('div');
    box.className = 'trans-empty';
    const p = document.createElement('p');
    p.className = 'muted';
    if (state.status === 'empty') {
      p.textContent = '本页没有可翻译文本（可能是扫描件、空白页或纯图片 PDF）。';
    } else if (state.status === 'extracting') {
      p.textContent = '正在提取文本… 只读取本地 PDF 的文本层，不上传文件。';
    } else if (state.status === 'error') {
      p.textContent = '翻译失败，可稍后重试，或先检查设置里的翻译引擎。';
    } else {
      p.textContent = '已停止，没有可显示的译文。';
    }
    box.append(p);
    section.append(box);
  } else {
    state.blocks.forEach((block, index) => {
      section.append(renderTranslationBlock(state, block, index + 1));
    });
  }
  return section;
}

/** 连续全文视图：所有有状态的页按序成为节；只重建签名变化的节，保住滚动与选区。 */
export function renderSidebar(): void {
  if (!pdfState.pdfDoc) return;
  sidePageEl.textContent = `第 ${pdfState.currentPage} 页`;
  const pages = sidebarPageSet();

  for (const [page, el] of pdfState.sideSections) {
    if (pages.includes(page)) continue;
    el.remove();
    pdfState.sideSections.delete(page);
    pdfState.sideSignatures.delete(page);
  }

  if (pages.length === 0) {
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
    updateSidebarStatus();
    updateMarkControls();
    return;
  }

  // 首次进入连续视图时移除静态空态。
  if (sideBodyEl.querySelector('.side-empty')) sideBodyEl.replaceChildren();

  const queuedPages = new Set(pdfState.translationQueue.toArray());
  const ordered: HTMLElement[] = [];
  for (const page of pages) {
    const state = pdfState.pageTranslations.get(page);
    const queued = queuedPages.has(page);
    const signature = sectionSignature(state, queued);
    let section = pdfState.sideSections.get(page);
    if (!section || pdfState.sideSignatures.get(page) !== signature) {
      const next = buildPageSection(page, state, queued);
      if (section?.isConnected) section.replaceWith(next);
      section = next;
      pdfState.sideSections.set(page, section);
      pdfState.sideSignatures.set(page, signature);
    }
    ordered.push(section);
  }
  // 只插入顺序不对的节点；已就位的节不搬家，否则每次进度刷新都会打断侧栏选区。
  let cursor: Element | null = sideBodyEl.firstElementChild;
  for (const section of ordered) {
    if (section === cursor) {
      cursor = cursor.nextElementSibling;
      continue;
    }
    sideBodyEl.insertBefore(section, cursor);
  }
  updateSidebarStatus();
  updateMarkControls();
  refreshBlockOverlays();
  applyHighlights();
}

// ---------- T-029 段落角标 / 双向定位 / 滚动联动 ----------

export function decoratePageBlocks(page: number): void {
  const el = pdfState.pageEls[page - 1];
  if (!el || !textLayerOf(page)) return;
  let overlay = el.querySelector<HTMLElement>('.itr-src-marks');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'itr-src-marks';
    el.append(overlay);
  }
  overlay.replaceChildren();
  const blocks = pdfState.pageTranslations.get(page)?.blocks ?? [];
  blocks.forEach((block, index) => {
    const box = blockScreenspace(page, block.rect);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'itr-src-mark';
    btn.textContent = String(index + 1);
    btn.title = `定位到译文 · 第 ${page} 页 ${block.id}`;
    btn.style.top = `${Math.max(0, Math.round(box.top))}px`;
    btn.style.left = `${Math.max(0, Math.round(box.left))}px`;
    btn.addEventListener('click', () => jumpToTranslation(block));
    overlay.append(btn);
  });
}

export function refreshBlockOverlays(): void {
  for (const page of pdfState.pageTranslations.keys()) decoratePageBlocks(page);
}

function scrollSidebarToPage(page: number, smooth = false): void {
  const section = pdfState.sideSections.get(page);
  if (!section) return;
  const top =
    section.getBoundingClientRect().top -
    sideBodyEl.getBoundingClientRect().top +
    sideBodyEl.scrollTop -
    6;
  pdfState.sidebarScrollLockUntil = Date.now() + 550;
  sideBodyEl.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
}

function jumpToTranslation(block: PdfTextBlock): void {
  renderSidebar();
  const section = pdfState.sideSections.get(block.page);
  const target = section?.querySelector<HTMLElement>(
    `.trans-block[data-block-id="${block.id}"]`,
  );
  if (!target) {
    setStatus(`第 ${block.page} 页还没有译文`);
    return;
  }
  const top =
    target.getBoundingClientRect().top -
    sideBodyEl.getBoundingClientRect().top +
    sideBodyEl.scrollTop -
    80;
  pdfState.sidebarScrollLockUntil = Date.now() + 700;
  sideBodyEl.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  target.classList.add('is-flash');
  window.setTimeout(() => target.classList.remove('is-flash'), 1600);
}

function sidebarPageAtTop(): number | null {
  const bodyTop = sideBodyEl.getBoundingClientRect().top;
  let best: number | null = null;
  for (const [page, section] of pdfState.sideSections) {
    const top = section.getBoundingClientRect().top - bodyTop;
    if (top <= 48 && (best === null || page > best)) best = page;
  }
  return best;
}

export function followSidebarToCurrentPage(): void {
  if (!pdfState.linkScroll) return;
  if (
    Date.now() < pdfState.sidebarUserScrollUntil ||
    Date.now() < pdfState.sidebarScrollLockUntil
  ) {
    return;
  }
  const section = pdfState.sideSections.get(pdfState.currentPage);
  if (!section) return;
  const top =
    section.getBoundingClientRect().top -
    sideBodyEl.getBoundingClientRect().top +
    sideBodyEl.scrollTop -
    6;
  if (Math.abs(top - sideBodyEl.scrollTop) < 40) return;
  scrollSidebarToPage(pdfState.currentPage);
}

export function followViewerToSidebarPage(): void {
  if (!pdfState.linkScroll) return;
  if (
    Date.now() < pdfState.viewerScrollLockUntil ||
    Date.now() < pdfState.sidebarScrollLockUntil
  ) {
    return;
  }
  const page = sidebarPageAtTop();
  if (page === null || page === pdfState.currentPage) return;
  pdfState.viewerScrollLockUntil = Date.now() + 500;
  scrollToPage(page, false);
}

export function updateSidebarStatus(): void {
  if (!pdfState.pdfDoc) {
    sideStatusEl.textContent = '';
    return;
  }
  const state = pdfState.pageTranslations.get(pdfState.currentPage);
  if (pdfState.activeTranslation) {
    if (pdfState.activeTranslation.page === pdfState.currentPage) {
      if (state?.status === 'extracting') {
        sideStatusEl.textContent = `正在提取第 ${pdfState.currentPage} 页文本…`;
      } else {
        sideStatusEl.textContent = `正在翻译第 ${pdfState.currentPage} 页 · ${
          state?.done ?? 0
        }/${state?.total ?? 0}`;
      }
    } else if (state?.status === 'done') {
      sideStatusEl.textContent = `本页已完成 · 正在翻译第 ${pdfState.activeTranslation.page} 页…`;
    } else {
      sideStatusEl.textContent = `正在翻译第 ${pdfState.activeTranslation.page} 页…`;
    }
    return;
  }
  if (pdfState.translationMode !== null) {
    sideStatusEl.textContent =
      state?.status === 'done'
        ? '本页已完成 · 正在翻译后续页面…'
        : `第 ${pdfState.currentPage} 页排队中…`;
    return;
  }
  if (!state) {
    sideStatusEl.textContent = '本地解析 · 仅发送文本块到翻译引擎';
    return;
  }
  switch (state.status) {
    case 'extracting':
      sideStatusEl.textContent = '正在提取文本…';
      break;
    case 'translating':
      sideStatusEl.textContent = `正在翻译 · ${state.done}/${state.total}`;
      break;
    case 'done':
      sideStatusEl.textContent = `翻译完成 · ${state.blocks.length} 段`;
      break;
    case 'empty':
      sideStatusEl.textContent = '本页没有可翻译文本';
      break;
    case 'error':
      sideStatusEl.textContent = '翻译失败';
      break;
    case 'stopped':
      sideStatusEl.textContent =
        state.items.size > 0 ? `已停止 · 保留 ${state.items.size} 段译文` : '已停止';
      break;
    case 'idle':
      sideStatusEl.textContent = '尚未翻译';
      break;
  }
}
