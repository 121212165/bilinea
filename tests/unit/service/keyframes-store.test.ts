// T-027 / M3-4 SW 侧关键帧存储与 capture 通道（契约 messaging.md「关键帧通道」）
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureAndStore,
  KeyframeStore,
  keyframeContextOf,
  resolveWindowId,
  type KeyframeDeps,
} from '../../../src/service/keyframes';
import { KEYFRAME_STORE_KEY, type KeyframeRecord } from '../../../src/shared/keyframes';

const JPEG = 'data:image/jpeg;base64,AAAA';

function makeDeps(over: Partial<KeyframeDeps> = {}): { deps: KeyframeDeps; storage: Map<string, unknown>; captured: number[] } {
  const storage = new Map<string, unknown>();
  const captured: number[] = [];
  const deps: KeyframeDeps = {
    storage: {
      async get(key) {
        return storage.has(key) ? { [key]: storage.get(key) } : {};
      },
      async set(items) {
        for (const [k, v] of Object.entries(items)) storage.set(k, v);
      },
    },
    capture: async (windowId: number) => {
      captured.push(windowId);
      return JPEG;
    },
    genId: (() => 'kf-fixed') as KeyframeDeps['genId'],
    now: () => 1769500800000,
    ...over,
  };
  return { deps, storage, captured };
}

const CTX = { videoId: 'v1', videoTime: 75.4, src: 'hello', dst: '译' };

describe('KeyframeStore（单键 itr-kf-store + 全局 LRU）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('append：字段归并入键（单键、videoId 分组、now/genId 注入生效）', async () => {
    const { deps, storage } = makeDeps();
    const f = await new KeyframeStore(deps).append(CTX, JPEG);
    expect(f).toMatchObject({ id: 'kf-fixed', videoId: 'v1', videoTime: 75.4, jpeg: JPEG });
    const raw = storage.get(KEYFRAME_STORE_KEY) as { frames: KeyframeRecord[] };
    expect(raw.frames).toHaveLength(1);
    expect(raw.frames[0].createdAt).toBe(1769500800000);
    // 单键：storage 里只有 itr-kf-store 一个关键帧键
    expect([...storage.keys()]).toEqual([KEYFRAME_STORE_KEY]);
  });

  it('LRU：超限从队首逐帧淘汰（cap=3，第 4 帧挤掉第 1 帧）', async () => {
    const { deps } = makeDeps({ cap: 3, genId: (() => '') as KeyframeDeps['genId'] });
    const store = new KeyframeStore(deps);
    for (let i = 0; i < 4; i += 1) {
      await store.append({ ...CTX, videoId: `v${i}` }, JPEG);
    }
    const { frames } = await store.read();
    expect(frames.map((f) => f.videoId)).toEqual(['v1', 'v2', 'v3']); // v0 被淘
  });

  it('read：损坏/缺失/空值 → 空存储兜底（不 throw）', async () => {
    const { deps, storage } = makeDeps();
    const store = new KeyframeStore(deps);
    expect(await store.read()).toEqual({ frames: [] });
    storage.set(KEYFRAME_STORE_KEY, { frames: 'corrupt' });
    expect(await store.read()).toEqual({ frames: [] });
    storage.set(KEYFRAME_STORE_KEY, { frames: [{ nope: true }, { id: 'kf-x', jpeg: JPEG }] });
    const { frames } = await store.read();
    expect(frames).toHaveLength(1); // 形状校验过滤坏条目
  });
});

describe('captureAndStore（captureVisibleTab 单点 + E_NO_GESTURE）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('成功路径：windowId 进 capture、落库、回 id/videoTime', async () => {
    const { deps, captured } = makeDeps({ genId: (() => 'kf-7') as KeyframeDeps['genId'] });
    const res = await captureAndStore(deps, CTX, 42);
    expect(res).toEqual({ type: 'KEYFRAME_SAVED', id: 'kf-7', videoTime: 75.4 });
    expect(captured).toEqual([42]);
  });

  it('capture 抛错（授予不在场）→ E_NO_GESTURE 且不落库', async () => {
    const { deps, storage } = makeDeps({
      capture: async () => {
        throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
      },
    });
    const res = await captureAndStore(deps, CTX, 42);
    expect(res.type).toBe('KEYFRAME_SAVED');
    const err = (res as { error?: { code: string; detail?: string } }).error;
    expect(err?.code).toBe('E_NO_GESTURE');
    expect(err?.detail).toContain('activeTab');
    expect(storage.has(KEYFRAME_STORE_KEY)).toBe(false); // 失败零落库
  });

  it('windowId null 且无 chrome 查询 → E_NO_GESTURE（no window）', async () => {
    const { deps, captured } = makeDeps();
    const res = await captureAndStore(deps, CTX, null);
    expect(captured).toHaveLength(0);
    expect((res as { error?: { code: string } }).error?.code).toBe('E_NO_GESTURE');
  });

  it('jpeg 非 dataURL（空帧/损坏）→ E_NO_GESTURE（empty capture）', async () => {
    const { deps, storage } = makeDeps({ capture: async () => '' });
    const res = await captureAndStore(deps, CTX, 42);
    expect((res as { error?: { detail?: string } }).error?.detail).toBe('empty capture');
    expect(storage.has(KEYFRAME_STORE_KEY)).toBe(false);
  });

  it('resolveWindowId：sender 值优先；否则 fallback 活动 tab 查询', async () => {
    vi.stubGlobal('chrome', {
      tabs: {
        query: async () => [{ id: 9, windowId: 77 }],
      },
    });
    expect(await resolveWindowId(5)).toBe(5);
    expect(await resolveWindowId(undefined)).toBe(77);
    expect(await resolveWindowId(Number.NaN)).toBe(77);
  });
});

describe('keyframeContextOf（容错字段解析）', () => {
  it('完整/残缺/null 形状均归并出合法上下文', () => {
    expect(keyframeContextOf({ videoId: 'a', videoTime: 3.5, src: 's', dst: 'd' })).toEqual({
      videoId: 'a',
      videoTime: 3.5,
      src: 's',
      dst: 'd',
    });
    expect(keyframeContextOf({ videoTime: Number.NaN, videoId: 'a' })).toEqual({
      videoId: 'a',
      videoTime: null,
      src: '',
      dst: '',
    });
    expect(keyframeContextOf(null)).toEqual({ videoId: '', videoTime: null, src: '', dst: '' });
    expect(keyframeContextOf('garbage')).toEqual({ videoId: '', videoTime: null, src: '', dst: '' });
  });
});
