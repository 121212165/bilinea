// Service Worker 入口（T-005）：消息路由 + 队列装配。
// 硬约束：Key 只在此层使用；翻译请求仅从这里发出。

import { logger } from '../shared/logger';
import { isRpcRequest, PONG, type RpcRequest, type RpcResponse, type SwEvent } from '../shared/messaging';
import { emptyKeyframeContext, type KeyframeContext } from '../shared/keyframes';
import type { ExtensionSettings, ProviderError } from '../shared/types';
import { TranslationCache, cacheKey } from './cache';
import { ProviderChain } from './provider-chain';
import { TranslationQueue, type ChainLike } from './queue';
import { createProvider } from './providers/registry';
import { summarizeText } from './summarize';
import { captureAndStore, keyframeContextOf, type KeyframeDeps } from './keyframes';
import { loadSettings, saveSettings, type StorageLike } from './storage';
import { buildPdfReaderUrl } from '../shared/pdf-entry';

function chromeStorage(): StorageLike {
  return {
    async get(key: string): Promise<Record<string, unknown>> {
      return (await chrome.storage.local.get(key)) as Record<string, unknown>;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      await chrome.storage.local.set(items);
    },
    async remove(keys): Promise<void> {
      await chrome.storage.local.remove(keys);
    },
  };
}

const cache = new TranslationCache({ store: chromeStorage() });
let snapshot: ExtensionSettings | null = null;

function settingsSnapshot(): ExtensionSettings {
  if (snapshot) return snapshot;
  throw new Error('settings not ready');
}

/** 动态 Chain：每次翻译按最新设置重建（优先级调整实时生效） */
function dynamicChain(): ChainLike {
  const chain = new ProviderChain(() => settingsSnapshot().providers, createProvider);
  return {
    translateBatch: (segments, source, target) => chain.translateBatch(segments, source, target),
    abort: () => chain.abort(),
  };
}

const queue = new TranslationQueue({
  chain: dynamicChain(),
  cache,
  cacheKeyFn: (provider, target, text) => cacheKey(provider, target, text),
  providerName: () => settingsSnapshot().providers.find((p) => p.enabled)?.type ?? 'openai-compatible',
  broadcast: (event) => void broadcast(event),
});

/** T-027 关键帧依赖（唯 captureVisibleTab 的 SW 通道；storage 与设置同源走 chromeStorage） */
const keyframeDeps: KeyframeDeps = {
  storage: chromeStorage(),
  capture: (windowId: number) =>
    // Edge 156 实测：目标窗可见 tab 为扩展自身页时，SW 侧该 promise 永不落定
    // （不 resolve 不 reject → Rpc 通道悬死 + 静默无日志）。加超时护栏保底拒绝。
    Promise.race([
      chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('capture timeout: captureVisibleTab never settles')), 8000),
      ),
    ]),
};

async function broadcast(event: SwEvent): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(
      tabs.map((t) => (t.id ? chrome.tabs.sendMessage(t.id, event) : Promise.resolve())),
    );
  } catch (e) {
    logger.warn('broadcast failed', e);
  }
}

