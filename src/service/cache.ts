// 缓存（ADR-0007）：键 = sha256(provider|target|text) 前 24 hex；LRU 上限 20MB；storage.local 持久。
import { CACHE_KEY_PREFIX, CACHE_LIMIT_BYTES } from '../shared/constants';
import type { StorageLike } from './storage';

const META_KEY = 'itr_cache_meta';

interface MetaItem {
  ts: number;
  size: number;
}

export interface CacheDeps {
  store: StorageLike;
  limitBytes?: number;
}

export class TranslationCache {
  private memory = new Map<string, string>();
  private meta: Record<string, MetaItem> = {};
  private loaded = false;

  constructor(private readonly deps: CacheDeps) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const obj = await this.deps.store.get(META_KEY);
    const meta = obj[META_KEY];
    if (meta && typeof meta === 'object') {
      this.meta = meta as Record<string, MetaItem>;
    }
    this.loaded = true;
  }

  private persistMeta(): Promise<void> {
    return this.deps.store.set({ [META_KEY]: this.meta });
  }

  async get(key: string): Promise<string | null> {
    await this.ensureLoaded();
    const mem = this.memory.get(key);
    if (mem !== undefined) {
      this.touch(key);
      return mem;
    }
    const obj = await this.deps.store.get(key);
    const value = obj[key];
    if (typeof value !== 'string') return null;
    this.memory.set(key, value);
    this.touch(key);
    return value;
  }

  async set(key: string, text: string): Promise<void> {
    await this.ensureLoaded();
    const size = new TextEncoder().encode(text).length;
    if (size > this.limit) return; // 单条超限丢弃（≈整篇长文也 < 20MB，防御性）
    this.memory.set(key, text);
    this.meta[key] = { ts: Date.now(), size };
    await this.deps.store.set({ [key]: text });
    await this.persistMeta(); // ← include prune before this?
    await this.prune();
  }

  async clear(): Promise<number> {
    await this.ensureLoaded();
    const keys = Object.keys(this.meta);
    if (keys.length > 0) await this.deps.store.remove(keys);
    this.memory.clear();
    const removed = keys.length;
    this.meta = {};
    await this.persistMeta();
    return removed;
  }

  private get limit(): number {
    return this.deps.limitBytes ?? CACHE_LIMIT_BYTES;
  }

  private touch(key: string): void {
    const m = this.meta[key];
    if (m) m.ts = Date.now();
  }

  /** 超限 LRU：按 ts 升序淘汰 */
  private async prune(): Promise<void> {
    await this.ensureLoaded();
    let total = Object.values(this.meta).reduce((sum, m) => sum + m.size, 0);
    if (total <= this.limit) return;
    const entries = Object.entries(this.meta).sort((a, b) => (a[1].ts ?? 0) - (b[1].ts ?? 0));
    const evicted: string[] = [];
    for (const [key, m] of entries) {
      if (total <= this.limit) break;
      total -= m.size;
      evicted.push(key);
      delete this.meta[key];
      this.memory.delete(key);
    }
    if (evicted.length > 0) await this.deps.store.remove(evicted);
    await this.persistMeta();
  }
}

/** 缓存键：sha256(provider|target|text) 前 24 hex（SW 与 Node 测试均可，TS 无 Buffer 依赖 dom lib） */
export async function cacheKey(providerName: string, target: string, text: string): Promise<string> {
  const data = new TextEncoder().encode(`${providerName}|${target}|${text}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return CACHE_KEY_PREFIX + hex.slice(0, 24);
}
