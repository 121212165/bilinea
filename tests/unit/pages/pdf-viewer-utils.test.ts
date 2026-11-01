// T-028c PDF 阅读页纯函数单测（不 import pdfjs，node 环境即可）。
import { describe, expect, it } from 'vitest';
import {
  clampPdfScale,
  fitPdfScale,
  formatPdfPercent,
  parsePdfSource,
  pdfTitleFromUrl,
  stepPdfScale,
} from '../../../src/pages/pdf/viewer-utils';

describe('parsePdfSource', () => {
  it('缺省/空白 → none', () => {
    expect(parsePdfSource('')).toEqual({ kind: 'none' });
    expect(parsePdfSource('?file=')).toEqual({ kind: 'none' });
    expect(parsePdfSource('?file=%20%20')).toEqual({ kind: 'none' });
  });

  it('http/https 通过并规范化', () => {
    expect(parsePdfSource('?file=https://example.com/a.pdf')).toEqual({
      kind: 'ok',
      url: 'https://example.com/a.pdf',
    });
    expect(parsePdfSource('?file=http%3A%2F%2Fexample.com%2Fb.pdf%23page%3D2')).toEqual({
      kind: 'ok',
      url: 'http://example.com/b.pdf#page=2',
    });
  });

  it('非 http(s) 协议拒绝（file/data/javascript）', () => {
    expect(parsePdfSource('?file=file%3A%2F%2F%2FC%3A%2Ftmp%2Fa.pdf').kind).toBe('bad');
    expect(parsePdfSource('?file=data%3Aapplication%2Fpdf%3Bbase64%2CAAAA').kind).toBe('bad');
    expect(parsePdfSource('?file=javascript%3Aalert(1)').kind).toBe('bad');
  });

  it('非法 URL 拒绝', () => {
    expect(parsePdfSource('?file=not-a-url')).toEqual({ kind: 'bad', raw: 'not-a-url' });
  });
});

describe('clampPdfScale / stepPdfScale', () => {
  it('范围收口与两位小数', () => {
    expect(clampPdfScale(0.1)).toBe(0.5);
    expect(clampPdfScale(9)).toBe(3);
    expect(clampPdfScale(1.234)).toBe(1.23);
  });

  it('NaN/Infinity → 1', () => {
    expect(clampPdfScale(Number.NaN)).toBe(1);
    expect(clampPdfScale(Number.POSITIVE_INFINITY)).toBe(1);
  });

  it('步进不越界', () => {
    expect(stepPdfScale(2.95, 0.1)).toBe(3);
    expect(stepPdfScale(0.55, -0.1)).toBe(0.5);
  });

  it('百分比取整', () => {
    expect(formatPdfPercent(1)).toBe('100%');
    expect(formatPdfPercent(1.236)).toBe('124%');
  });
});

describe('fitPdfScale', () => {
  it('按容器宽减留白计算', () => {
    expect(fitPdfScale(1056, 612)).toBe(1.63); // (1056-56)/612
  });

  it('容器/页宽异常 → 1', () => {
    expect(fitPdfScale(0, 612)).toBe(0.5);
    expect(fitPdfScale(Number.NaN, 612)).toBe(1);
    expect(fitPdfScale(800, 0)).toBe(1);
  });
});

describe('pdfTitleFromUrl', () => {
  it('取末段并解码', () => {
    expect(pdfTitleFromUrl('https://example.com/papers/1706.03762.pdf')).toBe('1706.03762.pdf');
    expect(pdfTitleFromUrl('https://example.com/%E8%AE%BA%E6%96%87.pdf')).toBe('论文.pdf');
  });

  it('无路径 → hostname；非法 → PDF', () => {
    expect(pdfTitleFromUrl('https://example.com/')).toBe('example.com');
    expect(pdfTitleFromUrl('not a url')).toBe('PDF');
  });
});