async function handle(request: RpcRequest, sender: chrome.runtime.MessageSender): Promise<RpcResponse> {
  switch (request.type) {
    case 'PING':
      return PONG;
    case 'GET_SETTINGS':
      return { type: 'SETTINGS', settings: await settingsOrLoad() };
    case 'GET_PUBLIC_SETTINGS': {
      // PDF 阅读页等扩展页只取非敏感字段；绝不把 providers/apiKey 带出 SW。
      const settings = await settingsOrLoad();
      return {
        type: 'PUBLIC_SETTINGS',
        settings: {
          targetLang: settings.targetLang,
          pdfEntryEnabled: settings.pdfEntryEnabled,
        },
      };
    }
    case 'SET_SETTINGS':
      snapshot = await saveSettings(request.patch);
      await broadcast({ type: 'SETTINGS_CHANGED', settings: snapshot });
      return { type: 'SETTINGS', settings: snapshot };
    case 'TRANSLATE_BATCH': {
      // 同 requestId 重入：先取消旧批次
      queue.cancel(request.requestId);
      const { items, error } = await queue.translate(
        request.requestId,
        request.segments,
        request.source,
        request.target,
      );
      return { type: 'TRANSLATION', items, error };
    }
    case 'CANCEL':
      return { type: 'CANCELED', ok: queue.cancel(request.requestId) };
    case 'CLEAR_CACHE':
      return { type: 'CACHE_CLEARED', removed: await cache.clear() };
    case 'SUMMARIZE_TEXT': {
      // T-026 AI 简述：单发通道，不进翻译队列/缓存（契约 messaging.md §SUMMARIZE_TEXT）
      const settings = await settingsOrLoad();
      const res = await summarizeText(settings, request.text, settings.targetLang);
      return { type: 'SUMMARY', ...res };
    }
    case 'OPEN_PDF_READER': {
      // T-028f：web 页无法直接导航到 chrome-extension://（ERR_BLOCKED_BY_CLIENT），
      // 由 SW 校验 PDF 地址并开新标签；不把阅读页暴露为 web_accessible_resource。
      const url = buildPdfReaderUrl(chrome.runtime.getURL('pdf/index.html'), request.fileUrl);
      if (!url) return { type: 'PDF_READER_OPENED', ok: false };
      try {
        await chrome.tabs.create({ url });
        return { type: 'PDF_READER_OPENED', ok: true };
      } catch (e) {
        logger.warn('open pdf reader failed', e);
        return { type: 'PDF_READER_OPENED', ok: false };
      }
    }
    case 'CAPTURE_KEYFRAME': {
      // T-027 关键帧：热区按钮直投；sender.tab.windowId 捕窗（探针①），落库成功即广播
      const res = await captureAndStore(keyframeDeps, keyframeContextOf(request), sender.tab?.windowId);
      if (res.type === 'KEYFRAME_SAVED' && res.id) {
        void broadcast({ type: 'KEYFRAME_SAVED', id: res.id, videoTime: res.videoTime ?? null });
      }
      return res;
    }
  }
}

async function settingsOrLoad(): Promise<ExtensionSettings> {
  if (!snapshot) snapshot = await loadSettings();
  return snapshot;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isRpcRequest(msg)) return false;
  void settingsOrLoad()
    .then(() => handle(msg, sender))
    .then((res) => sendResponse(res))
    .catch((e: unknown) => {
      const error: ProviderError = { code: 'E_PROVIDER_DOWN', detail: String(e).slice(0, 120) };
      const res: RpcResponse = { type: 'TRANSLATION', items: [], error };
      sendResponse(res);
      logger.error('handle failed', e);
    });
  return true; // 异步 sendResponse
});

/** T-027 热键随手截帧：手势 = 命令本身（probe ③ 拒绝无手势；probe ⑤ 证实页内点击不算手势）。
 * 接收端缺失 / 非视频页 → 空上下文直捕（videoTime null → 导出 --:--）。 */
async function captureKeyframeFromCommand(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  let ctx: KeyframeContext;
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_KEYFRAME' });
    ctx = keyframeContextOf(res);
  } catch {
    ctx = emptyKeyframeContext(); // 接收端缺失（陈旧 tab / 非视频页）
  }
  const res = await captureAndStore(keyframeDeps, ctx, tab.windowId);
  if (res.type === 'KEYFRAME_SAVED' && res.id) {
    void broadcast({ type: 'KEYFRAME_SAVED', id: res.id, videoTime: res.videoTime ?? null });
  } else if (res.type === 'KEYFRAME_SAVED' && res.error) {
    // 冷启动 SW 的热键授予链路偶发拒绝（如窗口失焦竞态）——低噪记录，UI 无感知
    logger.warn(`capture-keyframe rejected: ${res.error.code}`);
  }
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture-keyframe') {
    void captureKeyframeFromCommand();
    return;
  }
  const action = command === 'translate-page' ? 'TRANSLATE_PAGE' : 'STOP_TRANSLATE';
  void (async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: action });
      } catch (e) {
        logger.warn('tab sendMessage failed', e);
      }
    }
  })();
});
