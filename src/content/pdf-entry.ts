// T-028f 原生 PDF 页入口：浮动按钮 → 扩展内阅读器（新标签页）。
// 不接管导航、不新增权限、不读取 PDF 内容；显隐受 pdfEntryEnabled 控制。
// web 页不能直接导航到 chrome-extension://（ERR_BLOCKED_BY_CLIENT），故开标签经 Rpc 交 SW。
import { logger } from '../shared/logger';
import type { RpcRequest, RpcResponse } from '../shared/messaging';
import { callRpc } from '../shared/messaging';

const BUTTON_ID = 'itr-pdf-entry';

export interface PdfEntryDeps {
  doc: Document;
  request?: (msg: RpcRequest) => Promise<RpcResponse>;
}

function styleButton(btn: HTMLButtonElement): void {
  btn.style.cssText = [
    'position:fixed',
    'top:64px',
    'right:16px',
    'z-index:2147483647',
    'padding:9px 16px',
    'border:0',
    'border-radius:999px',
    'background:linear-gradient(135deg,#4a6cf7,#8c3ff2)',
    'color:#fff',
    'font:600 13px/1.4 system-ui,"Segoe UI","Microsoft YaHei",sans-serif',
    'box-shadow:0 4px 14px rgba(74,108,247,.38)',
    'cursor:pointer',
  ].join(';');
}

export class PdfEntry {
  private readonly doc: Document;
  private readonly request: (msg: RpcRequest) => Promise<RpcResponse>;

  constructor(deps: PdfEntryDeps) {
    this.doc = deps.doc;
    this.request = deps.request ?? callRpc;
  }

  /** 读公共设置后挂载；SW 不可达时 fail-open（入口无害，点击会再报错） */
  async init(): Promise<void> {
    let enabled = true;
    try {
      const res = await this.request({ type: 'GET_PUBLIC_SETTINGS' });
      if (res.type === 'PUBLIC_SETTINGS') enabled = res.settings.pdfEntryEnabled !== false;
    } catch (e) {
      logger.warn('pdf entry settings failed', e);
    }
    this.syncEnabled(enabled);
  }

  syncEnabled(enabled: boolean): void {
    if (enabled) this.mount();
    else this.unmount();
  }

  private mount(): void {
    if (this.doc.getElementById(BUTTON_ID)) return;
    const btn = this.doc.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.textContent = '用 Bilinea 打开';
    btn.title = '在扩展内阅读器中打开此 PDF（可双语翻译）';
    btn.setAttribute('data-itr-pdf-entry', '');
    styleButton(btn);
    btn.addEventListener('click', () => {
      void this.openReader(btn);
    });
    (this.doc.body ?? this.doc.documentElement).append(btn);
  }

  private async openReader(btn: HTMLButtonElement): Promise<void> {
    try {
      const res = await this.request({ type: 'OPEN_PDF_READER', fileUrl: this.doc.location.href });
      if (res.type === 'PDF_READER_OPENED' && res.ok) return;
      btn.textContent = '当前 PDF 无法打开（仅支持 http/https）';
    } catch (e) {
      logger.warn('open pdf reader failed', e);
      btn.textContent = '打开失败，请刷新重试';
    }
  }

  private unmount(): void {
    this.doc.getElementById(BUTTON_ID)?.remove();
  }
}
