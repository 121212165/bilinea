// popup：对活动 tab 发送 TabAction；划词/悬停总开关走 rpc SET_SETTINGS（patch + 全局广播）。
// T-026 字幕导出：GET_TRANSCRIPT 拉记录 + 三产物下载（anchor+blob，契约 messaging.md 下载通道）。
import {
  callRpc,
  isKeyframeContextPayload,
  isPdfInfoPayload,
  type RpcResponse,
  type TranscriptPayload,
} from '../../shared/messaging';
import { buildPdfReaderUrl } from '../../shared/pdf-entry';
import {
  buildFilename,
  buildHtml,
  buildMarkdown,
  downloadText,
  flattenTranscript,
} from '../../shared/export';
import {
  buildKeyframesMarkdown,
  buildTimestampList,
  keyframesFilename,
  KEYFRAME_STORE_KEY,
  type KeyframeContext,
  type KeyframeRecord,
  type KeyframeStoreValue,
} from '../../shared/keyframes';
import { SUMMARY_MAX_CHARS } from '../../shared/constants';
import { logger } from '../../shared/logger';
import type { ExtensionSettings } from '../../shared/types';

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function setState(msg = ''): void {
  el<HTMLSpanElement>('state').textContent = msg;
}

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/** 「接收端不存在」= tab 内没有活的 content script（扩展刚重载/页面未刷新的陈旧 tab） */
function isMissingReceiver(e: unknown): boolean {
  const text = e instanceof Error ? e.message : String(e);
  return text.includes('Receiving end') || text.includes('receiver') || text.includes('接收端');
}

/** 注入单飞（契约 messaging.md「指令投递可靠性」T-016）：
 * 同 tab 注入进行中时并发点击合并为一次 executeScript，杜绝双注入 → 双监听 → 重复译文块 */
const healInFlight = new Map<number, Promise<void>>();

function healOnce(tabId: number): Promise<void> {
  const existing = healInFlight.get(tabId);
  if (existing) return existing;
  const p = chrome.scripting
    .executeScript({ target: { tabId }, files: ['content/index.js'] })
    .then(() => {
      healInFlight.delete(tabId);
    });
  healInFlight.set(tabId, p);
  return p;
}

// ===== T-026 字幕导出（M3-3，契约 subtitles.md「导出」节） =====

let transcript: TranscriptPayload | null = null;

/** SUMMARY 错误码 → popup 文案（本地映射；E_NO_KEY 之外多为引擎侧暂态） */
const SUMMARY_ERR_TEXT: Record<string, string> = {
  E_NO_KEY: '简述需先在设置配置 OpenAI 兼容引擎',
  E_RATE_LIMITED: '引擎限流，稍后再试',
  E_TIMEOUT: '引擎响应超时',
  E_PROVIDER_DOWN: '引擎暂不可用',
};

function exportSection(): HTMLElement | null {
  return document.getElementById('export');
}

/** boot / 活动页变化时拉取字幕导出记录：无记录 / 接收端不存在 → 隐藏 section（不补注入） */
async function refreshExport(): Promise<void> {
  const section = exportSection();
  if (!section) return;
  try {
    const tab = await activeTab();
    if (!tab?.id) {
      section.hidden = true;
      return;
    }
    const res = (await chrome.tabs.sendMessage(tab.id, { type: 'GET_TRANSCRIPT' })) as
      | TranscriptPayload
      | undefined;
    if (!res || res.type !== 'TRANSCRIPT' || res.pairs.length === 0) {
      transcript = null;
      section.hidden = true;
      return;
    }
    transcript = res;
    const count = document.getElementById('export-count');
    if (count) count.textContent = `· ${res.pairs.length} 条`;
    section.hidden = false;
  } catch (e) {
    logger.warn('GET_TRANSCRIPT failed', e);
    transcript = null;
    section.hidden = true;
  }
}

async function requestSummary(): Promise<string | undefined> {
  if (!transcript) return undefined;
  setState('AI 简述生成中…');
  let res: RpcResponse;
  try {
    res = await callRpc({
      type: 'SUMMARIZE_TEXT',
      requestId: `sum-${Date.now()}`,
      text: flattenTranscript(transcript.pairs, SUMMARY_MAX_CHARS),
    });
  } catch {
    setState('后台未就绪，请重试');
    return undefined;
  }
  if (res.type === 'SUMMARY' && res.text) return res.text;
  const code = res.type === 'SUMMARY' && res.error ? res.error.code : 'E_PROVIDER_DOWN';
  setState(SUMMARY_ERR_TEXT[code] ?? '简述生成失败');
  return undefined;
}

