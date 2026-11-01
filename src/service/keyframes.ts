// 关键帧 capture + 存储（T-027 / M3-4，契约 messaging.md「关键帧通道」+ subtitles.md「关键帧绑定」）。
// 只有 SW 层执行 captureVisibleTab；dataURL 只流经 SW 与 popup。失败不裸 throw，回 RpcResponse error。

import {
  KEYFRAME_CAP,
  KEYFRAME_STORE_KEY,
  emptyKeyframeContext,
  emptyKeyframeStore,
  videoGroupKey,
  type KeyframeContext,
  type KeyframeRecord,
  type KeyframeStoreValue,
} from '../shared/keyframes';
import type { RpcResponse } from '../shared/messaging';
import type { ProviderError } from '../shared/types';

export interface KeyframeDeps {
  /** chrome.storage.local 适配（service/storage.ts 的 StorageLike 形状） */
  storage: {
    get(key: string): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
  };
  /** captureVisibleTab 注入点（生产 = windowId → jpeg dataURL；测试 = fake） */
  capture: (windowId: number) => Promise<string>;
  /** id 生成器（默认 crypto.randomUUID；测试注入确定性函数） */
  genId?: () => string;
  /** LRU 上限（默认 KEYFRAME_CAP；测试注入小值便于验证淘汰） */
  cap?: number;
  now?: () => number;
}

/**
 * 单键 LRU 存取（契约「存储」：单键 itr-kf-store，追加后超限从队首逐帧淘汰，跨视频全局）。
 */
export class KeyframeStore {
  private readonly deps: KeyframeDeps;

  constructor(deps: KeyframeDeps) {
    this.deps = deps;
  }

  private get cap(): number {
    return this.deps.cap ?? KEYFRAME_CAP;
  }

  async read(): Promise<KeyframeStoreValue> {
    const obj = await this.deps.storage.get(KEYFRAME_STORE_KEY);
    const raw = obj[KEYFRAME_STORE_KEY];
    if (!raw || typeof raw !== 'object') return emptyKeyframeStore();
    const frames = (raw as KeyframeStoreValue).frames;
    return Array.isArray(frames) ? { frames: frames.filter(isRecordLike) } : emptyKeyframeStore();
  }

  async write(value: KeyframeStoreValue): Promise<void> {
    await this.deps.storage.set({ [KEYFRAME_STORE_KEY]: value });
  }

  /** frame 构造（字段防错归并）+ 全局 LRU 追加 */
  async append(ctx: KeyframeContext, jpeg: string): Promise<KeyframeRecord> {
    const store = await this.read();
    const frame: KeyframeRecord = {
      id: this.deps.genId ? this.deps.genId() : crypto.randomUUID(),
      videoId: videoGroupKey(ctx.videoId),
      videoTime: finiteOrNull(ctx.videoTime),
      src: typeof ctx.src === 'string' ? ctx.src : '',
      dst: typeof ctx.dst === 'string' ? ctx.dst : '',
      jpeg,
      createdAt: this.deps.now ? this.deps.now() : Date.now(),
    };
    store.frames.push(frame);
    while (store.frames.length > this.cap) store.frames.shift();
    await this.write(store);
    return frame;
  }
}

function isRecordLike(f: unknown): f is KeyframeRecord {
  return (
    typeof f === 'object' &&
    f !== null &&
    typeof (f as KeyframeRecord).id === 'string' &&
    typeof (f as KeyframeRecord).jpeg === 'string'
  );
}

function finiteOrNull(t: unknown): number | null {
  return typeof t === 'number' && Number.isFinite(t) ? t : null;
}

/**
 * 容错字段解析（Rpc 请求体与 TabAction 同步回包共用；缺字段归空，随手帧语义）。
 */
export function keyframeContextOf(raw: unknown): KeyframeContext {
  if (!raw || typeof raw !== 'object') return emptyKeyframeContext();
  const r = raw as Partial<KeyframeContext>;
  return {
    videoId: typeof r.videoId === 'string' ? r.videoId : '',
    videoTime: finiteOrNull(r.videoTime),
    src: typeof r.src === 'string' ? r.src : '',
    dst: typeof r.dst === 'string' ? r.dst : '',
  };
}

/** sender.tab.windowId / 活动 tab → capture 用的 windowId（探针①：首参是 windowId） */
export async function resolveWindowId(senderTabWindowId: number | null | undefined): Promise<number | null> {
  if (typeof senderTabWindowId === 'number' && Number.isFinite(senderTabWindowId)) return senderTabWindowId;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.windowId ?? null;
  } catch {
    return null;
  }
}

/**
 * capture → 单键 LRU 落库 → KEYFRAME_SAVED 响应（含 E_NO_GESTURE 兜底）。
 * windowId null → 无可见窗口可捕（报 E_NO_GESTURE）。
 */
export async function captureAndStore(
  deps: KeyframeDeps,
  ctx: KeyframeContext,
  windowId: number | null | undefined,
): Promise<RpcResponse> {
  const wid = await resolveWindowId(windowId);
  if (wid === null) {
    return { type: 'KEYFRAME_SAVED', error: { code: 'E_NO_GESTURE', detail: 'no window' } };
  }
  try {
    const jpeg = await deps.capture(wid);
    if (typeof jpeg !== 'string' || !jpeg.startsWith('data:image/')) {
      return { type: 'KEYFRAME_SAVED', error: { code: 'E_NO_GESTURE', detail: 'empty capture' } };
    }
    const frame = await new KeyframeStore(deps).append(ctx, jpeg);
    return { type: 'KEYFRAME_SAVED', id: frame.id, videoTime: frame.videoTime };
  } catch (e) {
    const error: ProviderError = { code: 'E_NO_GESTURE', detail: String(e).slice(0, 120) };
    return { type: 'KEYFRAME_SAVED', error };
  }
}
