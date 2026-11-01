// T-028f：content 入口的 PDF 模式（不建翻译管线；GET_PDF_INFO 同步回包；入口显隐实时生效）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const BUTTON_ID = 'itr-pdf-entry';

interface Captured {
  onMessage: ((msg: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean) | null;
  onChanged: ((changes: unknown, area: string) => void) | null;
  sendMessage: ReturnType<typeof vi.fn>;
}

async function bootPdfPage(pdfEntryEnabled = true): Promise<{ doc: Document; cap: Captured }> {
  vi.resetModules();
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://arxiv.org/pdf/1706.03762',
  });
  const doc = dom.window.document;
  Object.defineProperty(doc, 'contentType', { value: 'application/pdf', configurable: true });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', doc);

  const cap: Captured = { onMessage: null, onChanged: null, sendMessage: vi.fn() };
  cap.sendMessage.mockImplementation(async (msg: { type?: string }) => {
    if (msg?.type === 'GET_PUBLIC_SETTINGS') {
      return { type: 'PUBLIC_SETTINGS', settings: { targetLang: 'zh-CN', pdfEntryEnabled } };
    }
    if (msg?.type === 'OPEN_PDF_READER') return { type: 'PDF_READER_OPENED', ok: true };
    return undefined;
  });
  vi.stubGlobal('chrome', {
    runtime: {
      getURL: (path: string) => `chrome-extension://abc/${path}`,
      sendMessage: cap.sendMessage,
      onMessage: {
        addListener: (fn: Captured['onMessage']) => {
          cap.onMessage = fn;
        },
      },
    },
    storage: {
      onChanged: {
        addListener: (fn: Captured['onChanged']) => {
          cap.onChanged = fn;
        },
      },
    },
  });

  await import('../../../src/content/index');
  await new Promise((r) => setTimeout(r, 10));
  return { doc, cap };
}

describe('content PDF 模式（T-028f）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('挂载入口按钮；不向 SW 要完整设置（只读 GET_PUBLIC_SETTINGS）', async () => {
    const { doc, cap } = await bootPdfPage();
    expect(doc.getElementById(BUTTON_ID)?.textContent).toBe('用 Bilinea 打开');
    expect(cap.sendMessage).toHaveBeenCalledWith({ type: 'GET_PUBLIC_SETTINGS' });
    expect(cap.sendMessage).not.toHaveBeenCalledWith({ type: 'GET_SETTINGS' });
  });

  it('GET_PDF_INFO 同步回包（return false，不保持异步通道）', async () => {
    const { doc, cap } = await bootPdfPage();
    const sendResponse = vi.fn();
    const keepOpen = cap.onMessage?.({ type: 'GET_PDF_INFO' }, {}, sendResponse);
    expect(keepOpen).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({
      type: 'PDF_INFO',
      isPdf: true,
      url: doc.location.href,
    });
  });

  it('翻译类 TabAction 在 PDF 模式不触发管线（无控制器、不抛错）', async () => {
    const { doc, cap } = await bootPdfPage();
    const sendResponse = vi.fn();
    expect(cap.onMessage?.({ type: 'TRANSLATE_PAGE' }, {}, sendResponse)).toBe(false);
    expect(cap.onMessage?.({ type: 'GET_TRANSCRIPT' }, {}, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(doc.getElementById(BUTTON_ID)).not.toBeNull();
  });

  it('storage.onChanged 关闭开关 → 入口移除；开启 → 重新挂载', async () => {
    const { doc, cap } = await bootPdfPage();
    cap.onChanged?.({ itr_settings: { newValue: { pdfEntryEnabled: false } } }, 'local');
    expect(doc.getElementById(BUTTON_ID)).toBeNull();
    cap.onChanged?.({ itr_settings: { newValue: { pdfEntryEnabled: true } } }, 'local');
    expect(doc.getElementById(BUTTON_ID)).not.toBeNull();
  });

  it('点击入口 → Rpc OPEN_PDF_READER 携带当前 PDF 地址（开标签在 SW）', async () => {
    const { doc, cap } = await bootPdfPage();
    const btn = doc.getElementById(BUTTON_ID);
    const Ctor = doc.defaultView?.MouseEvent;
    if (!btn || !Ctor) throw new Error('button/MouseEvent unavailable');
    btn.dispatchEvent(new Ctor('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(cap.sendMessage).toHaveBeenCalledWith({
      type: 'OPEN_PDF_READER',
      fileUrl: doc.location.href,
    });
  });
});