function downloadAs(ext: 'md' | 'html', mime: string, content: string, label: string): void {
  if (!transcript) return;
  const ok = downloadText(document, `${buildFilename(transcript.title)}.${ext}`, content, mime);
  setState(ok ? label : '浏览器不支持下载');
}

/** 导出 MD（AI 简述可选）：简述失败即中止，不产出无简述半成品 */
async function exportMd(withSummary: boolean): Promise<void> {
  if (!transcript) return;
  const summary = withSummary ? await requestSummary() : undefined;
  if (withSummary && !summary) return;
  downloadAs(
    'md',
    'text/markdown',
    buildMarkdown({ title: transcript.title }, transcript.pairs, summary),
    withSummary ? '已导出 MD+AI 简述' : '已导出 MD',
  );
}

function exportHtmlFile(): void {
  if (!transcript) return;
  downloadAs('html', 'text/html', buildHtml({ title: transcript.title }, transcript.pairs), '已导出 HTML');
}

async function sendToTab(action: { type: string }): Promise<boolean> {
  const tab = await activeTab();
  if (!tab?.id) {
    setState('无活动标签页');
    return false;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, action);
    return true;
  } catch (e) {
    if (!isMissingReceiver(e)) {
      setState('无法连接页面，请刷新重试');
      return false;
    }
    // 补注入（单飞）+ 重发一次（契约 messaging.md「指令投递可靠性」T-015）
    try {
      await healOnce(tab.id);
      await chrome.tabs.sendMessage(tab.id, action);
      return true;
    } catch (e2) {
      logger.warn('healing injection failed', e2);
      setState('页面不支持注入，请刷新后重试');
      return false;
    }
  }
}

// ===== T-027 关键帧（M3-4，契约 subtitles.md「关键帧绑定」） =====

let keyframes: KeyframeRecord[] = [];

/** 读单键 store（content 层永不读写；popup 是指定消费面） */
async function storageKeyframes(): Promise<KeyframeRecord[]> {
  try {
    const obj = await chrome.storage.local.get(KEYFRAME_STORE_KEY);
    const raw = obj[KEYFRAME_STORE_KEY] as KeyframeStoreValue | undefined;
    const frames = raw && typeof raw === 'object' ? raw.frames : undefined;
    return Array.isArray(frames) ? frames : [];
  } catch {
    return [];
  }
}

/** boot / KEYFRAME_SAVED 广播（storage.onChanged）/ 清除后回显 */
async function refreshKeyframes(): Promise<void> {
  keyframes = await storageKeyframes();
  const count = document.getElementById('kframe-count');
  if (count) count.textContent = keyframes.length > 0 ? `· ${keyframes.length} 帧` : '';
  const actions = document.getElementById('kframe-actions');
  if (actions) actions.hidden = keyframes.length === 0;
}

/**
 * popup「截帧」入口（手势 = popup 打开即授予）：两跳落库（契约 messaging.md「关键帧通道」）——
 * ① TabAction 让 content 同步回 KEYFRAME_CONTEXT（视频上下文只在 content 手里）；
 * ② 上下文经 Rpc 交付 SW capture（popup 页无 sender.tab → resolveWindowId 兜底活动 tab）。
 * 接收端缺失（陈旧 tab）→ 空上下文直投 Rpc（随手截帧任何页面可用）。
 */
