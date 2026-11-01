// T-030 PDF 阅读页拆分：类型、常量与错误基类。
// 这里只放无副作用的类型/常量；页面状态在 pdf-state.ts。

import type { PdfMarkSide } from '../../shared/pdf-marks';
import type { PdfTextBlock } from '../../shared/pdf-text';
import type { ProviderError, TranslatedSegment } from '../../shared/types';

export interface PdfViewport {
  width: number;
  height: number;
  scale: number;
}

export interface PdfRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

export interface PdfTextContent {
  items: readonly unknown[];
}

export interface PdfPageProxy {
  getViewport(params: { scale: number }): PdfViewport;
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewport;
    transform?: number[];
  }): PdfRenderTask;
  getTextContent(params?: {
    includeMarkedContent?: boolean;
    disableNormalization?: boolean;
  }): Promise<PdfTextContent>;
  streamTextContent(params?: {
    includeMarkedContent?: boolean;
    disableNormalization?: boolean;
  }): ReadableStream;
  cleanup(): void;
}

export interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageProxy>;
}

export interface PdfLoadingTask {
  promise: Promise<PdfDocumentProxy>;
  destroy(): Promise<void>;
  onProgress?: (progress: { loaded: number; total: number }) => void;
}

export interface PdfTextLayer {
  render(): Promise<void>;
  cancel(): void;
  readonly textContentItemsStr: string[];
}

export interface PdfJsModule {
  getDocument(src: {
    data: Uint8Array;
    cMapUrl: string;
    cMapPacked: boolean;
    standardFontDataUrl: string;
  }): PdfLoadingTask;
  GlobalWorkerOptions: { workerSrc: string };
  TextLayer: new (options: {
    textContentSource: ReadableStream;
    container: HTMLElement;
    viewport: PdfViewport;
  }) => PdfTextLayer;
}

export interface PageDims {
  width: number;
  height: number;
}

export type PageTranslationStatus =
  | 'idle'
  | 'extracting'
  | 'translating'
  | 'done'
  | 'empty'
  | 'error'
  | 'stopped';

export interface PageTranslationState {
  page: number;
  status: PageTranslationStatus;
  blocks: PdfTextBlock[];
  items: Map<string, TranslatedSegment>;
  total: number;
  done: number;
  error: ProviderError | null;
}

export interface MarkDraft {
  side: PdfMarkSide;
  page: number;
  blockId: string;
  text: string;
  start: number;
  end: number;
  existingId?: string;
}

export class LoadError extends Error {
  readonly title: string;

  constructor(title: string, message: string) {
    super(message);
    this.name = 'LoadError';
    this.title = title;
  }
}

export const MAX_PDF_BYTES = 200 * 1024 * 1024;
export const MAX_DPR = 2;
export const RENDER_CONCURRENCY = 2;
/** 当前页前后保留已渲染页的页数；更远的页释放 canvas，防止 100 页文档常驻内存 */
export const RENDER_KEEP_DISTANCE = 4;

export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || 'Error';
  return typeof error;
}
