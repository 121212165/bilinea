// 设置页（options）：原生 TS DOM 编辑器，所有读写经 SW 消息（SET/GET_SETTINGS）。
// 编辑器行为：本地直接改 settings 对象 → 点保存一次性提交。

import { callRpc } from '../../shared/messaging';
import {
  clampUiField,
  defaultUiStyle,
  UI_STYLE_LIMITS,
  type UiStyleField,
} from '../../shared/ui-style';
import type {
  ExtensionSettings,
  ProviderType,
  StyleMode,
  Theme,
} from '../../shared/types';

const LANG_RE = /^[a-zA-Z]{2,3}(-[A-Za-z0-9]+)*$/;

let settings: ExtensionSettings = {
  providers: [],
  targetLang: 'zh-CN',
  autoTranslateSites: [],
  styleMode: 'bilingual',
  theme: 'auto',
  hoverEnabled: true,
  selectionEnabled: true,
  pdfEntryEnabled: true,
  ...defaultUiStyle(), // SW 未响应时的本地兜底（T-024 五旋钮默认值）
};

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function mk<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string | boolean | number>> = {},
  children: Array<Node | string> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'checked' || k === 'hidden') {
      (node as unknown as Record<string, boolean>)[k] = Boolean(v);
      continue;
    }
    if (k === 'value') {
      (node as HTMLInputElement).value = String(v);
      continue;
    }
    node.setAttribute(k, String(v));
  }
  for (const c of children) node.append(c);
  return node;
}

function textInput(cls: string, placeholder: string, value: string, onInput: (v: string) => void): HTMLInputElement {
  const input = mk('input', { class: cls, placeholder, value });
  input.addEventListener('change', () => onInput(input.value.trim()));
  return input;
}

function fmt(t: ProviderType): string {
  return t === 'openai-compatible' ? 'OpenAI 兼容' : t === 'google-free' ? 'Google 免费机翻' : '微软免费机翻';
}

function renderProviders(): void {
  const list = el<HTMLDivElement>('provider-list');
  list.innerHTML = '';
  settings.providers.forEach((provider, idx) => {
    const row = mk('div', { class: 'provider-row', 'data-idx': idx, 'data-test': 'provider-row' });

    const title = mk('div', { class: 'head' }, []);
    title.append(
      mk('span', { class: 'title' }, [fmt(provider.type)]),
      mk('span', {}, [' 启用']),
    );
    const enabled = mk('input', { type: 'checkbox', class: 'p-enabled' });
    enabled.checked = provider.enabled;
    enabled.addEventListener('change', () => {
      provider.enabled = enabled.checked;
    });
    title.append(enabled);

    row.append(title);

    if (provider.type === 'openai-compatible') {
      const baseUrl = textInput('p-baseurl', 'BaseURL，如 https://api.deepseek.com/v1', provider.baseUrl ?? '', (v) => {
        provider.baseUrl = v;
      });
      const apiKey = textInput('p-key', 'API Key（仅存本机）', provider.apiKey ?? '', (v) => {
        provider.apiKey = v;
      });
      apiKey.type = 'password';
      const model = textInput('p-model', '模型名，如 deepseek-chat / qwen-flash', provider.model ?? '', (v) => {
        provider.model = v;
      });
      row.append(
        mk('label', { class: 'field' }, ['BaseURL', baseUrl]),
        mk('label', { class: 'field' }, ['API Key', apiKey]),
        mk('label', { class: 'field' }, ['模型', model]),
      );
    } else {
      row.append(
        mk(
          'div',
          { class: 'hint' },
          ['公共免费端点无需配置（非官方接口，可能失效；翻译会自动降级兜底）'],
        ),
      );
    }

    row.append(
      mk('div', { class: 'row-actions' }, [
        mk('button', { class: 'mini', 'data-act': 'up', 'data-idx': idx, 'data-test': 'move-up' }, ['上移']),
        mk('button', { class: 'mini', 'data-act': 'del', 'data-idx': idx, 'data-test': 'remove-provider' }, ['删除']),
      ]),
    );
    list.append(row);
  });
}

function renderGeneral(): void {
  el<HTMLInputElement>('targetLang').value = settings.targetLang;
  el<HTMLTextAreaElement>('sites').value = settings.autoTranslateSites.join('\n');
  el<HTMLSelectElement>('styleMode').value = settings.styleMode;
  el<HTMLSelectElement>('theme').value = settings.theme;
  el<HTMLInputElement>('hoverEnabled').checked = settings.hoverEnabled;
  el<HTMLInputElement>('selectionEnabled').checked = settings.selectionEnabled;
  el<HTMLInputElement>('pdfEntryEnabled').checked = settings.pdfEntryEnabled !== false;
  renderUiTweaks();
}

