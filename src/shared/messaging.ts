// 契约镜像：.agent/spec/contracts/messaging.md
// 所有跨上下文消息类型集中在此。

import type {
  ExtensionSettings,
  Language,
  ProviderError,
  PublicSettings,
  Segment,
  TranslatedSegment,
} from './types';
import { API_VERSION } from './constants';
import type { KeyframeContext } from './keyframes';

/** content/popup → service worker 的请求 */
export type RpcRequest =
  | { type: 'PING' }
  | { type: 'GET_SETTINGS' }
  | { type: 'GET_PUBLIC_SETTINGS' }
  | { type: 'SET_SETTINGS'; patch: Partial<ExtensionSettings> }
  | {
      type: 'TRANSLATE_BATCH';
      segments: Segment[];
      source: Language | 'auto';
      target: Language;
      requestId: string;
    }
  | { type: 'CANCEL'; requestId: string }
  | { type: 'CLEAR_CACHE' }
  | { type: 'SUMMARIZE_TEXT'; requestId: string; text: string }
  | { type: 'OPEN_PDF_READER'; fileUrl: string }
  | ({ type: 'CAPTURE_KEYFRAME' } & KeyframeContext);

/** service worker 的响应 */
export type RpcResponse =
  | { type: 'PONG'; version: string }
  | { type: 'SETTINGS'; settings: ExtensionSettings }
  | { type: 'PUBLIC_SETTINGS'; settings: PublicSettings }
  | {
      type: 'TRANSLATION';
      items: TranslatedSegment[];
      error?: ProviderError;
    }
  | { type: 'CANCELED'; ok: boolean }
  | { type: 'CACHE_CLEARED'; removed: number }
  | { type: 'SUMMARY'; text?: string; error?: ProviderError }
  | { type: 'PDF_READER_OPENED'; ok: boolean }
  | { type: 'KEYFRAME_SAVED'; id?: string; videoTime?: number | null; error?: ProviderError }
  | { type: 'NOT_SUPPORTED' };

/** SW → 所有 tab 的事件广播 */
export type SwEvent =
  | { type: 'SETTINGS_CHANGED'; settings: ExtensionSettings }
  | {
      type: 'TRANSLATION_PROGRESS';
      requestId: string;
      done: number;
      total: number;
      /** 增量：本批窗口的翻译结果 */
      items: TranslatedSegment[];
    }
  | { type: 'TRANSLATION_DONE'; requestId: string; error?: ProviderError }
  | { type: 'KEYFRAME_SAVED'; id: string; videoTime: number | null };

/** popup / 快捷键 → 当前 tab 的指令 */
export type TabAction =
  | { type: 'TRANSLATE_PAGE' }
  | { type: 'STOP_TRANSLATE' }
  | { type: 'AUTO_ON' }
  | { type: 'AUTO_OFF' }
  | { type: 'GET_TRANSCRIPT' }
  | { type: 'CAPTURE_KEYFRAME' }
  | { type: 'GET_PDF_INFO' };

/** T-026 字幕导出：content 单行双语的记录对 */
export interface TranscriptPair {
  src: string;
  dst: string;
}

/** T-026 字幕导出：GET_TRANSCRIPT 的异步回包载体（title 作文件名原料） */
export interface TranscriptPayload {
  type: 'TRANSCRIPT';
  title: string;
  pairs: TranscriptPair[];
}

/** T-027 TabAction CAPTURE_KEYFRAME 的同步回包：content 只收上下文，capture 由 SW 统一执行 */
export interface KeyframeContextPayload extends KeyframeContext {
  type: 'KEYFRAME_CONTEXT';
}

/** T-028f TabAction GET_PDF_INFO 的同步回包：原生 PDF 查看器检测（popup 入口用） */
export interface PdfInfoPayload {
  type: 'PDF_INFO';
  isPdf: boolean;
  /** 页面 document.URL；非 PDF 时也回，便于调用方判断 */
  url: string;
}

export function isPdfInfoPayload(v: unknown): v is PdfInfoPayload {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<PdfInfoPayload>;
  return o.type === 'PDF_INFO' && typeof o.isPdf === 'boolean' && typeof o.url === 'string';
}

/** T-027 回包形状判定（popup 消费：KEYFRAME_CONTEXT → 代交 SW capture；否则回退空上下文随手帧） */
export function isKeyframeContextPayload(v: unknown): v is KeyframeContextPayload {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Partial<KeyframeContextPayload>;
  return (
    o.type === 'KEYFRAME_CONTEXT' &&
    typeof o.videoId === 'string' &&
    (o.videoTime === null || typeof o.videoTime === 'number') &&
    typeof o.src === 'string' &&
    typeof o.dst === 'string'
  );
}

export type AnyOutgoingMessage = RpcRequest | TabAction;

export function isTabAction(m: unknown): m is TabAction {
  return (
    typeof m === 'object' &&
    m !== null &&
    'type' in m &&
    [
      'TRANSLATE_PAGE',
      'STOP_TRANSLATE',
      'AUTO_ON',
      'AUTO_OFF',
      'GET_TRANSCRIPT',
      'CAPTURE_KEYFRAME',
      'GET_PDF_INFO',
    ].includes((m as TabAction).type)
  );
}

/**
 * 类型安全的调用封装：content/popup → service worker。
 */
const ALL_RPC_TYPES = new Set([
  'PING',
  'GET_SETTINGS',
  'GET_PUBLIC_SETTINGS',
  'SET_SETTINGS',
  'TRANSLATE_BATCH',
  'CANCEL',
  'CLEAR_CACHE',
  'SUMMARIZE_TEXT',
  'OPEN_PDF_READER',
  'CAPTURE_KEYFRAME',
]);

export function isRpcRequest(m: unknown): m is RpcRequest {
  return (
    typeof m === 'object' &&
    m !== null &&
    'type' in m &&
    ALL_RPC_TYPES.has((m as { type: string }).type)
  );
}

export async function callRpc(msg: RpcRequest): Promise<RpcResponse> {
  const res = (await chrome.runtime.sendMessage(msg)) as RpcResponse | undefined;
  return res ?? { type: 'NOT_SUPPORTED' };
}

export const NOT_SUPPORTED: RpcResponse = { type: 'NOT_SUPPORTED' };
export const PONG: RpcResponse = { type: 'PONG', version: API_VERSION };
