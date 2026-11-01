// OpenAI 兼容适配器（DeepSeek / Qwen / Doubao / Gemini-OpenAI代理 / OpenAI / 本地 Ollama 均适用）
// 契约：.agent/spec/contracts/translation-provider.md

import {
  DEFAULT_PROMPT,
  LLM_BATCH_SIZE,
  LLM_MAX_CHARS_PER_REQ,
  LLM_TIMEOUT_MS,
  RATE_LIMIT_BASE_DELAY_MS,
  RATE_LIMIT_FACTOR,
  RATE_LIMIT_RETRIES,
} from '../../shared/constants';
import type {
  Language,
  ProviderConfig,
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
  parseStringArrayLoose,
  readJson,
  retryOnRateLimit,
  toProviderError,
  type FetchFn,
} from './util';

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenAIOpts {
  /** 测试可注入：覆盖退避/超时数值 */
  baseDelayMs?: number;
  timeoutMs?: number;
}

export class OpenAICompatibleProvider implements TranslationProvider {
  readonly name = 'openai-compatible' as const;
  readonly batchLimit = LLM_BATCH_SIZE;
  readonly maxCharsPerReq = LLM_MAX_CHARS_PER_REQ;

  private aborted = false;
  private readonly controls = new Set<AbortController>();

  constructor(
    private readonly cfg: ProviderConfig,
    private readonly fetchFn: FetchFn = (u, i) => fetch(u, i),
    private readonly opts: OpenAIOpts = {},
  ) {}

  abort(): void {
    this.aborted = true;
    for (const c of this.controls) c.abort();
    this.controls.clear();
  }

  async detectLanguage(text: string): Promise<Language> {
    const sample = text.slice(0, 300).replace(/\s+/g, ' ').trim();
    if (!sample || this.aborted) return 'auto';
    try {
      const content = await this.requestJson(
        [
          { role: 'system', content: 'You are a language detector. Reply ONLY with the BCP-47 code, e.g. "en" or "zh-CN".' },
          { role: 'user', content: sample },
        ],
        this.cfg.model ?? '',
      );
      const code = content.trim().toLowerCase().replace(/["'`]/g, '');
      return /^[a-z]{2,3}(-[0-9a-z]+)*$/.test(code) ? code : 'auto';
    } catch {
      return 'auto';
    }
  }

  async translateBatch(
    segments: Segment[],
    source: Language | 'auto',
    target: Language,
  ): Promise<TranslatedSegment[]> {
    if (!this.cfg.apiKey || !this.cfg.baseUrl || !this.cfg.model) {
      return segments.map((s) => ({ id: s.id, text: '', error: { code: 'E_NO_KEY' as const } }));
    }
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
        if (this.aborted) {
          out.push(...win.map((s) => ({ id: s.id, text: '', error: abortErrAborted() })));
        } else {
          const error = toProviderError(e);
          out.push(...win.map((s) => ({ id: s.id, text: '', error })));
        }
      }
    }
    return out;
  }

  /** 单窗口一次请求；[length 不匹配] 仅宽容重试一次（换更严格指令）；其余异常上抛。 */
  private async translateWindow(
    win: Segment[],
    source: Language | 'auto',
    target: Language,
  ): Promise<TranslatedSegment[]> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const content = await retryOnRateLimit(
          () => this.requestJson(this.buildMessages(win, source, target, attempt), this.cfg.model ?? ''),
          {
            retries: RATE_LIMIT_RETRIES,
            baseDelayMs: this.opts.baseDelayMs ?? RATE_LIMIT_BASE_DELAY_MS,
            factor: RATE_LIMIT_FACTOR,
          },
          () => this.aborted,
        );
        const arr = parseStringArrayLoose(content);
        if (!arr) throw new DownSignal('openai: output is not a JSON array');
        if (arr.length !== win.length) {
          throw new DownSignal(`openai: expected ${win.length} items, got ${arr.length}`);
        }
        return win.map((seg, i) => ({ id: seg.id, text: arr[i] ?? '' }));
      } catch (e) {
        if (!(e instanceof DownSignal) || attempt === 2) throw e;
      }
    }
    throw new DownSignal('openai: unreachable'); // 循环必然 return/throw，类型兜底
  }

  private buildMessages(win: Segment[], source: Language | 'auto', target: Language, attempt: number): ChatMessage[] {
    const system = this.cfg.promptTemplate?.trim() ? this.cfg.promptTemplate : DEFAULT_PROMPT;
    const payload = {
      source: source === 'auto' ? null : source,
      target,
      items: win.map((s) => ({ id: s.id, text: s.text })),
    };
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(payload) },
    ];
    if (attempt === 2) {
      // 独立消息而非拼接，保证第一条 user 消息是纯 JSON（兼容解析流水线）
      messages.push({
        role: 'user',
        content:
          'IMPORTANT: your previous reply was not a JSON array of strings with matching length. Reply ONLY with the JSON array.',
      });
    }
    return messages;
  }

  /** 单发 chat 请求（T-026 AI 简述通道，契约 translation-provider.md「附加通道」）：
   * 复用 requestJson 的 HTTP/超时/中止基建与 429 退避；不要求 JSON 数组输出。
   * 空输出校验由调用方负责。 */
  async chatComplete(system: string, user: string): Promise<string> {
    if (!this.cfg.apiKey || !this.cfg.baseUrl || !this.cfg.model) {
      throw new DownSignal('openai: missing apiKey/baseUrl/model');
    }
    return retryOnRateLimit(
      () =>
        this.requestJson(
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          this.cfg.model ?? '',
        ),
      {
        retries: RATE_LIMIT_RETRIES,
        baseDelayMs: this.opts.baseDelayMs ?? RATE_LIMIT_BASE_DELAY_MS,
        factor: RATE_LIMIT_FACTOR,
      },
      () => this.aborted,
    );
  }

  /** 发起单次 chat/completions；只做网络/HTTP 层检查，解析成败由调用方负责。 */
  private async requestJson(messages: ChatMessage[], model: string): Promise<string> {
    const base = (this.cfg.baseUrl ?? '').replace(/\/+$/, '');
    const ac = new AbortController();
    this.controls.add(ac);
    try {
      const res = await fetchWithTimeout(
        this.fetchFn,
        `${base}/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey ?? ''}` },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages,
          }),
        },
        this.opts.timeoutMs ?? LLM_TIMEOUT_MS,
        ac.signal,
      );
      httpResponseCheck(res);
      const body = (await readJson(res)) as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new DownSignal('openai: no message.content');
      return content;
    } finally {
      this.controls.delete(ac);
    }
  }
}
