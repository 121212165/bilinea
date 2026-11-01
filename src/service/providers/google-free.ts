// Google 免费机翻端点（非官方 gtx 接口，随时可能失效——靠-Martian-AcceptanceChain 降级兜底）
// 契约：.agent/spec/contracts/translation-provider.md（行为 #1-#7）

import {
  MT_BATCH_SIZE,
  MT_MAX_CHARS_PER_REQ,
  MT_MIN_INTERVAL_MS,
  RATE_LIMIT_BASE_DELAY_MS,
  RATE_LIMIT_FACTOR,
  RATE_LIMIT_RETRIES,
} from '../../shared/constants';
import { logger } from '../../shared/logger';
import { dominantScript } from '../../shared/lang';
import type {
  Language,
  Segment,
  TranslatedSegment,
  TranslationProvider,
} from '../../shared/types';
import {
  AbortedSignal,
  DownSignal,
  abortErrAborted,
  chunkWindows,
  fetchWithTimeout,
  httpResponseCheck,
  retryOnRateLimit,
  toProviderError,
  type FetchFn,
} from './util';

const SEP = '@@@itrsep@@@';

export interface GoogleFreeOpts {
  baseDelayMs?: number;
}

export class GoogleFreeProvider implements TranslationProvider {
  readonly name = 'google-free' as const;
  readonly batchLimit = MT_BATCH_SIZE;
  readonly maxCharsPerReq = MT_MAX_CHARS_PER_REQ;

  private aborted = false;
  private readonly controls = new Set<AbortController>();
  private lastRequestAt = 0;

  constructor(
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
    private readonly opts: GoogleFreeOpts = {},
  ) {}

  abort(): void {
    this.aborted = true;
    for (const c of this.controls) c.abort();
    this.controls.clear();
  }

  async detectLanguage(text: string): Promise<Language> {
    try {
      const data = await this.query(text.slice(0, 200), 'auto', 'zh-CN');
      const code = (data as unknown[])[2];
      return typeof code === 'string' && /^[a-z]{2,3}(-[\w-]+)*$/.test(code) ? code : 'auto';
    } catch {
      return 'auto';
    }
  }

  async translateBatch(
    segments: Segment[],
    source: Language | 'auto',
    target: Language,
  ): Promise<TranslatedSegment[]> {
    const windows = chunkWindows(segments, this.batchLimit, this.maxCharsPerReq);
    const out: TranslatedSegment[] = [];
    for (const win of windows) {
      if (this.aborted) {
        out.push(...win.map((s) => ({ id: s.id, text: '', error: abortErrAborted() })));
        continue;
      }
      try {
        const items = await this.translateWindow(win, source, target);
        out.push(...items);
      } catch (e) {
        const error =
          this.aborted || e instanceof AbortedSignal ? abortErrAborted() : toProviderError(e);
        out.push(...win.map((s) => ({ id: s.id, text: '', error })));
      }
    }
    return out;
  }

  /**
   * T-018 语言分桶（契约 translation-provider.md「语言分桶」）：
   * gtx sl=auto 是整批检测——中英混批会把整批判成目标语言，非目标语言段被原样复制
   * （staging 实测复现）。故先按主文字体系分桶，桶内拼接，桶间串行。
   */
  private async translateWindow(
    win: Segment[],
    source: Language | 'auto',
    target: Language,
  ): Promise<TranslatedSegment[]> {
    const buckets = new Map<string, Segment[]>();
    for (const seg of win) {
      const key = dominantScript(seg.text);
      const list = buckets.get(key);
      if (list) list.push(seg);
      else buckets.set(key, [seg]);
    }
    if (buckets.size <= 1) return this.translateBucket(win, source, target);
    const out: TranslatedSegment[] = [];
    for (const list of buckets.values()) {
      if (this.aborted) {
        out.push(...list.map((s) => ({ id: s.id, text: '', error: abortErrAborted() })));
        continue;
      }
      out.push(...(await this.translateBucket(list, source, target)));
    }
    // 按原窗口顺序回排（queue 按 id 建映射，顺序不影响正确性，这里求稳）
    const byId = new Map(out.map((o) => [o.id, o]));
    return win.map(
      (s) => byId.get(s.id) ?? { id: s.id, text: '', error: { code: 'E_PROVIDER_DOWN' } },
    );
  }

