// T-005 单测：缓存 LRU / 键稳定 / 清空；队列去重/缓存旁路/分窗/进度/取消
import { describe, expect, it } from 'vitest';
import { TranslationCache, cacheKey } from '../../../src/service/cache';
import { TranslationQueue, type ChainLike } from '../../../src/service/queue';
import type { StorageLike } from '../../../src/service/storage';
import type { SwEvent } from '../../../src/shared/messaging';
import type { Segment, TranslatedSegment } from '../../../src/shared/types';

// ---- 内存 storage ----

function fakeStorage(): StorageLike {
  const m = new Map<string, unknown>();
  return {
    async get(key) {
      return m.has(key) ? { [key]: m.get(key) } : {};
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) m.set(k, v);
    },
    async remove(keys) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) m.delete(k);
    },
    async getBytesInUse() {
      return 0;
    },
  } as StorageLike;
}

const okItem = (id: string): TranslatedSegment => ({ id, text: `译-${id}` });
const okAll = (segments: Segment[]): { items: TranslatedSegment[]; error?: never } => ({
  items: segments.map((s) => okItem(s.id)),
});
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function seg(id: string, text = `text-${id}`): Segment {
  return { id, text };
}

describe('TranslationCache', () => {
  it('set/get 往返 + 跨实例读取', async () => {
    const store = fakeStorage();
    const c1 = new TranslationCache({ store });
    const key = await cacheKey('google-free', 'zh-CN', 'hello');
    await c1.set(key, '你好');
    expect(await c1.get(key)).toBe('你好');
    const c2 = new TranslationCache({ store });
    expect(await c2.get(key)).toBe('你好');
  });

  it('cacheKey 稳定且为 itr_cache: + 24 位 hex', async () => {
    const a = await cacheKey('p', 'zh-CN', 'x');
    const b = await cacheKey('p', 'zh-CN', 'x');
    const c = await cacheKey('p', 'en', 'x');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith('itr_cache:')).toBe(true);
    expect(a.length).toBe('itr_cache:'.length + 24);
  });

  it('LRU 淘汰：最旧数据超限被删', async () => {
    const store = fakeStorage();
    const limit = 230;
    const c = new TranslationCache({ store, limitBytes: limit });
    const k1 = await cacheKey('p', 'zh', 'a'.repeat(50));
    const k2 = await cacheKey('p', 'zh', 'b'.repeat(50));
    await c.set(k1, 'x'.repeat(100));
    await sleep(3);
    await c.set(k2, 'y'.repeat(100));
    await sleep(3);
    await expect(c.get(k2)).resolves.not.toBeNull(); // touch k2
    await sleep(3);
    const k3 = await cacheKey('p', 'zh', 'c'.repeat(50));
    await c.set(k3, 'z'.repeat(60)); // 超限
    expect(await c.get(k1)).toBeNull(); // 最旧淘汰
    expect(await c.get(k3)).toBe('z'.repeat(60));
  });

  it('clear：清空全部缓存键', async () => {
    const store = fakeStorage();
    const c = new TranslationCache({ store });
    const k1 = await cacheKey('p', 'zh', 'one');
    const k2 = await cacheKey('p', 'zh', 'two');
    await c.set(k1, '1');
    await c.set(k2, '2');
    expect(await c.clear()).toBe(2);
    expect(await c.get(k1)).toBeNull();
    expect(await c.get(k2)).toBeNull();
  });
});

