// 设置存储：chrome.storage.local 单键读写 + 白名单校验。
// 读写都过 sanitize，保证任何来源（手动改 storage / 旧版本）都收口为合法结构。

import type {
  ExtensionSettings,
  ProviderConfig,
  ProviderType,
  StyleMode,
  Theme,
} from '../shared/types';
import { clampUiField, defaultUiStyle } from '../shared/ui-style';

export const SETTINGS_KEY = 'itr_settings';

export interface StorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export function defaultSettings(): ExtensionSettings {
  return {
    providers: [
      { type: 'openai-compatible', enabled: true },
      { type: 'google-free', enabled: true },
    ],
    targetLang: 'zh-CN',
    autoTranslateSites: [],
    styleMode: 'bilingual',
    theme: 'auto',
    hoverEnabled: true,
    selectionEnabled: true,
    pdfEntryEnabled: true,
    ...defaultUiStyle(), // T-024 UI 可调五旋钮默认值
  };
}

const PROVIDER_TYPES: ProviderType[] = ['openai-compatible', 'google-free', 'microsoft-free'];
const STYLE_MODES: StyleMode[] = ['bilingual', 'translation-only'];
const THEMES: Theme[] = ['auto', 'light', 'dark'];
const LANG_RE = /^[a-zA-Z]{2,3}(-[A-Za-z0-9]+)*$/;

/** 任意脏数据 → 合法设置结构 */
export function sanitizeSettings(raw: unknown): ExtensionSettings {
  const d = defaultSettings();
  if (typeof raw !== 'object' || raw === null) return d;
  const r = raw as Record<string, unknown>;
  const providersIn = Array.isArray(r.providers) ? r.providers : [];
  const providers = providersIn
    .map((p): ProviderConfig | null => {
      if (typeof p !== 'object' || p === null) return null;
      const pc = p as Record<string, unknown>;
      const type = pc.type;
      if (typeof type !== 'string' || !(PROVIDER_TYPES as string[]).includes(type)) return null;
      const s: ProviderConfig = {
        type: type as ProviderType,
        enabled: pc.enabled === true,
      };
      for (const k of ['baseUrl', 'apiKey', 'model', 'promptTemplate'] as const) {
        const v = pc[k];
        if (typeof v === 'string' && v.trim()) s[k] = v.trim();
      }
      return s;
    })
    .filter((p): p is ProviderConfig => p !== null);
  const targetLang = typeof r.targetLang === 'string' && LANG_RE.test(r.targetLang)
    ? r.targetLang
    : d.targetLang;
  const sitesIn = Array.isArray(r.autoTranslateSites) ? r.autoTranslateSites : [];
  return {
    providers,
    targetLang,
    autoTranslateSites: sitesIn.filter((s): s is string => typeof s === 'string' && s.length > 0),
    styleMode: (STYLE_MODES as string[]).includes(r.styleMode as string)
      ? (r.styleMode as StyleMode)
      : d.styleMode,
    theme: (THEMES as string[]).includes(r.theme as string) ? (r.theme as Theme) : d.theme,
    hoverEnabled: r.hoverEnabled !== false,
    selectionEnabled: r.selectionEnabled !== false,
    pdfEntryEnabled: r.pdfEntryEnabled !== false,
    // T-024 UI 可调：数字字段一律白名单 + clamp 收口（越界/非法回落默认）
    subtitleFontSize: clampUiField('subtitleFontSize', r.subtitleFontSize),
    subtitleBottom: clampUiField('subtitleBottom', r.subtitleBottom),
    bubbleFontSize: clampUiField('bubbleFontSize', r.bubbleFontSize),
    hoverFontSize: clampUiField('hoverFontSize', r.hoverFontSize),
    floatOffset: clampUiField('floatOffset', r.floatOffset),
  };
}

export function makeChromeLocalStorage(): StorageLike {
  return {
    async get(key) {
      return (await chrome.storage.local.get(key)) as Record<string, unknown>;
    },
    async set(items) {
      await chrome.storage.local.set(items);
    },
    async remove(keys) {
      await chrome.storage.local.remove(keys);
    },
  };
}

export async function loadSettings(store = makeChromeLocalStorage()): Promise<ExtensionSettings> {
  const obj = await store.get(SETTINGS_KEY);
  return sanitizeSettings(obj[SETTINGS_KEY]);
}

export async function saveSettings(
  patch: Partial<ExtensionSettings>,
  store = makeChromeLocalStorage(),
): Promise<ExtensionSettings> {
  const current = await loadSettings(store);
  const next = sanitizeSettings({ ...current, ...patch });
  await store.set({ [SETTINGS_KEY]: next });
  return next;
}
