// Provider 工厂：按配置实例化适配器（service 层唯一入口）
import type { ProviderConfig, TranslationProvider } from '../../shared/types';
import { GoogleFreeProvider } from './google-free';
import { MicrosoftFreeProvider } from './microsoft-free';
import { OpenAICompatibleProvider } from './openai-compatible';

export function createProvider(cfg: ProviderConfig): TranslationProvider {
  switch (cfg.type) {
    case 'openai-compatible':
      return new OpenAICompatibleProvider(cfg);
    case 'google-free':
      return new GoogleFreeProvider();
    case 'microsoft-free':
      return new MicrosoftFreeProvider();
  }
}
