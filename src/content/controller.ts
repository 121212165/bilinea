// content 编排层（T-008）：抽取 → 长文本子段 → TRANSLATE_BATCH → 增量渲染 → SPA 观察者
// 硬约束：不发翻译网络请求、不持 Key；一切经 chrome.runtime.sendMessage（此层注入 request）。
import { logger } from '../shared/logger';
import { LONG_TEXT_SPLIT_CHARS } from '../shared/constants';
import { isTargetLangText } from '../shared/lang';
import { callRpc, type RpcRequest, type RpcResponse, type SwEvent, type TabAction, type TranscriptPayload, type KeyframeContextPayload } from '../shared/messaging';
import { pickUiStyle } from '../shared/ui-style';
import type { ExtensionSettings, Segment, TranslatedSegment } from '../shared/types';
import { extractBlocks, splitLongText, type SegBlock } from './extractor';
import { PageRenderer } from './renderer';
import { findSiteOverride } from './site-rules';
import { HoverCard } from './hover';
import { SelectionBubble } from './selection';
import { SubtitleTranslator } from './subtitles';
import { errorTipText, removeTip, showTip } from './tipbar';

interface SubEntry {
  block: SegBlock;
  /** 长文本子段序号（普通段恒 0） */
  index: number;
}

interface PartState {
  successes: Map<number, string>;
  errors: Map<number, string>; // partIndex → 第一个错误码
}

export interface ControllerDeps {
  doc: Document;
  /** 网络出口注入（生产 = callRpc；测试用 fake） */
  request?: (msg: RpcRequest) => Promise<RpcResponse>;
  /** SPA 重抽防抖（测试注入小值） */
  spaDebounceMs?: number;
  /** 抽取 sessionId（测试固定以断言 id） */
  sessionId?: string;
}

export class PageController {
  private readonly doc: Document;
  private readonly request: (msg: RpcRequest) => Promise<RpcResponse>;
  private readonly spaDebounceMs: number;
  private readonly sessionId?: string;
  private readonly renderer: PageRenderer;
  /** M3：与整页翻译共用开关的字幕双语器（contracts/subtitles.md） */
  private readonly subtitle: SubtitleTranslator;
  /** M2：划词翻译气泡（contracts/selection.md），由 selectionEnabled 独立驱动 */
  private readonly selection: SelectionBubble;
  /** M2：悬停 Alt 单段翻译浮卡（contracts/hover.md），由 hoverEnabled 独立驱动 */
  private readonly hover: HoverCard;

  private settings: ExtensionSettings | null = null;
  private activeRequest: string | null = null;
  private sessionActive = false;

  /** subId（可能带 #k）→ 母 block + 子段序号 */
  private subIndex = new Map<string, SubEntry>();
  /** blockId → 期望子段数 */
  private expectedParts = new Map<string, number>();
  /** blockId → 已收子段聚合（finalize 后删除） */
  private pending = new Map<string, PartState>();
  /** 该 block 已渲染完毕（幂等 + 防进度事件/响应双渲染） */
  private finalized = new Set<string>();
  /** 已消费过的 segment id（响应与 PROGRESS 广播重叠时去重） */
  private renderedIds = new Set<string>();

  private observer: MutationObserver | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private seq = 0;

  constructor(deps: ControllerDeps) {
    this.doc = deps.doc;
    this.request = deps.request ?? callRpc;
    this.spaDebounceMs = deps.spaDebounceMs ?? 1200;
    this.sessionId = deps.sessionId;
    this.renderer = new PageRenderer(this.doc);
    this.subtitle = new SubtitleTranslator({
      doc: this.doc,
      request: this.request,
      getTargetLang: () => this.settings?.targetLang ?? 'zh-CN',
    });
    this.selection = new SelectionBubble({
      doc: this.doc,
      request: this.request,
      getTargetLang: () => this.settings?.targetLang ?? 'zh-CN',
    });
    this.hover = new HoverCard({
      doc: this.doc,
      request: this.request,
      getTargetLang: () => this.settings?.targetLang ?? 'zh-CN',
    });
  }

  private get host(): string {
    return this.doc.location.hostname;
  }

  private get whitelist(): readonly string[] {
    return this.settings?.autoTranslateSites ?? [];
  }

  /** 载入设置 + 命中白名单自动翻译（契约 segmentation.md「设置变更」） */
  async init(): Promise<void> {
    const res = await this.request({ type: 'GET_SETTINGS' }).catch((e: unknown) => {
      logger.warn('GET_SETTINGS failed', e);
      return null;
    });
    if (res?.type === 'SETTINGS') {
      this.applySettings(res.settings);
    }
    if (this.settings && this.host && this.whitelist.includes(this.host)) {
      void this.handleAction({ type: 'TRANSLATE_PAGE' });
    }
  }

