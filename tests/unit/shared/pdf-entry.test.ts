// T-028f：原生 PDF 检测 / 阅读器 URL / PDF_INFO 回包纯函数
import { describe, expect, it } from 'vitest';
import { buildPdfReaderUrl, isPdfViewer, pdfInfoOf } from '../../../src/shared/pdf-entry';

describe('isPdfViewer', () => {
  it('application/pdf 命中（含 charset 与大小写/空白）', () => {
    expect(isPdfViewer('application/pdf')).toBe(true);
    expect(isPdfViewer('application/pdf; charset=binary')).toBe(true);
    expect(isPdfViewer('  Application/PDF  ')).toBe(true);
  });

  it('HTML / 空串 / PDF 前缀伪装都不算', () => {
    expect(isPdfViewer('text/html')).toBe(false);
    expect(isPdfViewer('')).toBe(false);
    expect(isPdfViewer('application/pdfx')).toBe(false);
    expect(isPdfViewer('application/json')).toBe(false);
  });
});

describe('buildPdfReaderUrl', () => {
  const base = 'chrome-extension://abc/pdf/index.html';

  it('http/https → 阅读器 URL 携带编码后的 file 参数', () => {
    expect(buildPdfReaderUrl(base, 'https://arxiv.org/pdf/1706.03762')).toBe(
      `${base}?file=${encodeURIComponent('https://arxiv.org/pdf/1706.03762')}`,
    );
    expect(buildPdfReaderUrl(base, 'http://x.com/a b.pdf')).toBe(
      `${base}?file=${encodeURIComponent('http://x.com/a%20b.pdf')}`,
    );
  });

  it('base 已有查询串 → 用 & 追加', () => {
    const withQuery = 'chrome-extension://abc/pdf/index.html?theme=dark';
    expect(buildPdfReaderUrl(withQuery, 'https://x.com/a.pdf')).toBe(
      `${withQuery}&file=${encodeURIComponent('https://x.com/a.pdf')}`,
    );
  });

  it('file:// / blob: / chrome-extension: / 非法 URL / 空 base → 空串（本地文件走拖入）', () => {
    expect(buildPdfReaderUrl(base, 'file:///C:/a.pdf')).toBe('');
    expect(buildPdfReaderUrl(base, 'blob:https://x.com/uuid')).toBe('');
    expect(buildPdfReaderUrl(base, 'chrome-extension://abc/x.pdf')).toBe('');
    expect(buildPdfReaderUrl(base, 'not a url')).toBe('');
    expect(buildPdfReaderUrl(base, '')).toBe('');
    expect(buildPdfReaderUrl('', 'https://x.com/a.pdf')).toBe('');
  });
});

describe('pdfInfoOf', () => {
  it('isPdf 由 contentType 决定，url 原样带回', () => {
    expect(pdfInfoOf('application/pdf', 'https://x.com/a.pdf')).toEqual({
      type: 'PDF_INFO',
      isPdf: true,
      url: 'https://x.com/a.pdf',
    });
    expect(pdfInfoOf('text/html', 'https://x.com/')).toEqual({
      type: 'PDF_INFO',
      isPdf: false,
      url: 'https://x.com/',
    });
  });
});
