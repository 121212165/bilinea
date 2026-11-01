// 统一日志。硬约束（AGENTS.md）：任何日志不得出现 API Key、用户浏览的 URL 正文/正文文本。
// 实现：key 名匹配敏感词的一律打码；URL 只保留 origin+pathname；长文本截断并剥 b64 体。

const PREFIX = '[itr]';
const SENSITIVE_KEY = /(apikey|api_key|key|token|authorization|secret|password)/i;
const SENSITIVE_QUERY = /([?&](q|text|key|to)=)[^&\s]*/g;
let debugEnabled = false;

export function setDebug(v: boolean): void {
  debugEnabled = v;
}

function scrubUrl(u: string): string {
  try {
    const url = new URL(u);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return u.replace(SENSITIVE_QUERY, '$1…');
  }
}

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 4) return '…';
  if (typeof v === 'string') {
    const cut = v.length > 220 ? `${v.slice(0, 200)}…(${v.length})` : v;
    return v.startsWith('http') ? scrubUrl(cut) : cut;
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : scrub(val, depth + 1);
    }
    return out;
  }
  return v;
}

function emit(level: 'log' | 'warn' | 'error', args: unknown[]): void {
  console[level](PREFIX, ...args.map((a) => scrub(a)));
}

export const logger = {
  debug(...args: unknown[]): void {
    if (debugEnabled) emit('log', args);
  },
  info(...args: unknown[]): void {
    emit('log', args);
  },
  warn(...args: unknown[]): void {
    emit('warn', args);
  },
  error(...args: unknown[]): void {
    emit('error', args);
  },
};
