// T-028c PDF 阅读页纯函数：URL 参数校验、缩放收口、标题解析。
// 故意不 import pdfjs：Vitest 保持轻量，页面运行时才动态加载 pdf/pdf.min.mjs。

export const PDF_MIN_SCALE = 0.5;
export const PDF_MAX_SCALE = 3;

export type PdfSourceParam =
  | { kind: 'none' }
  | { kind: 'bad'; raw: string }
  | { kind: 'ok'; url: string };

/** 只接受显式 http/https；不做 file:// 自动读取（本地文件走拖入/选择）。 */
export function parsePdfSource(search: string): PdfSourceParam {
  const raw = new URLSearchParams(search).get('file')?.trim() ?? '';
  if (!raw) return { kind: 'none' };
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { kind: 'bad', raw };
    }
    return { kind: 'ok', url: url.toString() };
  } catch {
    return { kind: 'bad', raw };
  }
}

/** 非有限值回 1；两位小数，范围 [0.5, 3]。 */
export function clampPdfScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  const rounded = Math.round(value * 100) / 100;
  return Math.min(PDF_MAX_SCALE, Math.max(PDF_MIN_SCALE, rounded));
}

export function stepPdfScale(scale: number, delta: number): number {
  return clampPdfScale(scale + delta);
}

export function formatPdfPercent(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/**
 * 适应宽度：容器宽减去左右留白后除以页面基准宽。
 * 容器/页宽异常时回 1，避免 NaN 把 CSS 写坏。
 */
export function fitPdfScale(containerWidth: number, pageWidth: number): number {
  if (!Number.isFinite(containerWidth) || !Number.isFinite(pageWidth) || pageWidth <= 0) {
    return 1;
  }
  const padding = 56;
  return clampPdfScale(Math.max(0, containerWidth - padding) / pageWidth);
}

/** 从 URL 取末段作标题；解码失败/无路径时回退 hostname 或 PDF。 */
export function pdfTitleFromUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const last = url.pathname.split('/').filter(Boolean).pop() ?? '';
    if (!last) return url.hostname || 'PDF';
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    return 'PDF';
  }
}
