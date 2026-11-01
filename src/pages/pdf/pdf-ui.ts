// T-030 PDF 阅读页拆分：顶层状态条 / 标题 / 通知 / 加载态。

import {
  docTitleEl,
  emptyEl,
  errorEl,
  loadingEl,
  loadingTextEl,
  noticeEl,
  noticeTextEl,
  statusEl,
} from './pdf-dom';

export function setStatus(text: string): void {
  statusEl.textContent = text;
}

export function setDocTitle(title: string): void {
  docTitleEl.textContent = title;
  docTitleEl.title = title;
  document.title = `${title} · Bilinea`;
}

export function showNotice(text: string): void {
  noticeTextEl.textContent = text;
  noticeEl.hidden = false;
}

export function hideNotice(): void {
  noticeEl.hidden = true;
}

export function showLoading(text: string): void {
  loadingTextEl.textContent = text;
  emptyEl.hidden = true;
  errorEl.hidden = true;
  loadingEl.hidden = false;
}

export function hideLoading(): void {
  loadingEl.hidden = true;
}

export function hideError(): void {
  errorEl.hidden = true;
}