// ---------- 界面微调（T-024 / M3-1）：五旋钮渲染与收集，安全收口在存储层 clamp ----------

const UI_FIELDS: Array<[UiStyleField, string]> = [
  ['subtitleFontSize', 'subtitleFontSize'],
  ['subtitleBottom', 'subtitleBottom'],
  ['bubbleFontSize', 'bubbleFontSize'],
  ['hoverFontSize', 'hoverFontSize'],
  ['floatOffset', 'floatOffset'],
];

function renderUiTweaks(): void {
  for (const [field, id] of UI_FIELDS) {
    const input = el<HTMLInputElement>(id);
    input.value = String(settings[field] ?? UI_STYLE_LIMITS[field].default);
  }
}

function collectUiTweaks(): Partial<ExtensionSettings> {
  const patch: Partial<ExtensionSettings> = {};
  for (const [field, id] of UI_FIELDS) {
    const raw = el<HTMLInputElement>(id).value.trim();
    // 留空 = 保持当前值（旧数据缺字段时留给存储层回填默认）
    if (raw !== '') patch[field] = clampUiField(field, Number(raw));
  }
  return patch;
}

function collectGeneral(): Partial<ExtensionSettings> {
  return {
    targetLang: el<HTMLInputElement>('targetLang').value.trim(),
    autoTranslateSites: el<HTMLTextAreaElement>('sites')
      .value.split(/[\r\n]+/)
      .map((t) => t.trim())
      .filter(Boolean),
    styleMode: el<HTMLSelectElement>('styleMode').value as StyleMode,
    theme: el<HTMLSelectElement>('theme').value as Theme,
    hoverEnabled: el<HTMLInputElement>('hoverEnabled').checked,
    selectionEnabled: el<HTMLInputElement>('selectionEnabled').checked,
    pdfEntryEnabled: el<HTMLInputElement>('pdfEntryEnabled').checked,
    ...collectUiTweaks(),
  };
}

function flash(msg: string): void {
  el<HTMLSpanElement>('msg').textContent = msg;
  window.setTimeout(() => {
    el<HTMLSpanElement>('msg').textContent = '';
  }, 2600);
}

async function save(): Promise<void> {
  const general = collectGeneral();
  if (!LANG_RE.test(general.targetLang ?? '')) {
    flash('❌ 目标语言无效，请用形如 zh-CN 的 BCP-47 代码');
    return;
  }
  try {
    await callRpc({ type: 'SET_SETTINGS', patch: { ...general, providers: settings.providers } });
    flash('✅ 已保存');
  } catch {
    flash('❌ 保存失败：service worker 未响应（请重开设置页）');
  }
}

function moveUp(idx: number): void {
  if (idx <= 0) return;
  const arr = settings.providers;
  const a = arr[idx];
  const b = arr[idx - 1];
  if (a && b) {
    arr[idx] = b;
    arr[idx - 1] = a;
    renderProviders();
  }
}

function removeAt(idx: number): void {
  settings.providers.splice(idx, 1);
  renderProviders();
}

document.addEventListener('DOMContentLoaded', async () => {
  // 初始读取（SW 未响应→沿用本地默认并提示）
  try {
    const res = await callRpc({ type: 'GET_SETTINGS' });
    if (res.type === 'SETTINGS') settings = res.settings;
  } catch {
    // 保持默认
  }
  renderProviders();
  renderGeneral();

  el('add-openai').addEventListener('click', () => {
    settings.providers.push({ type: 'openai-compatible', enabled: true });
    renderProviders();
  });
  el('add-google').addEventListener('click', () => {
    settings.providers.push({ type: 'google-free', enabled: true });
    renderProviders();
  });
  el('add-ms').addEventListener('click', () => {
    settings.providers.push({ type: 'microsoft-free', enabled: true });
    renderProviders();
  });

  // 列表内委托处理 上移 / 删除
  el<HTMLDivElement>('provider-list').addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const act = t.dataset.act;
    if (!act) return;
    const idx = Number(t.dataset.idx);
    if (act === 'up') moveUp(idx);
    if (act === 'del') removeAt(idx);
  });

  el('save').addEventListener('click', () => void save());
});
