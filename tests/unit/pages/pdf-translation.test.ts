import { describe, expect, it } from 'vitest';
import {
  PageTranslationQueue,
  blocksToSegments,
  pdfTextItemsFromContent,
  translationErrorText,
} from '../../../src/pages/pdf/translation-utils';
import type { PdfTextBlock } from '../../../src/shared/pdf-text';
import type { ProviderError } from '../../../src/shared/types';

const validItem = {
  str: 'Hello',
  transform: [12, 0, 0, 12, 40, 700],
  width: 30,
  height: 12,
  dir: 'ltr',
  fontName: 'g_d0_f1',
  hasEOL: true,
};

function block(id: string, text: string): PdfTextBlock {
  return {
    id,
    page: 1,
    column: 1,
    text,
    lineCount: 1,
    rect: { x: 0, y: 700, width: 100, height: 12 },
  };
}

describe('T-028e PDF 翻译纯函数', () => {
  it('getTextContent items → PdfTextItem：过滤非文本/空文本/残缺 transform', () => {
    const items = pdfTextItemsFromContent({
      items: [
        validItem,
        { str: '', transform: [12, 0, 0, 12, 0, 0], width: 500 },
        { str: '   ', transform: [12, 0, 0, 12, 0, 0], width: 500 },
        { type: 'beginMarkedContent', tag: 'P' },
        { str: 'bad transform', transform: [12, 0, 0, 12, 0], width: 10 },
        { str: 'non-finite', transform: [12, 0, 0, 12, 0, Number.NaN], width: 10 },
      ],
    });
    expect(items).toEqual([
      {
        str: 'Hello',
        transform: [12, 0, 0, 12, 40, 700],
        width: 30,
        height: 12,
        dir: 'ltr',
        fontName: 'g_d0_f1',
        hasEOL: true,
      },
    ]);
  });

  it('宽高缺失时从 transform 推导，非法输入整体返回空数组', () => {
    const items = pdfTextItemsFromContent({
      items: [{ str: 'No metrics', transform: [9, 0, 0, 9, 1, 2] }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ width: 0, height: 9 });
    expect(pdfTextItemsFromContent(null)).toEqual([]);
    expect(pdfTextItemsFromContent({ items: 'nope' })).toEqual([]);
  });

  it('blocksToSegments 只保留稳定 id 与文本', () => {
    expect(blocksToSegments([block('p1-c1-b0', 'First'), block('p1-c1-b1', 'Second')])).toEqual([
      { id: 'p1-c1-b0', text: 'First' },
      { id: 'p1-c1-b1', text: 'Second' },
    ]);
  });

  it('错误码文案：缺 Key / 限流（含 retryAfterMs）/ 超时 / 引擎不可用 / 取消', () => {
    expect(translationErrorText({ code: 'E_NO_KEY' })).toContain('API Key');
    expect(translationErrorText({ code: 'E_RATE_LIMITED', retryAfterMs: 2400 })).toContain(
      '3 秒',
    );
    expect(translationErrorText({ code: 'E_RATE_LIMITED' })).toContain('稍后重试');
    expect(translationErrorText({ code: 'E_TIMEOUT' })).toContain('超时');
    expect(translationErrorText({ code: 'E_PROVIDER_DOWN', detail: 'x' })).toContain(
      '暂不可用',
    );
    expect(translationErrorText({ code: 'E_ABORTED' })).toContain('已停止');
    expect(translationErrorText(undefined)).toBe('');
  });

  it('页面队列去重、插队、取出与清理', () => {
    const queue = new PageTranslationQueue();
    expect(queue.enqueue(3)).toBe(true);
    expect(queue.enqueue(5)).toBe(true);
    expect(queue.enqueue(3)).toBe(false);
    expect(queue.enqueue(1, true)).toBe(true);
    expect(queue.toArray()).toEqual([1, 3, 5]);
    expect(queue.take()).toBe(1);
    expect(queue.take()).toBe(3);
    expect(queue.size).toBe(1);
    expect(queue.has(5)).toBe(true);
    queue.remove(5);
    expect(queue.take()).toBeNull();
    queue.enqueue(2);
    queue.clear();
    expect(queue.size).toBe(0);
  });

  it('页面队列拒绝非法页码', () => {
    const queue = new PageTranslationQueue();
    expect(queue.enqueue(0)).toBe(false);
    expect(queue.enqueue(-1)).toBe(false);
    expect(queue.enqueue(1.5)).toBe(false);
    expect(queue.size).toBe(0);
  });

  it('错误对象本身为空时返回空文案', () => {
    const none: ProviderError | null = null;
    expect(translationErrorText(none)).toBe('');
  });
});
