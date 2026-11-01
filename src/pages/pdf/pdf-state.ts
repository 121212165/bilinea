// T-030 PDF 阅读页拆分：页面唯一可变状态。
// 拆分不改变状态所有权，只把原来 index.ts 顶层的 let/const 收进一个对象；
// 这样各模块可以共享同一份状态，避免循环 import 与隐式全局。

import type { PdfMark } from '../../shared/pdf-marks';
import type { PdfTextBlock } from '../../shared/pdf-text';
import type { Language } from '../../shared/types';
import type {
  MarkDraft,
  PageDims,
  PageTranslationState,
  PdfDocumentProxy,
  PdfJsModule,
  PdfLoadingTask,
} from './pdf-types';
import { PageTranslationQueue } from './translation-utils';

export interface PdfReaderState {
  // PDF / 渲染
  pdfjs: PdfJsModule | null;
  loadingTask: PdfLoadingTask | null;
  pdfDoc: PdfDocumentProxy | null;
  pageCount: number;
  currentPage: number;
  scale: number;
  autoFit: boolean;
  firstPageDims: PageDims;
  pageDims: Map<number, PageDims>;
  pageEls: HTMLDivElement[];
  renderedPages: Set<number>;
  /** page → 调度时的 renderEpoch；epoch 变化后旧调度不会误删新调度 */
  pendingPages: Map<number, number>;
  renderQueue: number[];
  activeRenders: number;
  renderEpoch: number;
  loadToken: number;
  loadAbort: AbortController | null;
  currentFileUrl: string | null;
  currentFile: File | null;
  scrollRaf: number;
  sidebarRaf: number;
  resizeTimer: number;
  dragDepth: number;

  // 翻译 / 侧栏
  pageTranslations: Map<number, PageTranslationState>;
  pageTextCache: Map<number, PdfTextBlock[]>;
  pageTextPending: Map<number, Promise<PdfTextBlock[]>>;
  translationQueue: PageTranslationQueue;
  translationTarget: Language;
  translationMode: 'page' | 'all' | null;
  activeTranslation: { page: number; requestId: string; token: number } | null;
  translationToken: number;
  translationSeq: number;
  sideSections: Map<number, HTMLElement>;
  sideSignatures: Map<number, string>;

  // 标记 / 偏好 / 滚动锁
  docKey: string;
  marks: PdfMark[];
  syncMarks: boolean;
  linkScroll: boolean;
  repoLoaded: boolean;
  marksSaveTimer: number;
  /** 待写入快照带上文档键：换文档后延迟写入不会把新文档的标记写进旧键，反之亦然。 */
  pendingSave: { key: string; marks: PdfMark[] } | null;
  sidebarUserScrollUntil: number;
  /** 程序化滚动期间抑制反向联动，避免两边互相拉扯 */
  sidebarScrollLockUntil: number;
  viewerScrollLockUntil: number;
  /** 平滑跳页动画期间以目标页为准；scrollend 解锁 */
  navScrollUntil: number;
  markDraft: MarkDraft | null;
  markHideTimer: number;

  /** pdf-navigation 通过它回调 viewer.updatePageUi，避免 navigation ↔ viewer 循环依赖。 */
  onPageChanged: (() => void) | null;
}

export function createPdfState(): PdfReaderState {
  return {
    pdfjs: null,
    loadingTask: null,
    pdfDoc: null,
    pageCount: 0,
    currentPage: 1,
    scale: 1,
    autoFit: true,
    firstPageDims: { width: 612, height: 792 },
    pageDims: new Map(),
    pageEls: [],
    renderedPages: new Set(),
    pendingPages: new Map(),
    renderQueue: [],
    activeRenders: 0,
    renderEpoch: 0,
    loadToken: 0,
    loadAbort: null,
    currentFileUrl: null,
    currentFile: null,
    scrollRaf: 0,
    sidebarRaf: 0,
    resizeTimer: 0,
    dragDepth: 0,
    pageTranslations: new Map(),
    pageTextCache: new Map(),
    pageTextPending: new Map(),
    translationQueue: new PageTranslationQueue(),
    translationTarget: 'zh-CN',
    translationMode: null,
    activeTranslation: null,
    translationToken: 0,
    translationSeq: 0,
    sideSections: new Map(),
    sideSignatures: new Map(),
    docKey: '',
    marks: [],
    syncMarks: true,
    linkScroll: true,
    repoLoaded: false,
    marksSaveTimer: 0,
    pendingSave: null,
    sidebarUserScrollUntil: 0,
    sidebarScrollLockUntil: 0,
    viewerScrollLockUntil: 0,
    navScrollUntil: 0,
    markDraft: null,
    markHideTimer: 0,
    onPageChanged: null,
  };
}

export const pdfState = createPdfState();
