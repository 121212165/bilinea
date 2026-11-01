// ProviderChain：按设置顺序降级（T-003）。核心逻辑与具体适配器解耦，用桩测试。
import { logger } from '../shared/logger';
import type {
  Language,
  ProviderConfig,
  ProviderError,
  ProviderType,
  Segment,
  TranslatedSegment,
  TranslationProvider,
} from '../shared/types';
import { isAllFailed } from '../shared/types';

export interface ChainResult {
  items: TranslatedSegment[];
  /** 全部 provider 失败时的首个错误（供 tipbar 归类） */
  error?: ProviderError;
}

export class ProviderChain {
  private instances: readonly TranslationProvider[] = [];

  constructor(
    private readonly configs: () => ProviderConfig[],
    private readonly create: (cfg: ProviderConfig) => TranslationProvider,
  ) {}

  async detectLanguage(text: string): Promise<Language> {
    for (const p of this.list()) {
      try {
        return await p.detectLanguage(text);
      } catch {
        // continue 下一家
      }
    }
    return 'auto';
  }

  async translateBatch(
    segments: Segment[],
    source: Language | 'auto',
    target: Language,
  ): Promise<ChainResult> {
    const providers = this.list();
    if (providers.length === 0) {
      return {
        items: segments.map((s) => ({
          id: s.id,
          text: '',
          error: { code: 'E_PROVIDER_DOWN' as const, detail: 'no enabled provider' },
        })),
        error: { code: 'E_PROVIDER_DOWN', detail: 'no enabled provider' },
      };
    }
    let last: TranslatedSegment[] = [];
    for (const p of providers) {
      const items = await p.translateBatch(segments, source, target);
      if (!isAllFailed(items)) return { items };
      last = items;
      logger.warn(`provider ${p.name} 整批失败，降级下一个`);
    }
    return { items: last, error: last[0]?.error };
  }

  abort(): void {
    for (const p of this.list()) p.abort();
  }

  private list(): readonly TranslationProvider[] {
    this.instances = this.configs()
      .filter((c) => c.enabled)
      .map((c) => this.create(c));
    return this.instances;
  }
}

// 展示 ProviderType 的全量使用，防止遗漏分支（将来加 provider 会在 lint 处提醒）
export const ALL_PROVIDER_TYPES: readonly ProviderKey[] = [
  'openai-compatible',
  'google-free',
  'microsoft-free',
] as const;
type ProviderKey = Extract<ProviderType, string>;
