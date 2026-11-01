// Microsoft 免费机翻（Edge 免费认证 + Cognitive Translator API，非官方通道，失效靠降级兜底）
// 契约：.agent/spec/contracts/translation-provider.md

import {
  MS_BATCH_SIZE,
  MS_MAX_CHARS_PER_REQ,
  MT_MIN_INTERVAL_MS,
  RATE_LIMIT_BASE_DELAY_MS,
  RATE_LIMIT_FACTOR,
  RATE_LIMIT_RETRIES,
} from '../../shared/constants';
import type {
  Language,
  Segment,
  TranslatedSegment,
  TranslationProvider,
} from '../../shared/types';
import {
  DownSignal,
  abortErrAborted,
  chunkWindows,
  fetchWithTimeout,
  httpResponseCheck,
  readJson,
  retryOnRateLimit,
  toProviderError,
  type FetchFn,
} from './util';

const AUTH_URL = 'https://edge.microsoft.com/translate/auth';
const TRANSLATE_URL = 'https://api.cognitive.microsofttranslator.com/translate';

interface MsTranslation {
  text?: string;
  to?: string;
}
interface MsItem {
  detectedLanguage?: { language?: string };
  translations?: MsTranslation[];
}

export interface MicrosoftOpts {
  /** 测试可注入：覆盖退避基准延迟 */
  baseDelayMs?: number;
}

export class MicrosoftFreeProvider implements TranslationProvider {
  readonly name = 'microsoft-free' as const;
  readonly batchLimit = MS_BATCH_SIZE;
  readonly maxCharsPerReq = MS_MAX_CHARS_PER_REQ;

  private aborted = false;
  private readonly controls = new Set<AbortController>();
  private lastRequestAt = 0;
  private token: { value: string; exp: number } | null = null;
  private tokenPending: Promise<string> | null = null;

  constructor(
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
    private readonly opts: MicrosoftOpts = {},
  ) {}

  abort(): void {
    this.aborted = true;
    for (const c of this.controls) c.abort();
    this.controls.clear();
  }

  async detectLanguage(text: string): Promise<Language> {
    try {
      const items = await this.translateArray([text.slice(0, 200)], 'auto', 'zh-CN');
      const found = (items as MsItem[])[0]?.detectedLanguage?.language;
      return typeof found === 'string' ? found : 'auto';
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
        out.push(...(await this.translateWindow(win, source, target)));
      } catch (e) {
        const error = this.aborted ? abortErrAborted() : toProviderError(e);
        out.push(...win.map((s) => ({ id: s.id, text: '', error })));
      }
    }
    return out;
  }

  private async translateWindow(
    win: Segment[],
    source: Language | 'auto',
    target: Language,
  ): Promise<TranslatedSegment[]> {
    const items = await retryOnRateLimit(
      () => this.translateArray(win.map((s) => s.text), source, target),
      {
        retries: RATE_LIMIT_RETRIES,
        baseDelayMs: this.opts.baseDelayMs ?? RATE_LIMIT_BASE_DELAY_MS,
        factor: RATE_LIMIT_FACTOR,
      },
      () => this.aborted,
    );
    const arr = items as MsItem[];
    if (!Array.isArray(arr) || arr.length !== win.length) {
      return win.map((s) => ({
        id: s.id,
        text: '',
        error: { code: 'E_PROVIDER_DOWN' as const, detail: 'ms: unexpected body shape' },
      }));
    }
    return win.map((seg, i) => {
      const trs = arr[i]?.translations ?? [];
      const text = trs.find((t) => t.to === target)?.text ?? trs[0]?.text;
      return typeof text === 'string'
        ? { id: seg.id, text }
        : { id: seg.id, text: '', error: { code: 'E_PROVIDER_DOWN' as const, detail: 'ms: missing translation' } };
    });
  }

  private async translateArray(
    texts: string[],
    source: Language | 'auto',
    target: Language,
  ): Promise<unknown> {
    const token = await this.ensureToken();
    const url =
      `${TRANSLATE_URL}?api-version=3.0&to=${encodeURIComponent(target)}` +
      (source !== 'auto' ? `&from=${encodeURIComponent(source)}` : '');
    await this.throttle();
    const ac = new AbortController();
    this.controls.add(ac);
    try {
      const res = await fetchWithTimeout(
        this.fetchFn,
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(texts.map((t) => ({ Text: t }))),
        },
        30_000,
        ac.signal,
      );
      httpResponseCheck(res);
      return await readJson(res);
    } finally {
      this.controls.delete(ac);
    }
  }

  /** Edge 免费认证：token 复用（约 10 分钟），并发请求共享同一次取票 */
  private async ensureToken(): Promise<string> {
    if (this.token && Date.now() < this.token.exp - 30_000) return this.token.value;
    if (this.tokenPending) return this.tokenPending;
    this.tokenPending = (async () => {
      const ac = new AbortController();
      this.controls.add(ac);
      try {
        const res = await fetchWithTimeout(this.fetchFn, AUTH_URL, { method: 'GET' }, 15_000, ac.signal);
        httpResponseCheck(res);
        const jwt = (await res.text()).trim();
        if (jwt.length < 8) throw new DownSignal('ms: empty auth token');
        this.token = { value: jwt, exp: jwtExp(jwt) ?? Date.now() + 9 * 60_000 };
        return jwt;
      } finally {
        this.controls.delete(ac);
        this.tokenPending = null;
      }
    })();
    return this.tokenPending;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = MT_MIN_INTERVAL_MS - (now - this.lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastRequestAt = Date.now();
  }
}

function jwtExp(jwt: string): number | null {
  try {
    const payload = jwt.split('.')[1] ?? '';
    const parts = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof parts.exp === 'number' ? parts.exp * 1000 : null;
  } catch {
    return null;
  }
}