  /**
   * 批翻译：先尝试单片拼接（免费端点小请求普及限制），解析出分隔符段落数不匹配则逐段回退。
   * 逐段回退只用于「格式问题」；限流/网络类错误直接整窗映射，避免雪崩。
   */
  private async translateBucket(
    win: Segment[],
    source: Language | 'auto',
    target: Language,
  ): Promise<TranslatedSegment[]> {
    const sl = source === 'auto' ? 'auto' : source;
    // 第一策略：拼接批量
    const combined = await retryOnRateLimit(
      () => this.combinedText(win.map((s) => s.text).join(`\n\n${SEP}\n\n`), sl, target),
      {
        retries: RATE_LIMIT_RETRIES,
        baseDelayMs: this.opts.baseDelayMs ?? RATE_LIMIT_BASE_DELAY_MS,
        factor: RATE_LIMIT_FACTOR,
      },
      () => this.aborted,
    );
    const parts = combined.split(SEP).map((p) => p.trim());
    if (parts.length === win.length) {
      return win.map((seg, i) => ({ id: seg.id, text: parts[i] ?? '' }));
    }
    // 到这说明是「段数不匹配」类格式问题：回退逐段（礼貌限速）。
    // 限流/中断/网络/HTTP/JSON 在 combinedText 内已信号化上抛，不会走到这里。
    logger.warn(`google-free: 批量解析段数不匹配（${parts.length}/${win.length}），回退逐段`);
    return this.translatePerSegment(win, sl, target);
  }

  private async translatePerSegment(
    win: Segment[],
    sl: Language | 'auto',
    target: Language,
  ): Promise<TranslatedSegment[]> {
    const out: TranslatedSegment[] = [];
    for (const seg of win) {
      if (this.aborted) {
        out.push({ id: seg.id, text: '', error: abortErrAborted() });
        continue;
      }
      try {
        const combined = await retryOnRateLimit(
          () => this.combinedText(seg.text, sl, target),
          {
            retries: RATE_LIMIT_RETRIES,
            baseDelayMs: this.opts.baseDelayMs ?? RATE_LIMIT_BASE_DELAY_MS,
            factor: RATE_LIMIT_FACTOR,
          },
          () => this.aborted,
        );
        out.push({ id: seg.id, text: combined });
      } catch (e) {
        out.push({ id: seg.id, text: '', error: toProviderError(e) });
      }
    }
    return out;
  }

  /** 发起一次 gtx 请求并返回拼接译文；HTTP/解析错误直接上抛信号。 */
  private async combinedText(text: string, sl: Language | 'auto', target: Language): Promise<string> {
    const data = await this.query(text, sl, target);
    const rows = (data as unknown[])[0];
    if (!Array.isArray(rows)) throw new DownSignal('google: missing data[0]');
    const combined = rows
      .map((r) => (Array.isArray(r) && typeof (r as unknown[])[0] === 'string' ? (r as unknown[])[0] : ''))
      .join('');
    return combined;
  }

  private async query(text: string, sl: Language | 'auto', target: Language): Promise<unknown> {
    const url =
      `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t` +
      `&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(target)}&q=${encodeURIComponent(text)}`;
    await this.throttle();
    const ac = new AbortController();
    this.controls.add(ac);
    try {
      const res = await fetchWithTimeout(this.fetchFn, url, { method: 'GET' }, 30_000, ac.signal);
      httpResponseCheck(res);
      const raw = await res.text();
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw new DownSignal('google: invalid JSON body');
      }
    } finally {
      this.controls.delete(ac);
    }
  }

  /** 免费端点礼貌限速：请求间隔 ≥ MT_MIN_INTERVAL_MS */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = MT_MIN_INTERVAL_MS - (now - this.lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }
}