  /** popup / commands 指令入口 */
  async handleAction(action: TabAction): Promise<void> {
    switch (action.type) {
      case 'TRANSLATE_PAGE':
        if (this.sessionActive) {
          this.stop();
        } else {
          void this.translateNewContent();
        }
        break;
      case 'STOP_TRANSLATE':
        this.stop();
        break;
      case 'AUTO_ON':
        await this.setAuto(true);
        break;
      case 'AUTO_OFF':
        await this.setAuto(false);
        break;
    }
  }

  /** T-026 字幕导出：GET_TRANSCRIPT 异步回包载体（title = 标签页标题作文件名原料） */
  transcriptPayload(): TranscriptPayload {
    return { type: 'TRANSCRIPT', title: this.doc.title ?? '', pairs: this.subtitle.transcriptSnapshot() };
  }

  /** T-027 关键帧：TabAction CAPTURE_KEYFRAME 同步回包（capture 由 SW 统一执行，契约 messaging.md「关键帧通道」） */
  keyframeContextPayload(): KeyframeContextPayload {
    return { type: 'KEYFRAME_CONTEXT', ...this.subtitle.keyframeContext() };
  }

  /** SW 广播事件入口（PROGRESS 增量渲染 / DONE 收尾 / SETTINGS 同步） */
  handleEvent(ev: SwEvent): void {
    if (ev.type === 'SETTINGS_CHANGED') {
      this.applySettings(ev.settings);
      return;
    }
    if (ev.type === 'KEYFRAME_SAVED') return; // T-027：popup 计数面消费，content 不响应
    if (ev.requestId !== this.activeRequest) return; // 其他 tab 的请求，忽略
    if (ev.type === 'TRANSLATION_DONE') {
      if (ev.error) showTip(this.doc, errorTipText(ev.error.code), { theme: this.settings?.theme });
      return;
    }
    for (const item of ev.items) this.consumeItem(item);
  }

  // ---------- 翻译会话 ----------

  private stop(): void {
    const requestId = this.activeRequest;
    if (requestId) {
      this.activeRequest = null;
      void this.request({ type: 'CANCEL', requestId }).catch(() => undefined);
    }
    this.resetBodyState();
    this.sessionActive = false;
    this.disconnectObserver();
    this.subtitle.stop();
    this.selection.hideAll();
    this.hover.hideAll();
    removeTip(this.doc);
    logger.info('translation stopped');
  }

  /** 抽取 → 注册 → 请求 → 收尾（首次整页与 SPA 增量共用） */
  private async translateNewContent(): Promise<void> {
    this.sessionActive = true;
    this.subtitle.start(); // toggle/自动翻译开启即监听字幕（契约 subtitles.md 生命周期共用）
    const target = this.settings?.targetLang ?? 'zh-CN';
    const override = findSiteOverride(this.host);
    const blocks = extractBlocks(this.doc.body, {
      sessionId: this.sessionId,
      overrideSelector: override?.selector,
      skipSelector: override?.skipSelector, // T-020 站点级抽取黑名单
      // T-016/T-018：已渲染或已是目标语言的块不入批（Skip #3 + Skip #6）
    }).filter(
      (b) =>
        !this.renderer.isTranslated(b.el) &&
        !isTargetLangText(b.text, target),
    );
    if (blocks.length === 0) {
      logger.info('no translatable blocks, waiting for SPA changes');
      this.connectObserver(); // 虚拟列表/懒加载：新内容出现后补扫（契约 T-013）
      return;
    }
    const requestId = `req-${Date.now().toString(36)}-${this.seq.toString(36)}`;
    this.seq += 1;
    this.activeRequest = requestId;

    this.renderedIds.clear();
    this.finalized.clear();
    this.pending.clear();
    this.subIndex.clear();
    this.expectedParts.clear();

    const segments: Segment[] = [];
    for (const block of blocks) {
      if (block.text.length > LONG_TEXT_SPLIT_CHARS) {
        const parts = splitLongText(block.text, LONG_TEXT_SPLIT_CHARS);
        this.expectedParts.set(block.id, parts.length);
        parts.forEach((text, k) => {
          const subId = `${block.id}#${k}`;
          this.subIndex.set(subId, { block, index: k });
          segments.push({ id: subId, text });
        });
      } else {
        this.expectedParts.set(block.id, 1);
        this.subIndex.set(block.id, { block, index: 0 });
        segments.push({ id: block.id, text: block.text });
      }
    }
    this.renderer.begin(blocks);

    try {
      const res = await this.request({
        type: 'TRANSLATE_BATCH',
        segments,
        source: 'auto',
        target,
        requestId,
      });
      if (this.activeRequest !== requestId) return; // 会话已被 stop
      if (res.type === 'TRANSLATION') {
        for (const item of res.items) this.consumeItem(item); // idempotent
        if (res.error) {
          showTip(this.doc, errorTipText(res.error.code), { theme: this.settings?.theme });
        }
      }
    } catch (e) {
      logger.error('TRANSLATE_BATCH failed', e);
      showTip(this.doc, errorTipText('E_PROVIDER_DOWN'), { theme: this.settings?.theme });
    }
    // 会话收尾：释放请求位（SPA 增译依赖 activeRequest === null）
    if (this.activeRequest === requestId) this.activeRequest = null;
    this.connectObserver();
  }

