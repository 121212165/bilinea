// T-028f：原生 PDF 页浮动按钮（PdfEntry）DOM 行为
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { PdfEntry } from '../../../src/content/pdf-entry';
import type { RpcRequest, RpcResponse } from '../../../src/shared/messaging';

function makeDom(url = 'https://x.com/a.pdf'): Document {
  return new JSDOM('<!doctype html><html><body></body></html>', { url }).window.document;
}

function clickEvent(doc: Document): MouseEvent {
  const Ctor = doc.defaultView?.MouseEvent;
  if (!Ctor) throw new Error('MouseEvent unavailable');
  return new Ctor('click', { bubbles: true });
}

interface FakeRpc {
  calls: RpcRequest[];
  request: (msg: RpcRequest) => Promise<RpcResponse>;
}

function fakeRpc(pdfEntryEnabled: boolean, openOk = true): FakeRpc {
  const calls: RpcRequest[] = [];
  return {
    calls,
    request: async (msg) => {
      calls.push(msg);
      switch (msg.type) {
        case 'GET_PUBLIC_SETTINGS':
          return { type: 'PUBLIC_SETTINGS', settings: { targetLang: 'zh-CN', pdfEntryEnabled } };
        case 'OPEN_PDF_READER':
          return { type: 'PDF_READER_OPENED', ok: openOk };
        default:
          return { type: 'NOT_SUPPORTED' };
      }
    },
  };
}

describe('PdfEntry（契约 messaging.md GET_PDF_INFO / OPEN_PDF_READER）', () => {
  it('设置开启 → 挂载按钮；重复 init/mount 不产生第二个', async () => {
    const doc = makeDom();
    const rpc = fakeRpc(true);
    const entry = new PdfEntry({ doc, request: rpc.request });
    await entry.init();
    const btn = doc.getElementById('itr-pdf-entry') as HTMLButtonElement | null;
    expect(btn?.textContent).toBe('用 Bilinea 打开');
    expect(btn?.type).toBe('button');
    expect(btn?.style.position).toBe('fixed');
    entry.syncEnabled(true);
    await entry.init();
    expect(doc.querySelectorAll('#itr-pdf-entry')).toHaveLength(1);
  });

  it('设置关闭 → 不挂载；已挂载后被关闭 → 移除（实时生效）', async () => {
    const doc = makeDom();
    const rpc = fakeRpc(false);
    const entry = new PdfEntry({ doc, request: rpc.request });
    await entry.init();
    expect(doc.getElementById('itr-pdf-entry')).toBeNull();

    entry.syncEnabled(true);
    expect(doc.getElementById('itr-pdf-entry')).not.toBeNull();
    entry.syncEnabled(false);
    expect(doc.getElementById('itr-pdf-entry')).toBeNull();
  });

  it('SW 读取设置失败 → fail-open 挂载（入口无害）', async () => {
    const doc = makeDom();
    const entry = new PdfEntry({
      doc,
      request: async () => {
        throw new Error('sw down');
      },
    });
    await entry.init();
    expect(doc.getElementById('itr-pdf-entry')).not.toBeNull();
  });

  it('点击 → 经 SW 打开阅读器（只提交当前 PDF 地址，不拼扩展 URL）', async () => {
    const doc = makeDom('https://arxiv.org/pdf/1706.03762v7');
    const rpc = fakeRpc(true);
    const entry = new PdfEntry({ doc, request: rpc.request });
    await entry.init();
    doc.getElementById('itr-pdf-entry')?.dispatchEvent(clickEvent(doc));
    await new Promise((r) => setTimeout(r, 0));
    expect(rpc.calls.at(-1)).toEqual({
      type: 'OPEN_PDF_READER',
      fileUrl: 'https://arxiv.org/pdf/1706.03762v7',
    });
    expect(doc.getElementById('itr-pdf-entry')?.textContent).toBe('用 Bilinea 打开');
  });

  it('非 http/https 页面 → SW 回 ok:false，按钮文案降级', async () => {
    const doc = makeDom('about:blank');
    const rpc = fakeRpc(true, false);
    const entry = new PdfEntry({ doc, request: rpc.request });
    await entry.init();
    const btn = doc.getElementById('itr-pdf-entry') as HTMLButtonElement;
    btn.dispatchEvent(clickEvent(doc));
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.textContent).toBe('当前 PDF 无法打开（仅支持 http/https）');
  });

  it('Rpc 不可达 → 提示刷新重试，不虚报已打开', async () => {
    const doc = makeDom();
    let calls = 0;
    const entry = new PdfEntry({
      doc,
      request: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            type: 'PUBLIC_SETTINGS',
            settings: { targetLang: 'zh-CN', pdfEntryEnabled: true },
          };
        }
        throw new Error('sw down');
      },
    });
    await entry.init();
    const btn = doc.getElementById('itr-pdf-entry') as HTMLButtonElement;
    btn.dispatchEvent(clickEvent(doc));
    await new Promise((r) => setTimeout(r, 0));
    expect(btn.textContent).toBe('打开失败，请刷新重试');
  });
});
