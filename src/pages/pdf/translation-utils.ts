// T-028e PDF 翻译纯函数：pdf.js getTextContent() 映射 + 页面队列 + 错误文案。
// 不碰 DOM/chrome，方便单测；网络与渲染留在 index.ts。

import type { PdfTextBlock, PdfTextItem } from '../../shared/pdf-text';
import type { ProviderError, Segment } from '../../shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * pdf.js 的 getTextContent().items 混合了 TextItem 与 marked-content。
 * 只保留有文本、有 6 位 transform 的 TextItem；空/纯空格项直接丢弃，
 * 否则它们的宽度会污染 T-028d 的栏缝与行宽统计。
 */
export function pdfTextItemsFromContent(content: unknown): PdfTextItem[] {
  if (!isRecord(content) || !Array.isArray(content.items)) return [];
  const out: PdfTextItem[] = [];
  for (const raw of content.items) {
    if (!isRecord(raw)) continue;
    const str = typeof raw.str === 'string' ? raw.str : '';
    if (str.trim() === '') continue;

    const transformRaw = raw.transform;
    if (!Array.isArray(transformRaw) || transformRaw.length < 6) continue;
    const transform: number[] = [];
    let transformOk = true;
    for (let i = 0; i < 6; i++) {
      const n = finiteNumber(transformRaw[i]);
      if (n === null) {
        transformOk = false;
        break;
      }
      transform.push(n);
    }
    if (!transformOk) continue;

    const width = finiteNumber(raw.width) ?? 0;
    const rawHeight = finiteNumber(raw.height);
    const height =
      rawHeight !== null && rawHeight > 0
        ? rawHeight
        : Math.max(1, Math.abs(transform[3]) || 10);
    const item: PdfTextItem = { str, transform, width, height };
    if (typeof raw.dir === 'string') item.dir = raw.dir;
    if (typeof raw.fontName === 'string') item.fontName = raw.fontName;
    if (typeof raw.hasEOL === 'boolean') item.hasEOL = raw.hasEOL;
    out.push(item);
  }
  return out;
}

/** 只发文本块（含稳定 block id），不把坐标/整份 PDF 送进 SW。 */
export function blocksToSegments(blocks: readonly PdfTextBlock[]): Segment[] {
  return blocks.map((block) => ({ id: block.id, text: block.text }));
}

/** PDF 侧栏错误码文案；比 content 的 tipbar 多处理 retryAfterMs。 */
export function translationErrorText(error: ProviderError | null | undefined): string {
  if (!error) return '';
  switch (error.code) {
    case 'E_NO_KEY':
      return '未配置翻译引擎：请到设置页填写 OpenAI 兼容 API Key，或启用免费引擎。';
    case 'E_RATE_LIMITED': {
      const ms = error.retryAfterMs;
      if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) {
        const seconds = Math.max(1, Math.ceil(ms / 1000));
        return `引擎限流，请约 ${seconds} 秒后重试。`;
      }
      return '引擎限流，请稍后重试。';
    }
    case 'E_TIMEOUT':
      return '翻译请求超时，请稍后重试。';
    case 'E_PROVIDER_DOWN':
      return '翻译引擎暂不可用，请检查设置或稍后重试。';
    case 'E_ABORTED':
      return '翻译已停止。';
    case 'E_NO_GESTURE':
      return '翻译引擎暂不可用，请稍后重试。';
    default:
      return '翻译失败，请稍后重试。';
  }
}

/** 页面级串行队列：去重、支持当前页插队、只由 UI 单线程消费。 */
export class PageTranslationQueue {
  private pages: number[] = [];

  enqueue(page: number, front = false): boolean {
    if (!Number.isInteger(page) || page < 1 || this.pages.includes(page)) return false;
    if (front) this.pages.unshift(page);
    else this.pages.push(page);
    return true;
  }

  take(): number | null {
    return this.pages.shift() ?? null;
  }

  remove(page: number): void {
    this.pages = this.pages.filter((p) => p !== page);
  }

  has(page: number): boolean {
    return this.pages.includes(page);
  }

  clear(): void {
    this.pages = [];
  }

  get size(): number {
    return this.pages.length;
  }

  toArray(): number[] {
    return [...this.pages];
  }
}
