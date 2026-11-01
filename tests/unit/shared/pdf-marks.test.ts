// T-029 PDF 标记纯函数单测：文档键、存储清洗、偏移寻址、同步对删除。
import { describe, expect, it } from 'vitest';
import {
  MAX_MARKS_PER_DOC,
  findMarkAt,
  locateMarkText,
  marksForSide,
  normalizeMarkText,
  pdfDocKey,
  removeMarks,
  sanitizeMark,
  sanitizeMarkStore,
  sideLabel,
  upsertMark,
  type PdfMark,
} from '../../../src/shared/pdf-marks';

function mark(overrides: Partial<PdfMark> = {}): PdfMark {
  return {
    id: 'mk-1',
    side: 'src',
    page: 1,
    blockId: 'p1-c1-b1',
    text: 'Hello world',
    start: 0,
    end: 10,
    createdAt: 1000,
    ...overrides,
  };
}

describe('pdfDocKey', () => {
  it('远程文档用完整 URL 作键，空白 URL 不生效', () => {
    expect(pdfDocKey({ url: ' https://arxiv.org/pdf/2501.00001 ' })).toBe(
      'url:https://arxiv.org/pdf/2501.00001',
    );
    expect(pdfDocKey({ url: '   ', file: null })).toBe('');
  });

  it('本地文件用 名称+大小+修改时间，URL 优先', () => {
    const file = { name: 'paper.pdf', size: 2048, lastModified: 1730000000000 };
    expect(pdfDocKey({ file })).toBe('file:paper.pdf:2048:1730000000000');
    expect(pdfDocKey({ url: 'https://a/b.pdf', file })).toBe('url:https://a/b.pdf');
  });

  it('非法大小/时间归零，缺文件名返回空键', () => {
    expect(pdfDocKey({ file: { name: 'a.pdf', size: Number.NaN, lastModified: -5 } })).toBe(
      'file:a.pdf:0:0',
    );
    expect(pdfDocKey({ file: { name: '', size: 1, lastModified: 1 } })).toBe('');
    expect(pdfDocKey({})).toBe('');
  });
});

describe('sanitizeMark', () => {
  it('去掉所有空白后比较文本，空文本视为无效', () => {
    expect(normalizeMarkText(' a b\tc\n')).toBe('abc');
    expect(sanitizeMark({ ...mark({ text: '  \n ' }) })).toBeNull();
  });

  it('拒绝非法 side / page / blockId / 偏移区间', () => {
    expect(sanitizeMark(null)).toBeNull();
    expect(sanitizeMark({ ...mark(), side: 'both' })).toBeNull();
    expect(sanitizeMark({ ...mark(), page: 0 })).toBeNull();
    expect(sanitizeMark({ ...mark(), blockId: '  ' })).toBeNull();
    expect(sanitizeMark({ ...mark(), start: 5, end: 5 })).toBeNull();
    expect(sanitizeMark({ ...mark(), start: 'x' })).toBeNull();
  });

  it('保留可选 pairId，缺失时补 id', () => {
    const paired = sanitizeMark({ ...mark(), pairId: 'pair-9' });
    expect(paired?.pairId).toBe('pair-9');
    const unknownId = sanitizeMark({ ...mark(), id: '' });
    expect(unknownId?.id.startsWith('mk-')).toBe(true);
  });
});

describe('sanitizeMarkStore', () => {
  it('丢弃脏数据并按创建时间排序', () => {
    const store = sanitizeMarkStore({
      marks: [mark({ id: 'b', createdAt: 2000 }), { nope: true }, mark({ id: 'a', createdAt: 1000 })],
    });
    expect(store.version).toBe(1);
    expect(store.marks.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('超过上限时保留最新的 MAX_MARKS_PER_DOC 条', () => {
    const many = Array.from({ length: MAX_MARKS_PER_DOC + 5 }, (_, index) =>
      mark({ id: `m${index}`, createdAt: index }),
    );
    const store = sanitizeMarkStore({ marks: many });
    expect(store.marks).toHaveLength(MAX_MARKS_PER_DOC);
    expect(store.marks[0]?.id).toBe('m5');
  });

  it('非对象输入返回空仓库', () => {
    expect(sanitizeMarkStore('nope')).toEqual({ version: 1, marks: [] });
  });
});

describe('upsertMark / removeMarks / marksForSide', () => {
  it('同 id 覆盖且保持按时间排序', () => {
    const next = upsertMark(
      [mark({ id: 'a', createdAt: 1 }), mark({ id: 'b', createdAt: 2 })],
      mark({ id: 'c', createdAt: 3 }),
    );
    expect(next.map((item) => item.id)).toEqual(['a', 'b', 'c']);
    const replaced = upsertMark(next, mark({ id: 'b', createdAt: 2, text: 'new' }));
    expect(replaced).toHaveLength(3);
    expect(replaced.find((item) => item.id === 'b')?.text).toBe('new');
  });

  it('删一侧时连带删除同 pairId 的对侧', () => {
    const marks = [
      mark({ id: 'src-1', pairId: 'pr-1' }),
      mark({ id: 'dst-1', side: 'dst', pairId: 'pr-1' }),
      mark({ id: 'free' }),
    ];
    const left = removeMarks(marks, new Set(['src-1']));
    expect(left.map((item) => item.id)).toEqual(['free']);
  });

  it('空 id 集合原样返回副本，按侧与页过滤', () => {
    const marks = [mark({ id: 'a' }), mark({ id: 'b', side: 'dst', page: 2 })];
    expect(removeMarks(marks, new Set())).not.toBe(marks);
    expect(marksForSide(marks, 'dst').map((item) => item.id)).toEqual(['b']);
    expect(marksForSide(marks, 'dst', 1)).toEqual([]);
    expect(sideLabel('src')).toBe('原文');
    expect(sideLabel('dst')).toBe('译文');
  });
});

describe('locateMarkText / findMarkAt', () => {
  it('忽略空白差异重新定位，优先从提示位置向后找', () => {
    const blockText = 'Alpha beta gamma beta';
    expect(locateMarkText(blockText, 'betagamma', 0)).toEqual({ start: 5, end: 14 });
    expect(locateMarkText(blockText, 'beta', 10)).toEqual({ start: 14, end: 18 });
    expect(locateMarkText(blockText, 'beta', 999)).toEqual({ start: 5, end: 9 });
  });

  it('找不到或空串返回 null', () => {
    expect(locateMarkText('abc', 'zzz', 0)).toBeNull();
    expect(locateMarkText('abc', '  ', 0)).toBeNull();
    expect(locateMarkText('ab', 'abc', 0)).toBeNull();
  });

  it('命中测试只看同侧同块且偏移落在区间内', () => {
    const marks = [
      mark({ id: 's', start: 10, end: 20 }),
      mark({ id: 'd', side: 'dst', start: 10, end: 20 }),
    ];
    expect(findMarkAt(marks, 'src', 'p1-c1-b1', 15)?.id).toBe('s');
    expect(findMarkAt(marks, 'src', 'p1-c1-b1', 20)).toBeNull();
    expect(findMarkAt(marks, 'dst', 'p1-c1-b1', 12)?.id).toBe('d');
    expect(findMarkAt(marks, 'src', 'p1-c1-b2', 12)).toBeNull();
  });
});
