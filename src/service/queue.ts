// 翻译队列（T-005）：请求登记 / 同文本去重 / 缓存旁路 / 分窗进度 / 取消。
// 全依赖注入（chain/cache/broadcast/cacheKeyFn），单测不碰 chrome。

import { LLM_BATCH_SIZE } from '../shared/constants';
import type { SwEvent } from '../shared/messaging';
import type { Language, ProviderError, Segment, TranslatedSegment } from '../shared/types';

export interface ChainLike {
  translateBatch(
    segments: Segment[],
    source: Language | 'auto',
    target: Language,
  ): Promise<{ items: TranslatedSegment[]; error?: ProviderError }>;
  abort(): void;
}

export interface CacheLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export type Broadcast = (event: SwEvent) => void;

export interface QueueDeps {
  chain: ChainLike;
  cache: CacheLike;
  cacheKeyFn: (provider: string, target: string, text: string) => Promise<string>;
  providerName: () => string;
  broadcast: Broadcast;
  /** 分窗大小：默认 LLM 窗口 */
  chunkSize?: number;
}

interface Resolved {
  text: string;
  error?: ProviderError;
}

interface RequestContext {
  aborted: boolean;
}

export class TranslationQueue {
  private readonly active = new Map<string, RequestContext>();

  constructor(private readonly deps: QueueDeps) {}

  async translate(
    requestId: string,
    segmentsIn: Segment[],
    source: Language | 'auto',
    target: Language,
  ): Promise<{ items: TranslatedSegment[]; error?: ProviderError }> {
    const ctx: RequestContext = { aborted: false };
    this.active.set(requestId, ctx);
    try {
      return await this.run(ctx, requestId, segmentsIn, source, target);
    } finally {
      this.active.delete(requestId);
    }
  }

  cancel(requestId: string): boolean {
    const ctx = this.active.get(requestId);
    if (!ctx) return false;
    ctx.aborted = true;
    this.deps.chain.abort();
    return true;
  }

  isAborted(requestId: string): boolean {
    return this.active.get(requestId)?.aborted ?? false;
  }

  private async run(
    ctx: RequestContext,
    requestId: string,
    segmentsIn: Segment[],
    source: Language | 'auto',
    target: Language,
  ): Promise<{ items: TranslatedSegment[]; error?: ProviderError }> {
    const provider = this.deps.providerName();

    // —— 唯一文本分组：text → 出现下标列表 ——
    const leadIndex = new Map<string, number>();
    const occurrences = new Map<string, number[]>();
    segmentsIn.forEach((seg, i) => {
      if (!leadIndex.has(seg.text)) {
        leadIndex.set(seg.text, i);
        occurrences.set(seg.text, []);
      }
      occurrences.get(seg.text)?.push(i);
    });

    // —— 缓存键并行计算 ——
    const keyMap = new Map<string, string>();
    for (const text of leadIndex.keys()) {
      keyMap.set(text, await this.deps.cacheKeyFn(provider, target, text));
    }

    // —— 缓存命中 → 初始进度事件（含同文本全部下标） ——
    const resolution = new Map<string, Resolved>();
    const cachedProgress: TranslatedSegment[] = [];
    let cachedCount = 0;
    for (const [text, key] of keyMap) {
      const hit = await this.deps.cache.get(key);
      if (hit === null) continue;
      resolution.set(text, { text: hit });
      cachedCount += 1;
      for (const idx of occurrences.get(text) ?? []) {
        cachedProgress.push({ id: segmentsIn[idx]?.id ?? String(idx), text: hit });
      }
    }
    if (cachedProgress.length > 0) {
      this.deps.broadcast({
        type: 'TRANSLATION_PROGRESS',
        requestId,
        done: cachedCount,
        total: leadIndex.size,
        items: cachedProgress,
      });
    }

    // —— 未命中：唯一 leading 段组成请求，分窗串行 ——
    const pendingLeads: Segment[] = [];
    for (const [text, leadIdx] of leadIndex) {
      if (resolution.has(text)) continue;
      pendingLeads.push(segmentsIn[leadIdx] as Segment);
    }

    const chunkSize = this.deps.chunkSize ?? LLM_BATCH_SIZE;
    let done = cachedCount;
    let firstError: ProviderError | undefined;
    for (let i = 0; i < pendingLeads.length; i += chunkSize) {
      if (ctx.aborted) {
        for (const seg of pendingLeads.slice(i)) {
          resolution.set(seg.text, { text: '', error: { code: 'E_ABORTED' } });
        }
        break;
      }
      const chunk = pendingLeads.slice(i, i + chunkSize);
      const { items, error } = await this.deps.chain.translateBatch(chunk, source, target);
      const fallback: ProviderError = error ?? { code: 'E_PROVIDER_DOWN', detail: 'no items' };
      for (const seg of chunk) {
        const item = items.find((it) => it.id === seg.id);
        if (item && !item.error && typeof item.text === 'string' && item.text.length > 0) {
          resolution.set(seg.text, { text: item.text });
          await this.deps.cache.set(keyMap.get(seg.text) as string, item.text);
        } else {
          resolution.set(seg.text, {
            text: item?.text ?? '',
            error: item?.error ?? fallback,
          });
        }
      }
      done += chunk.length;
      // 进度事件的 items 映射到**本窗唯一**段（重复文本段由 DONE 兜底渲染）
      const windowItems: TranslatedSegment[] = items.filter(
        (it) => it && typeof it.id === 'string',
      );
      this.deps.broadcast({
        type: 'TRANSLATION_PROGRESS',
        requestId,
        done,
        total: leadIndex.size,
        items: windowItems,
      });
    }

    if (firstError === undefined) {
      for (const resolved of resolution.values()) {
        if (resolved.error) {
          firstError = resolved.error;
          break;
        }
      }
    }

    // —— 最终映射：每个原始下标都拿到结果 ——
    const items: TranslatedSegment[] = segmentsIn.map((seg) => {
      const resolved = resolution.get(seg.text);
      if (!resolved) return { id: seg.id, text: '', error: { code: 'E_PROVIDER_DOWN' as const } };
      if (resolved.error) return { id: seg.id, text: '', error: resolved.error };
      return { id: seg.id, text: resolved.text };
    });

    this.deps.broadcast({ type: 'TRANSLATION_DONE', requestId, error: firstError });
    return { items, error: firstError };
  }
}
