// 契约镜像：.agent/spec/contracts/translation-provider.md + messaging.md
// 修改前必须先改契约文件（P1 规范先于实现）。

export type Language = string; // BCP-47，如 "zh-CN" | "en"；source 允许 "auto"

export interface Segment {
  id: string;
  text: string;
  /** inline 占位符标记（形如 [[1]]），渲染时由 content 侧映射还原 */
  placeholders?: string[];
}

export interface TranslatedSegment {
  id: string;
  /** 出错时为空字符串 */
  text: string;
  error?: ProviderError;
}

export type ProviderError =
  | { code: 'E_RATE_LIMITED'; retryAfterMs?: number }
  | { code: 'E_TIMEOUT' }
  | { code: 'E_NO_KEY' }
  | { code: 'E_PROVIDER_DOWN'; detail?: string }
  | { code: 'E_ABORTED' }
  /** T-027 关键帧：captureVisibleTab 被拒（activeTab 授予不在场；契约 messaging.md「关键帧通道」） */
  | { code: 'E_NO_GESTURE'; detail?: string };

export type ProviderType = 'openai-compatible' | 'google-free' | 'microsoft-free';

export interface ProviderConfig {
  type: ProviderType;
  enabled: boolean;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  promptTemplate?: string;
}

export type StyleMode = 'bilingual' | 'translation-only';
export type Theme = 'auto' | 'light' | 'dark';

/** 非敏感公共设置：扩展页（PDF 阅读器等）可读取，绝不包含 provider/apiKey。 */
export interface PublicSettings {
  targetLang: Language;
  /** PDF 页入口开关（T-028f）；content 的 PDF 模式只读此字段 */
  pdfEntryEnabled: boolean;
}

export interface ExtensionSettings {
  providers: ProviderConfig[];
  targetLang: Language;
  autoTranslateSites: string[];
  styleMode: StyleMode;
  theme: Theme;
  hoverEnabled: boolean;
  selectionEnabled: boolean;
  /** T-028f：原生 PDF 页显示「用 Bilinea 打开」入口（默认开） */
  pdfEntryEnabled: boolean;
  /** M3-1 UI 可调（默认 18，clamp 12~40） */
  subtitleFontSize?: number;
  /** 字幕译文行离播放器底边（默认 84，clamp 0~600） */
  subtitleBottom?: number;
  /** 划词气泡译文字号（默认 13，clamp 10~28） */
  bubbleFontSize?: number;
  /** 悬停卡字号（默认 13，clamp 10~28） */
  hoverFontSize?: number;
  /** 划词/悬停浮层相对锚点偏移，共用（默认 12，clamp 0~80） */
  floatOffset?: number;
}

export interface TranslationProviderLimits {
  batchLimit: number;
  maxCharsPerReq: number;
}

export interface TranslationProvider extends TranslationProviderLimits {
  readonly name: ProviderType;
  detectLanguage(text: string): Promise<Language>;
  translateBatch(
    segments: Segment[],
    source: Language | 'auto',
    target: Language,
  ): Promise<TranslatedSegment[]>;
  abort(): void;
}

/** SW 层统一 Result（契约：不裸 throw 给 UI） */
export type Result<T> = { ok: true; value: T } | { ok: false; error: ProviderError };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(error: ProviderError): Result<T> {
  return { ok: false, error };
}

/** 整批失败判定（ProviderChain 降级依据） */
export function isAllFailed(items: TranslatedSegment[]): boolean {
  return items.length > 0 && items.every((i) => i.error !== undefined);
}

export function failedAllOf(ids: readonly string[], error: ProviderError): TranslatedSegment[] {
  return ids.map((id) => ({ id, text: '', error }));
}