  // ---------- 增量消费 ----------

  /** 进度事件 / 最终响应共用：子段聚合，齐 → 依序拼渲染 */
  private consumeItem(item: TranslatedSegment): void {
    if (this.renderedIds.has(item.id)) return;
    this.renderedIds.add(item.id);
    const entry = this.subIndex.get(item.id);
    if (!entry) {
      logger.warn(`unknown segment id: ${item.id}`);
      return;
    }
    const blockId = entry.block.id;
    let state = this.pending.get(blockId);
    if (!state) {
      state = { successes: new Map(), errors: new Map() };
      this.pending.set(blockId, state);
    }
    if (item.error) {
      state.successes.delete(entry.index);
      if (!state.errors.has(entry.index)) state.errors.set(entry.index, item.error.code);
    } else {
      state.errors.delete(entry.index);
      state.successes.set(entry.index, item.text);
    }
    const expected = this.expectedParts.get(blockId) ?? 1;
    if (state.successes.size + state.errors.size < expected) return; // 子段未齐

    this.pending.delete(blockId);
    this.finalized.add(blockId);
    const joined = [...state.successes.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, t]) => t)
      .join('');
    if (joined) this.renderer.appendTranslation(entry.block, joined);
    const firstError = state.errors.entries().next();
    if (!firstError.done) this.renderer.appendError(entry.block, firstError.value[1]);
  }

  // ---------- 设置 ----------

  private applySettings(settings: ExtensionSettings): void {
    this.settings = settings;
    this.renderer.setTheme(settings.theme);
    this.renderer.setStyleMode(settings.styleMode);
    // M3-1 UI 可调（T-024）：五旋钮 → 三组件同源生效（init 与 SETTINGS_CHANGED 共走此路径）
    const ui = pickUiStyle(settings);
    this.subtitle.applyUiStyle(ui);
    this.selection.applyUiStyle(ui);
    this.hover.applyUiStyle(ui);
    // M2 划词气泡：独立开关、实时生效（contracts/selection.md §1 电源）
    if (settings.selectionEnabled) this.selection.enable();
    else this.selection.disable();
    // M2 悬停单段翻译：同上（contracts/hover.md §1）
    if (settings.hoverEnabled) this.hover.enable();
    else this.hover.disable();
  }

  private async setAuto(on: boolean): Promise<void> {
    const host = this.host;
    if (!host) return;
    const set = new Set(this.whitelist);
    if (on) set.add(host);
    else set.delete(host);
    const res = await this.request({
      type: 'SET_SETTINGS',
      patch: { autoTranslateSites: [...set].sort() },
    }).catch(() => null);
    if (res?.type === 'SETTINGS') this.settings = res.settings;
  }

  // ---------- SPA 观察 ----------

  private connectObserver(): void {
    if (this.observer) return;
    const ObserverCtor = this.doc.defaultView?.MutationObserver;
    if (!ObserverCtor) {
      logger.warn('MutationObserver unavailable, SPA incremental translation disabled');
      return;
    }
    this.observer = new ObserverCtor((mutations) => {
      let relevant = false;
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const el = node as Element;
          // 本项目容器自带 itr- 前缀（closest 命中自身），绝不把自己触发的变更当新内容
          if (!el.closest('[class*="itr-"]')) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
      }
      if (!relevant) return;
      this.scheduleRetranslate();
    });
    this.observer.observe(this.doc.body, { childList: true, subtree: true });
  }

  private scheduleRetranslate(): void {
    if (this.debounceTimer || !this.sessionActive) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.activeRequest) return; // 源会话未结束，等下一轮
      void this.translateNewContent();
    }, this.spaDebounceMs);
  }

  private disconnectObserver(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private resetBodyState(): void {
    this.renderedIds.clear();
    this.finalized.clear();
    this.pending.clear();
    this.subIndex.clear();
    this.expectedParts.clear();
    this.renderer.clearAll();
  }
}