describe('TranslationQueue', () => {
  function makeChain(
    script: Array<(segments: Segment[]) => Promise<{ items: TranslatedSegment[]; error?: never }> | { items: TranslatedSegment[]; error?: never }>,
  ): { chain: ChainLike; calls: Segment[][] } {
    const calls: Segment[][] = [];
    const chain: ChainLike = {
      async translateBatch(segments) {
        calls.push(segments);
        const fn = script[Math.min(calls.length - 1, script.length - 1)];
        return await fn(segments);
      },
      abort() {},
    };
    return { chain, calls };
  }

  async function makeQueue(
    chain: ChainLike,
    opts: { chunkSize?: number; seedCache?: Array<[string, string]> } = {},
  ): Promise<{ queue: TranslationQueue; events: SwEvent[]; cache: TranslationCache }> {
    const events: SwEvent[] = [];
    const store = fakeStorage();
    const cache = new TranslationCache({ store });
    // 预填充：键 = 与队列一致的 cacheKeyFn 计算结果（provider=google-free, target=zh-CN）
    for (const [text, value] of opts.seedCache ?? []) {
      const key = await cacheKey('google-free', 'zh-CN', text);
      await cache.set(key, value);
    }
    const queue = new TranslationQueue({
      chain,
      cache,
      cacheKeyFn: (provider, target, text) => cacheKey(provider, target, text),
      providerName: () => 'google-free',
      broadcast: (e) => events.push(e),
      chunkSize: opts.chunkSize,
    });
    return { queue, events, cache };
  }

  it('基本批处理：结果按输入顺序对齐', async () => {
    const { chain } = makeChain([okAll]);
    const { queue } = await makeQueue(chain);
    const res = await queue.translate('r1', [seg('a'), seg('b')], 'auto', 'zh-CN');
    expect(res.items.map((o) => o.text)).toEqual(['译-a', '译-b']);
    expect(res.error).toBeUndefined();
  });

  it('同文本去重：只打一次链路的请求，所有 id 拿到结果', async () => {
    const { chain, calls } = makeChain([okAll]);
    const { queue } = await makeQueue(chain);
    const res = await queue.translate('r2', [seg('a', 'same'), seg('b', 'same'), seg('c', 'other')], 'auto', 'zh-CN');
    expect(calls).toHaveLength(1);
    expect(res.items).toHaveLength(3);
    expect(res.items[0]?.text).toBe(res.items[1]?.text);
    expect(res.items[2]?.text).not.toBe(res.items[0]?.text);
  });

  it('缓存旁路：第二次翻译零链路调用', async () => {
    const { chain, calls } = makeChain([okAll]);
    const { queue } = await makeQueue(chain);
    await queue.translate('r3a', [seg('a')], 'auto', 'zh-CN');
    expect(calls).toHaveLength(1);
    const res2 = await queue.translate('r3b', [seg('a')], 'auto', 'zh-CN');
    expect(calls).toHaveLength(1);
    expect(res2.items[0]?.text).toBe('译-a');
  });

  it('分窗 + 进度事件（PROGRESS 多次 + DONE）', async () => {
    const { chain, calls } = makeChain([okAll]);
    const { queue, events } = await makeQueue(chain, { chunkSize: 2 });
    const res = await queue.translate(
      'r4',
      [seg('1'), seg('2'), seg('3'), seg('4'), seg('5')],
      'auto',
      'zh-CN',
    );
    expect(calls).toHaveLength(3); // 2+2+1
    expect(res.items).toHaveLength(5);
    const progresses = events.filter((e) => e.type === 'TRANSLATION_PROGRESS');
    expect(progresses.map((p) => (p as { done: number }).done)).toEqual([2, 4, 5]);
    const doneEvent = events.at(-1);
    expect(doneEvent?.type).toBe('TRANSLATION_DONE');
  });

  it('链路返回错误段 → item 带 error + 汇总 error', async () => {
    const { chain } = makeChain([
      (segments) => ({
        items: segments.map((s) => ({ id: s.id, text: '', error: { code: 'E_PROVIDER_DOWN' as const } })),
      }),
    ]);
    const { queue } = await makeQueue(chain);
    const res = await queue.translate('r5', [seg('a')], 'auto', 'zh-CN');
    expect(res.items[0]?.error?.code).toBe('E_PROVIDER_DOWN');
    expect(res.error?.code).toBe('E_PROVIDER_DOWN');
  });

  it('取消：后续窗口 E_ABORTED 且 chain.abort() 被调用', async () => {
    let abortCount = 0;
    const gate: { release: (() => void) | null } = { release: null };
    let first = true;
    const state = { aborted: false };
    const chain: ChainLike = {
      async translateBatch(segments) {
        if (first) {
          first = false;
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        if (state.aborted) {
          return { items: segments.map((s) => ({ id: s.id, text: '', error: { code: 'E_ABORTED' as const } })) };
        }
        return okAll(segments);
      },
      abort() {
        abortCount += 1;
        state.aborted = true;
      },
    };
    const { queue, events } = await makeQueue(chain, { chunkSize: 2 });
    const pending = queue.translate('r6', [seg('a'), seg('b'), seg('c'), seg('d'), seg('e')], 'auto', 'zh-CN');
    await sleep(5);
    expect(queue.cancel('r6')).toBe(true);
    gate.release?.();
    const res = await pending;
    expect(abortCount).toBe(1);
    expect(res.items.slice(2).every((o) => o.error?.code === 'E_ABORTED')).toBe(true);
    expect(res.error?.code).toBe('E_ABORTED');
    expect(events.at(-1)?.type).toBe('TRANSLATION_DONE');
  });

  it('缓存命中：广播初始 PROGRESS 增量并直接输出', async () => {
    const { chain, calls } = makeChain([okAll]);
    const { queue, events } = await makeQueue(chain, { seedCache: [['text-a', '已缓存']] });
    const res = await queue.translate('r7', [seg('a')], 'auto', 'zh-CN');
    expect(calls).toHaveLength(0); // 全部命中，链路零调用
    expect(res.items[0]?.text).toBe('已缓存');
    const progresses = events.filter((e) => e.type === 'TRANSLATION_PROGRESS');
    expect(progresses).toHaveLength(1); // 初始命中事件
    expect(events.at(-1)?.type).toBe('TRANSLATION_DONE');
  });
});
