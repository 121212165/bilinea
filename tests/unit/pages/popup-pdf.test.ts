// T-028f：popup 原生 PDF 入口（GET_PDF_INFO → 阅读器新标签）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const POPUP_HTML = `
  <div id="page-controls">
    <button id="translate"></button>
    <button id="stop"></button>
    <input type="checkbox" id="auto" />
    <input type="checkbox" id="sel" />
    <input type="checkbox" id="hover" />
  </div>
  <section id="pdf-entry" hidden>
    <p class="pdf-title">检测到 PDF</p>
    <button id="pdf-open">用 Bilinea 打开</button>
  </section>
  <span id="state"></span>`;

interface MockState {
  isPdf: boolean;
  storageSettings: { pdfEntryEnabled?: boolean };
  receiverMissing?: boolean;
  tabUrl: string;
  created: unknown[];
}

function makeChromeMock(state: MockState) {
  return {
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: state.tabUrl }]),
      sendMessage: vi.fn(async (_tabId: number, msg: unknown) => {
        if (state.receiverMissing) throw new Error('Receiving end does not exist.');
        if ((msg as { type?: string }).type === 'GET_PDF_INFO') {
          return { type: 'PDF_INFO', isPdf: state.isPdf, url: state.tabUrl };
        }
        return undefined;
      }),
      create: vi.fn(async (props: unknown) => {
        state.created.push(props);
        return { id: 9 };
      }),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({ itr_settings: state.storageSettings })),
      },
      onChanged: { addListener: vi.fn() },
    },
    runtime: {
      getURL: (path: string) => `chrome-extension://abc/${path}`,
    },
  };
}

async function bootPopup(
  state: MockState,
): Promise<{ chromeMock: ReturnType<typeof makeChromeMock>; doc: Document; close: ReturnType<typeof vi.fn> }> {
  vi.resetModules();
  const dom = new JSDOM(`<!doctype html><html><body>${POPUP_HTML}</body></html>`);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('window', dom.window);
  // jsdom 的 window.close 会清空 document；替换为 spy 以断言「打开后关闭 popup」
  const close = vi.fn();
  dom.window.close = close;
  const chromeMock = makeChromeMock(state);
  vi.stubGlobal('chrome', chromeMock);
  await import('../../../src/pages/popup/index');
  await sleep(20);
  return { chromeMock, doc: dom.window.document, close };
}

const section = (doc: Document): HTMLElement => doc.getElementById('pdf-entry') as HTMLElement;
const controls = (doc: Document): HTMLElement => doc.getElementById('page-controls') as HTMLElement;

function clickEvent(doc: Document): MouseEvent {
  const Ctor = doc.defaultView?.MouseEvent;
  if (!Ctor) throw new Error('MouseEvent unavailable');
  return new Ctor('click', { bubbles: true });
}

function clickPdfOpen(doc: Document): void {
  const btn = doc.getElementById('pdf-open');
  if (!btn) throw new Error('pdf-open missing');
  btn.dispatchEvent(clickEvent(doc));
}

describe('popup 原生 PDF 入口（T-028f）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('PDF 页 + 开关开启 → 显示入口并隐藏常规控件；点击开新标签', async () => {
    const state: MockState = {
      isPdf: true,
      storageSettings: {},
      tabUrl: 'https://arxiv.org/pdf/1706.03762',
      created: [],
    };
    const { chromeMock, doc, close } = await bootPopup(state);
    expect(section(doc).hidden).toBe(false);
    expect(controls(doc).hidden).toBe(true);

    clickPdfOpen(doc);
    await sleep(20);
    const expected = `chrome-extension://abc/pdf/index.html?file=${encodeURIComponent(
      'https://arxiv.org/pdf/1706.03762',
    )}`;
    expect(chromeMock.tabs.create).toHaveBeenCalledWith({ url: expected });
    expect(doc.getElementById('state')?.textContent).toBe('已打开 PDF 阅读器');
    expect(close).toHaveBeenCalled();
  });

  it('非 PDF 页 → 入口隐藏、常规控件可见、不发 create', async () => {
    const state: MockState = {
      isPdf: false,
      storageSettings: {},
      tabUrl: 'https://x.com/home',
      created: [],
    };
    const { chromeMock, doc } = await bootPopup(state);
    expect(section(doc).hidden).toBe(true);
    expect(controls(doc).hidden).toBe(false);
    clickPdfOpen(doc);
    await sleep(20);
    expect(chromeMock.tabs.create).not.toHaveBeenCalled();
  });

  it('开关关闭 → 即使命中 PDF 也不显示（不接管原生查看器）', async () => {
    const state: MockState = {
      isPdf: true,
      storageSettings: { pdfEntryEnabled: false },
      tabUrl: 'https://arxiv.org/pdf/1706.03762',
      created: [],
    };
    const { doc } = await bootPopup(state);
    expect(section(doc).hidden).toBe(true);
    expect(controls(doc).hidden).toBe(false);
  });

  it('content 接收端缺失 → 隐藏入口且不报错', async () => {
    const state: MockState = {
      isPdf: true,
      storageSettings: {},
      tabUrl: 'https://arxiv.org/pdf/1706.03762',
      receiverMissing: true,
      created: [],
    };
    const { doc } = await bootPopup(state);
    expect(section(doc).hidden).toBe(true);
    expect(controls(doc).hidden).toBe(false);
  });

  it('storage.onChanged 保存开关 → 入口实时显隐', async () => {
    const state: MockState = {
      isPdf: true,
      storageSettings: { pdfEntryEnabled: true },
      tabUrl: 'https://arxiv.org/pdf/1706.03762',
      created: [],
    };
    const { chromeMock, doc } = await bootPopup(state);
    expect(section(doc).hidden).toBe(false);

    state.storageSettings = { pdfEntryEnabled: false };
    const listener = (chromeMock.storage.onChanged.addListener as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as (c: unknown, area: string) => void;
    listener({ itr_settings: { newValue: { pdfEntryEnabled: false } } }, 'local');
    await sleep(20);
    expect(section(doc).hidden).toBe(true);

    state.storageSettings = { pdfEntryEnabled: true };
    listener({ itr_settings: { newValue: { pdfEntryEnabled: true } } }, 'local');
    await sleep(20);
    expect(section(doc).hidden).toBe(false);
  });
});
