// content script 入口（T-008）：指令路由 + 广播监听 + 白名单自动翻译。
// T-028f：原生 PDF 查看器页不进翻译管线，只挂「用 Bilinea 打开」入口。
// 幂等防护（契约 messaging.md「指令投递可靠性」T-016）：同一 isolated world 内
// 可能被 popup 补注入再次执行（注入竞态），双监听 × toggle 语义会产生重复译文块；
// window 标记跨注入共享，二次执行直接跳过。
import { logger } from '../shared/logger';
import { isTabAction, type SwEvent } from '../shared/messaging';
import { isPdfViewer, pdfInfoOf } from '../shared/pdf-entry';
import { PageController } from './controller';
import { PdfEntry } from './pdf-entry';
import { API_VERSION } from '../shared/constants';

const win = window as unknown as { __itrContentReady?: boolean };

if (!win.__itrContentReady) {
  win.__itrContentReady = true;

  const pdfMode = isPdfViewer(document.contentType);
  const controller = pdfMode ? null : new PageController({ doc: document });
  if (controller) void controller.init();

  if (pdfMode) {
    // PDF 页只读公共设置（不含 Key）；不开 hovers/selection/subtitles 管线
    const entry = new PdfEntry({ doc: document });
    void entry.init();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const next = changes['itr_settings']?.newValue as { pdfEntryEnabled?: boolean } | undefined;
      if (next) entry.syncEnabled(next.pdfEntryEnabled !== false);
    });
  }

  const EVENT_TYPES = new Set<string>([
    'SETTINGS_CHANGED',
    'TRANSLATION_PROGRESS',
    'TRANSLATION_DONE',
  ]);

  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (isTabAction(msg)) {
      if (msg.type === 'GET_PDF_INFO') {
        // T-028f：同步回包（popup 判断是否显示 PDF 入口）；不 return true
        sendResponse(pdfInfoOf(document.contentType, document.location.href));
        return false;
      }
      if (!controller) return false; // PDF 模式：其余 TabAction 不适用
      if (msg.type === 'GET_TRANSCRIPT') {
        // T-026 字幕导出：唯一要求异步回包的 TabAction（契约 messaging.md tab 指令表）
        void Promise.resolve(controller.transcriptPayload()).then(sendResponse);
        return true; // 保持通道开放
      }
      if (msg.type === 'CAPTURE_KEYFRAME') {
        // T-027 关键帧：同步回包上下文（无 return true），capture 由 SW 统一执行；
        // SW/popup 收到 KEYFRAME_CONTEXT 后才落 capture，恰好一次
        sendResponse(controller.keyframeContextPayload());
        return false;
      }
      void controller.handleAction(msg);
      return false; // 无需异步回包
    }
    if (
      controller &&
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      typeof (msg as { type: unknown }).type === 'string' &&
      EVENT_TYPES.has((msg as { type: string }).type)
    ) {
      controller.handleEvent(msg as SwEvent);
    }
    return false;
  });

  logger.info(`content ready v${API_VERSION}${pdfMode ? ' (pdf entry)' : ''}`);
}
