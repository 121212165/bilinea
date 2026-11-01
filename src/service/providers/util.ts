// Provider 适配器共用底座：超时 / 429 退避 / 错误归一化（契约 translation-provider.md 行为 #3-#5）

import type { ProviderError, Segment } from '../../shared/types';

export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

// ---- 信号类（内部控制流，不外抛）----

export class RateLimitSignal extends Error {
  constructor(readonly retryAfterMs?: number) {
    super('rate-limited');
    this.name = 'RateLimitSignal';
  }
}
export class TimeoutSignal extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutSignal';
  }
}
export class AbortedSignal extends Error {
  constructor() {
    super('aborted');
    this.name = 'AbortedSignal';
  }
}
export class DownSignal extends Error {
  constructor(readonly detail?: string) {
    super(`down:${detail ?? ''}`);
    this.name = 'DownSignal';
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  factor: number;
  maxDelayMs?: number;
}

/** 对 429 按指数退避重试（1s/2s/4s，最多 retries 次）；其它错误直接抛出。 */
export async function retryOnRateLimit<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
  isAborted?: () => boolean,
): Promise<T> {
  let delay = opts.baseDelayMs;
  const max = opts.maxDelayMs ?? 30_000;
  let attempt = 0;
  for (;;) {
    if (isAborted?.()) throw new AbortedSignal();
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof RateLimitSignal)) throw e;
      attempt += 1;
      if (attempt > opts.retries) throw e;
      const wait = Math.min(e.retryAfterMs ? Math.max(e.retryAfterMs, delay) : delay, max);
      await sleep(wait);
      delay = Math.min(delay * opts.factor, max);
    }
  }
}

/** 带超时与外置中断的 fetch。超时→TimeoutSignal；外停→AbortedSignal；网络错→DownSignal。 */
export async function fetchWithTimeout(
  fetchFn: FetchFn,
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const ac = new AbortController();
  const onExternal = () => ac.abort(new DOMException('aborted', 'AbortError'));
  externalSignal?.addEventListener('abort', onExternal, { once: true });
  const timer = setTimeout(() => ac.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: ac.signal });
  } catch (e) {
    if (externalSignal?.aborted) throw new AbortedSignal();
    if (e instanceof DOMException) {
      if (e.name === 'TimeoutError') throw new TimeoutSignal();
    }
    throw new DownSignal(String((e as Error)?.name ?? 'fetch') + ':' + msg(e));
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternal);
  }
}

function msg(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 160);
}

/** 状态码检查：429 → RateLimitSignal（携带 retry-after），非 2xx → DownSignal。 */
export function httpResponseCheck(res: Response): void {
  if (res.status === 429) {
    const ra = res.headers.get('retry-after');
    const sec = ra === null ? undefined : Number(ra);
    throw new RateLimitSignal(sec !== undefined && !Number.isNaN(sec) ? sec * 1000 : undefined);
  }
  if (!res.ok) throw new DownSignal(`HTTP ${res.status}`);
}

/** 读取 JSON body；非 JSON → DownSignal。 */
export async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new DownSignal('invalid JSON body');
  }
}

/** 任意异常 → ProviderError（契约：不向上抛）。 */
export function toProviderError(e: unknown): ProviderError {
  if (e instanceof RateLimitSignal) return { code: 'E_RATE_LIMITED', retryAfterMs: e.retryAfterMs };
  if (e instanceof TimeoutSignal) return { code: 'E_TIMEOUT' };
  if (e instanceof AbortedSignal) return { code: 'E_ABORTED' };
  if (e instanceof DownSignal) return { code: 'E_PROVIDER_DOWN', detail: e.detail };
  return { code: 'E_PROVIDER_DOWN', detail: msg(e) };
}

/** 便捷构造：E_ABORTED item 错误。 */
export function abortErrAborted(): ProviderError {
  return { code: 'E_ABORTED' };
}

/** 切分窗口：每窗 ≤ batchLimit 条且 ≤ maxChars 字符（至少 1 条，超长段落单独成窗）。 */
export function chunkWindows(
  segments: readonly Segment[],
  batchLimit: number,
  maxChars: number,
): Segment[][] {
  const windows: Segment[][] = [];
  let cur: Segment[] = [];
  let curLen = 0;
  for (const seg of segments) {
    const len = seg.text.length;
    if (cur.length > 0 && (cur.length >= batchLimit || curLen + len > maxChars)) {
      windows.push(cur);
      cur = [];
      curLen = 0;
    }
    cur.push(seg);
    curLen += len;
  }
  if (cur.length > 0) windows.push(cur);
  return windows;
}

/** 宽松解析 LLM 输出为 string[]：容忍 ```json 围栏与前后杂白。 */
export function parseStringArrayLoose(content: string): string[] | null {
  let text = content.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) text = fenced[1] ?? text;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((x) => typeof x === 'string')) return null;
    return parsed as string[];
  } catch {
    return null;
  }
}
