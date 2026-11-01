// 全局常量：数值来源见 .agent/spec/arch.md 与对应契约。

export const API_VERSION = '0.1.0';
export const EXT_PREFIX = 'itr-';

/** OpenAI 兼容（LLM）窗口限制 */
export const LLM_BATCH_SIZE = 10;
export const LLM_MAX_CHARS_PER_REQ = 16000;
export const LLM_TIMEOUT_MS = 30_000;

/** 免费机翻（Google / Microsoft）窗口限制：礼貌限速 + 小批量 */
export const MT_BATCH_SIZE = 8;
export const MT_MAX_CHARS_PER_REQ = 4000;
export const MS_BATCH_SIZE = 50;
export const MS_MAX_CHARS_PER_REQ = 20_000;
export const MT_MIN_INTERVAL_MS = 250;

/** 429 指数退避（契约 #3）：最多 3 次重试，1s → 2s → 4s */
export const RATE_LIMIT_RETRIES = 3;
export const RATE_LIMIT_BASE_DELAY_MS = 1_000;
export const RATE_LIMIT_FACTOR = 2;

/** 长文本按句拆分阈值 */
export const LONG_TEXT_SPLIT_CHARS = 4000;

/** 缓存（ADR-0007） */
export const CACHE_KEY_PREFIX = 'itr_cache:';
export const CACHE_LIMIT_BYTES = 20 * 1024 * 1024;

export const DEFAULT_PROMPT = [
  'You are a precise translation engine used for bilingual reading.',
  'Input is a JSON array of source items; output MUST be ONLY a JSON array of translated strings, identical order and identical length.',
  'Rules:',
  '1) Preserve inline placeholders that look like [[1]], [[2]] exactly as written.',
  '2) No explanations, no quotes, no extra markup.',
  '3) Translate to the requested target language (BCP-47); detect source language automatically if unspecified.',
  '4) Keep the same sentence structure; do not merge or split items.',
].join('\n');

/** 字幕导出 AI 简述（T-026 / M3-3）：单发 chat 通道 */
export const SUMMARY_MAX_CHARS = 6000;
export const SUMMARY_SYSTEM_PROMPT =
  'You are a subtitle summarizer. Write 3~5 concise sentences covering the topic and key points. Reply with the summary text only.';
