// T-029 PDF 阅读页高亮标记：纯函数（存储形状、文档键、偏移寻址）。
// 偏移口径：一律使用「去掉所有空白后的块内字符序号」，避免原文/译文换行差异导致锚点漂移。
// 不 import pdfjs、不碰 DOM，便于单测；渲染留在 pdf/index.ts。

export type PdfMarkSide = 'src' | 'dst';

export interface PdfMark {
  id: string;
  side: PdfMarkSide;
  page: number;
  blockId: string;
  /** 选中文字的原样（用于提示与重新定位）；长度上限 MAX_MARK_TEXT */
  text: string;
  start: number;
  end: number;
  createdAt: number;
  /** 同步标记：两侧各一条，pairId 相同；删除一侧会连带删除对侧 */
  pairId?: string;
}

export interface PdfMarkStore {
  version: 1;
  marks: PdfMark[];
}

export interface PdfDocIdentity {
  url?: string | null;
  file?: { name: string; size: number; lastModified: number } | null;
}

export const PDF_MARKS_STORAGE_KEY = 'itr-pdf-marks';
export const PDF_PREFS_STORAGE_KEY = 'itr-pdf-prefs';
export const PDF_MARKS_VERSION = 1 as const;
export const MAX_MARKS_PER_DOC = 400;
export const MAX_MARK_TEXT = 2000;

const SIDES: readonly PdfMarkSide[] = ['src', 'dst'];

/** 文档键：远程用 URL；本地拖入用 名称+大小+修改时间（不落路径）。 */
export function pdfDocKey(identity: PdfDocIdentity): string {
  const url = typeof identity.url === 'string' ? identity.url.trim() : '';
  if (url !== '') return `url:${url}`;
  const file = identity.file;
  if (file && typeof file.name === 'string' && file.name !== '') {
    const size = Number.isFinite(file.size) ? Math.max(0, Math.floor(file.size)) : 0;
    const mtime = Number.isFinite(file.lastModified) ? Math.max(0, Math.floor(file.lastModified)) : 0;
    return `file:${file.name}:${size}:${mtime}`;
  }
  return '';
}

export function normalizeMarkText(text: string): string {
  return text.replace(/\s+/g, '');
}

function finiteInt(value: unknown, min: number): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.floor(value))
    : null;
}

export function sanitizeMark(raw: unknown): PdfMark | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const side = record.side;
  if (side !== 'src' && side !== 'dst') return null;
  const rawPage = record.page;
  if (typeof rawPage !== 'number' || !Number.isFinite(rawPage) || rawPage < 1) return null;
  const page = Math.floor(rawPage);
  const blockId = typeof record.blockId === 'string' ? record.blockId.trim() : '';
  if (blockId === '') return null;
  const text = typeof record.text === 'string' ? record.text.slice(0, MAX_MARK_TEXT) : '';
  if (normalizeMarkText(text) === '') return null;
  const start = finiteInt(record.start, 0);
  const end = finiteInt(record.end, 0);
  if (start === null || end === null || end <= start) return null;
  const createdAt = finiteInt(record.createdAt, 0) ?? 0;
  const id = typeof record.id === 'string' && record.id !== '' ? record.id : newMarkId(createdAt);
  const pairId =
    typeof record.pairId === 'string' && record.pairId !== '' ? record.pairId : undefined;
  const mark: PdfMark = { id, side, page, blockId, text, start, end, createdAt };
  if (pairId) mark.pairId = pairId;
  return mark;
}

export function sanitizeMarkStore(raw: unknown): PdfMarkStore {
  if (typeof raw !== 'object' || raw === null) return { version: PDF_MARKS_VERSION, marks: [] };
  const record = raw as Record<string, unknown>;
  const list = Array.isArray(record.marks) ? record.marks : [];
  const marks: PdfMark[] = [];
  for (const item of list) {
    const mark = sanitizeMark(item);
    if (mark) marks.push(mark);
  }
  marks.sort((a, b) => a.createdAt - b.createdAt);
  return { version: PDF_MARKS_VERSION, marks: marks.slice(-MAX_MARKS_PER_DOC) };
}

export function newMarkId(now = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `mk-${now.toString(36)}-${rand}`;
}

/** 新增/覆盖同 id 标记；超出上限时丢最旧。 */
export function upsertMark(marks: readonly PdfMark[], mark: PdfMark): PdfMark[] {
  const next = marks.filter((item) => item.id !== mark.id);
  next.push(mark);
  next.sort((a, b) => a.createdAt - b.createdAt);
  return next.slice(-MAX_MARKS_PER_DOC);
}

/** 删除指定 id（以及它们的同步对侧）。 */
export function removeMarks(marks: readonly PdfMark[], ids: ReadonlySet<string>): PdfMark[] {
  if (ids.size === 0) return marks.slice();
  const pairIds = new Set<string>();
  for (const mark of marks) {
    if (mark.pairId && ids.has(mark.id)) pairIds.add(mark.pairId);
  }
  return marks.filter((mark) => {
    if (ids.has(mark.id)) return false;
    if (mark.pairId && pairIds.has(mark.pairId)) return false;
    return true;
  });
}

export function marksForSide(
  marks: readonly PdfMark[],
  side: PdfMarkSide,
  page?: number,
): PdfMark[] {
  return marks.filter((mark) => mark.side === side && (page === undefined || mark.page === page));
}

/** 归一化坐标里找选中文字；先按提示位置向后找，再全文找。 */
export function locateMarkText(
  blockText: string,
  text: string,
  hintStart: number,
): { start: number; end: number } | null {
  const hay = normalizeMarkText(blockText);
  const needle = normalizeMarkText(text);
  if (needle === '' || hay.length < needle.length) return null;
  const hint = Number.isFinite(hintStart)
    ? Math.max(0, Math.min(Math.floor(hintStart), Math.max(0, hay.length - 1)))
    : 0;
  const after = hay.indexOf(needle, hint);
  const index = after >= 0 ? after : hay.indexOf(needle);
  if (index < 0) return null;
  return { start: index, end: index + needle.length };
}

/** 命中测试：同一侧、同一块、偏移落在标记范围内。 */
export function findMarkAt(
  marks: readonly PdfMark[],
  side: PdfMarkSide,
  blockId: string,
  offset: number,
): PdfMark | null {
  for (const mark of marks) {
    if (mark.side !== side || mark.blockId !== blockId) continue;
    if (offset >= mark.start && offset < mark.end) return mark;
  }
  return null;
}

export function sideLabel(side: PdfMarkSide): string {
  return side === 'src' ? '原文' : '译文';
}

export function isPdfMarkSide(value: unknown): value is PdfMarkSide {
  return SIDES.includes(value as PdfMarkSide);
}