async function captureFromPopup(): Promise<void> {
  const tab = await activeTab();
  if (!tab?.id) {
    setState('无活动标签页');
    return;
  }
  let ctx: KeyframeContext = { videoId: '', videoTime: null, src: '', dst: '' };
  try {
    const res: unknown = await chrome.tabs.sendMessage(tab.id, { type: 'CAPTURE_KEYFRAME' });
    if (isKeyframeContextPayload(res)) {
      // 只取字段不透传回包 type（type 若随展开流入 Rpc 体会覆盖 CAPTURE_KEYFRAME，SW 将拒收）
      ctx = { videoId: res.videoId, videoTime: res.videoTime, src: res.src, dst: res.dst };
    }
  } catch (e) {
    if (!isMissingReceiver(e)) {
      setState('无法连接页面，请刷新重试');
      return;
    }
    // 接收端缺失 → 空上下文随手帧（popup 打开本身已授予 activeTab）
  }
  try {
    const res = await callRpc({ type: 'CAPTURE_KEYFRAME', ...ctx });
    if (res.type === 'KEYFRAME_SAVED' && res.error) {
      setState(res.error.code === 'E_NO_GESTURE' ? '截帧被拒（需扩展手势）' : '截帧失败');
      return;
    }
    if (res.type !== 'KEYFRAME_SAVED' || !res.id) {
      // SW 无应答时 callRpc 归一 NOT_SUPPORTED（端口即闭）——不得虚报「已截帧」
      setState('后台未就绪，请重试');
      return;
    }
    void refreshKeyframes(); // 立即回显（storage.onChanged 为兜底通道）
    setState('已截帧');
  } catch {
    setState('后台未就绪，请重试');
  }
}

function downloadKeyframes(content: string, label: string): void {
  if (keyframes.length === 0) return;
  const ok = downloadText(document, keyframesFilename(keyframes), content, 'text/markdown');
  if (ok) setState(label);
  else setState('浏览器不支持下载');
}

function exportKeyframesMd(): void {
  downloadKeyframes(buildKeyframesMarkdown(keyframes), '已导出关键帧 MD');
}

function exportKeyframesList(): void {
  downloadKeyframes(buildTimestampList(keyframes), '已导出时间戳清单');
}

async function clearKeyframes(): Promise<void> {
  try {
    await chrome.storage.local.set({ [KEYFRAME_STORE_KEY]: { frames: [] } as KeyframeStoreValue });
    setState('已清空关键帧');
  } catch {
    setState('清除失败，请重试');
  }
  void refreshKeyframes();
}

// ===== T-028f 原生 PDF 入口（契约 messaging.md GET_PDF_INFO） =====

let pdfReaderUrl = '';

async function pdfEntryEnabled(): Promise<boolean> {
  try {
    const raw = (await chrome.storage.local.get('itr_settings')).itr_settings as
      | { pdfEntryEnabled?: boolean }
      | undefined;
    return raw?.pdfEntryEnabled !== false;
  } catch {
    return true;
  }
}

/** 活动 tab 是否原生 PDF：向 content 取 document.contentType 判定；非 PDF/无接收端 → 隐藏且不补注入 */
async function refreshPdfEntry(): Promise<void> {
  const section = document.getElementById('pdf-entry');
  if (!section) return;
  const controls = document.getElementById('page-controls');
  const tab = await activeTab();
  let info: unknown;
  if (tab?.id) {
    try {
      info = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PDF_INFO' });
    } catch {
      info = undefined;
    }
  }
  let url = '';
  if (isPdfInfoPayload(info) && info.isPdf && (await pdfEntryEnabled())) {
    url = buildPdfReaderUrl(chrome.runtime.getURL('pdf/index.html'), info.url || tab?.url || '');
  }
  pdfReaderUrl = url;
  section.hidden = url === '';
  if (controls) controls.hidden = url !== '';
}

async function openPdfReader(): Promise<void> {
  if (!pdfReaderUrl) return;
  try {
    await chrome.tabs.create({ url: pdfReaderUrl });
    setState('已打开 PDF 阅读器');
    try {
      window.close();
    } catch {
      // jsdom / 非 popup 上下文无 close，忽略
    }
  } catch {
    setState('打开失败，请重试');
  }
}

async function refreshAuto(): Promise<void> {
  try {
    const tab = await activeTab();
    const siteHost = tab?.url ? hostOf(tab.url) : null;
    const raw = (await chrome.storage.local.get('itr_settings')).itr_settings as
      | { autoTranslateSites?: string[] }
      | undefined;
    if (!siteHost) autoBox.checked = false;
    else autoBox.checked = raw?.autoTranslateSites?.includes(siteHost) ?? false;
  } catch {
    autoBox.checked = false;
  }
}

let autoBox: HTMLInputElement;
let selBox: HTMLInputElement;
let hoverBox: HTMLInputElement;

interface FeatureFlags {
  selectionEnabled?: boolean;
  hoverEnabled?: boolean;
}

