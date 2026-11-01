// T-028f PDF 入口纯函数：原生查看器检测 / 阅读器 URL 构造 / 回包形状。
// 不碰 chrome/DOM，便于单测；网络与点击留在 content/popup。
import type { PdfInfoPayload } from './messaging';

/** 原生 PDF 查看器页的 document.contentType（探测实证为 application/pdf） */
export function isPdfViewer(contentType: string): boolean {
  return contentType.split(';')[0]?.trim().toLowerCase() === 'application/pdf';
}

/**
 * 构造扩展内阅读器 URL。只接受 http/https——file:// 与 blob: 无法在扩展页 fetch，
 * 返回空串让调用方隐藏入口（本地文件仍走拖入）。
 */
export function buildPdfReaderUrl(readerBaseUrl: string, pdfUrl: string): string {
  if (!readerBaseUrl) return '';
  let target: URL;
  try {
    target = new URL(pdfUrl);
  } catch {
    return '';
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return '';
  const sep = readerBaseUrl.includes('?') ? '&' : '?';
  return `${readerBaseUrl}${sep}file=${encodeURIComponent(target.href)}`;
}

export function pdfInfoOf(contentType: string, url: string): PdfInfoPayload {
  return { type: 'PDF_INFO', isPdf: isPdfViewer(contentType), url };
}
