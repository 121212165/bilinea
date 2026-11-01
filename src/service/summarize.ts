// T-026 字幕导出 AI 简述：走既有 openai-compatible 通道（SW 持 Key，分层红线零触碰）。
// 契约：messaging.md §SUMMARIZE_TEXT + translation-provider.md「附加通道」。
import { SUMMARY_SYSTEM_PROMPT } from '../shared/constants';
import type { ExtensionSettings, ProviderError } from '../shared/types';
import { OpenAICompatibleProvider } from './providers/openai-compatible';
import { toProviderError, type FetchFn } from './providers/util';

export type SummaryResult = { text: string } | { error: ProviderError };

const DEFAULT_FETCH: FetchFn = (u, i) => fetch(u, i);

/** 摘要系统提示：内插目标语言（settings.targetLang，默认 zh-CN） */
function buildSystemPrompt(targetLang: string): string {
  return `${SUMMARY_SYSTEM_PROMPT} Write the summary in ${targetLang}.`;
}

export async function summarizeText(
  settings: ExtensionSettings,
  text: string,
  targetLang: string,
  fetchFn: FetchFn = DEFAULT_FETCH,
): Promise<SummaryResult> {
  const cfg = settings.providers.find(
    (p) => p.enabled && p.type === 'openai-compatible' && p.apiKey && p.baseUrl && p.model,
  );
  if (!cfg) return { error: { code: 'E_NO_KEY' } };
  const provider = new OpenAICompatibleProvider(cfg, fetchFn);
  try {
    const content = await provider.chatComplete(buildSystemPrompt(targetLang), text);
    const clean = content.trim();
    if (!clean) return { error: { code: 'E_PROVIDER_DOWN', detail: 'empty summary' } };
    return { text: clean };
  } catch (e) {
    return { error: toProviderError(e) };
  }
}