/** 回显：直接读 storage（与 refreshAuto 同模式）；缺省按代码默认值 true。 */
async function refreshToggles(): Promise<void> {
  if (!selBox || !hoverBox) return;
  try {
    const raw = (await chrome.storage.local.get('itr_settings')).itr_settings as
      | FeatureFlags
      | undefined;
    selBox.checked = raw?.selectionEnabled ?? true;
    hoverBox.checked = raw?.hoverEnabled ?? true;
  } catch {
    selBox.checked = true;
    hoverBox.checked = true;
  }
}

/** 切换：callRpc SET_SETTINGS（SW 合并写回 + 广播 SETTINGS_CHANGED → 已开页面实时生效）。
 * 回应携带权威快照，以服务端值回写 UI（防竞态）；失败回读 storage 恢复显示。 */
async function onToggle(
  box: HTMLInputElement,
  key: 'selectionEnabled' | 'hoverEnabled',
  onMsg: string,
  offMsg: string,
): Promise<void> {
  const want = box.checked;
  const patch: Partial<ExtensionSettings> =
    key === 'selectionEnabled' ? { selectionEnabled: want } : { hoverEnabled: want };
  try {
    const res = await callRpc({ type: 'SET_SETTINGS', patch });
    if (res.type === 'SETTINGS') {
      box.checked = res.settings[key];
      setState(box.checked ? onMsg : offMsg);
    }
  } catch (e) {
    logger.warn('popup toggle failed', e);
    setState('切换失败，请重试');
    void refreshToggles();
  }
}

function start(): void {
  autoBox = el<HTMLInputElement>('auto');
  selBox = el<HTMLInputElement>('sel');
  hoverBox = el<HTMLInputElement>('hover');

  el('translate').addEventListener('click', async () => {
    const okDone = await sendToTab({ type: 'TRANSLATE_PAGE' });
    if (okDone) setState('已请求翻译');
  });
  el('stop').addEventListener('click', async () => {
    const okDone = await sendToTab({ type: 'STOP_TRANSLATE' });
    if (okDone) setState();
  });

  // T-026 字幕导出三按钮（section 接收端缺元素时全部 no-op，兼容存量测试 DOM）
  if (exportSection()) {
    el('export-md').addEventListener('click', () => void exportMd(false));
    el('export-html').addEventListener('click', () => exportHtmlFile());
    el('export-sum').addEventListener('click', () => void exportMd(true));
  }

  // T-028f PDF 入口（section 缺省隐藏；检测到原生 PDF 且开关开启才显示）
  if (document.getElementById('pdf-entry')) {
    el('pdf-open').addEventListener('click', () => void openPdfReader());
    void refreshPdfEntry();
  }

  // T-027 关键帧四按钮（#kframe 恒显；「截帧」任何页面可点，其余行有帧才现）
  if (document.getElementById('kframe')) {
    el('kframe-shot').addEventListener('click', () => void captureFromPopup());
    el('kframe-md').addEventListener('click', () => exportKeyframesMd());
    el('kframe-list').addEventListener('click', () => exportKeyframesList());
    el('kframe-clear').addEventListener('click', () => void clearKeyframes());
  }

  void refreshAuto();
  void refreshToggles();
  void refreshExport();
  void refreshKeyframes();

  autoBox.addEventListener('change', async () => {
    const okDone = await sendToTab({
      type: autoBox.checked ? 'AUTO_ON' : 'AUTO_OFF',
    } as { type: 'AUTO_ON' | 'AUTO_OFF' });
    if (okDone) setState(autoBox.checked ? '已加入本站白名单' : '已移出白名单');
    void refreshAuto();
  });

  if (selBox) {
    selBox.addEventListener(
      'change',
      () => void onToggle(selBox, 'selectionEnabled', '划词翻译已开启', '划词翻译已关闭'),
    );
  }
  if (hoverBox) {
    hoverBox.addEventListener(
      'change',
      () => void onToggle(hoverBox, 'hoverEnabled', '悬停翻译已开启', '悬停翻译已关闭'),
    );
  }
  chrome.storage.onChanged.addListener((_c, area) => {
    if (area === 'local') {
      void refreshAuto();
      void refreshToggles();
      void refreshKeyframes();
      void refreshPdfEntry();
    }
  });
}

// popup 的 script 标签位于 body 末尾：模块执行时 DOM 已就绪，无需等 DOMContentLoaded
// （也规避测试环境 jsdom 事件与模块注入的时序竞争）。
start();
