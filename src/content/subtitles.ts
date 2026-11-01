// M3 视频字幕双语（T-010 初建 / T-021a 数据流 v2）：严格对照 .agent/spec/contracts/subtitles.md
// 原字幕只读；译文自绘覆盖层；翻译请求复用 TRANSLATE_BATCH（SW 缓存/限流全复用）。
//
// v2 核心不变量：译文行永远与当前屏上原字幕配对，绝不显示陈旧台词（张冠李戴）。
// 代价由「即时并行 + 淘汰 + 会话缓存」承担，而非 v1 的单飞折叠跳过：
// - 即时并行：新采样文本即刻发单 Segment 请求，并发上限 4，超限淘汰最旧在途的跟踪标记
// - 源文本配对：响应回来仅当 lastVisibleText === 源文本 才上屏，否则丢弃
// - 滚动续显（T-021a 复测微调，替换初版「换行即隐」）：可见字幕已变 → 不立即隐藏，
//   上一行译文原地续显，由「配对换行 swap / TTL 超时隐藏 / 字幕消失·目标语言立即隐」收敛
// - 前缀抑制：新文本是某在途文本的前缀 → 不发（字幕滚动典型是增长文本，完整版价值更高）
// - 会话级结果缓存 doneTexts（LRU）：滚动回看/闪回秒上屏；SW 持久缓存兜底跨会话
import { logger } from '../shared/logger';
import { isTargetLangText } from '../shared/lang';
import { callRpc, type RpcRequest, type RpcResponse, type TranscriptPair } from '../shared/messaging';
import { parseVideoId, type KeyframeContext } from '../shared/keyframes';
import type { UiStyle } from '../shared/ui-style';
import { showTip } from './tipbar';

export interface SubtitleDeps {
  doc: Document;
  request?: (msg: RpcRequest) => Promise<RpcResponse>;
  /** 每次采样请求走这里拿目标语言 */
  getTargetLang?: () => string;
  /** 采样防抖（T-021a 收紧为 50ms；测试注入小值） */
  debounceMs?: number;
  /** doneTexts LRU 上限（默认 300；测试注入小值便于验证淘汰） */
  doneLimit?: number;
  /** 滚动续显超时收敛 TTL（默认 2000ms；测试注入小值便于验证收敛） */
  lingerMs?: number;
  /** T-027 成功反馈闪烁时长（默认 1200ms；测试注入小值） */
  flashMs?: number;
  // 以下选择器仅测试用注入用；生产即 YouTube 实际结构
  segmentSel?: string;
  rootSel?: string;
  /** T-025：原生字幕容器选择器（视觉退场施加对象；查询落空 → 不隐藏的安全退化） */
  nativeSel?: string;
}

const SEGMENT_SEL = '.ytp-caption-segment';
const PLAYER_ROOT_SEL = '#movie_player';
const LINE_CLASS = 'itr-caption-line';
/** T-025 仅双语：双语条双行 + 原生容器视觉退场（内容只读，仅 classList 增删） */
const SRC_CLASS = 'itr-caption-src';
const DST_CLASS = 'itr-caption-dst';
const NATIVE_CONTAINER_SEL = '.ytp-caption-window-container';
const NATIVE_HIDDEN_CLASS = 'itr-caption-native-hidden';
/** T-026 导出：transcript 缓冲上限（防极端长视频内存炸） */
const TRANSCRIPT_CAP = 5000;
/** T-027 字幕热区按钮（overlay 唯一 pointer-events:auto 例外，契约 subtitles.md「三入口」） */
const SHOT_CLASS = 'itr-caption-shot';
const SHOT_OK_CLASS = 'itr-caption-shot-ok';
const SHOT_LABEL = '截帧';
const SHOT_OK_LABEL = '✓ 已存';
/** probe ⑤（契约 messaging.md「手势许可」）：页内点击不构成授予，无授予时引导走 popup/热键 */
const NO_GESTURE_TIP =
  '截帧需要扩展手势：点工具栏「截帧」，或绑定热键（edge://extensions/shortcuts）';
/** 字幕通道并发上限（快语速 cue 轮转 1~3 并发即够，4 是防打爆兜底；T-021.md 边界） */
const MAX_IN_FLIGHT = 4;

/** 一次在途翻译的跟踪标记：id 仅用于摘除自己的 flightMap 登记（淘汰后不影响同文本新政请求） */
interface Flight {
  id: number;
}

export class SubtitleTranslator {
  private readonly doc: Document;
  private readonly request: (msg: RpcRequest) => Promise<RpcResponse>;
  private readonly getTargetLang: () => string;
  private readonly debounceMs: number;
  private readonly doneLimit: number;
  private readonly lingerMs: number;
  private readonly flashMs: number;
  private readonly segmentSel: string;
  private readonly rootSel: string;
  private readonly nativeSel: string;

  private observer: MutationObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 续显收敛计时器：换行后 TTL 内未见配对换行 → 隐藏 */
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  /** 最近一次屏上可见的原字幕文本：每次采样无条件刷新（含在途期间）——配对规则的基准 */
  private lastVisibleText: string | null = null;
  /** 当前覆盖层显示的译文对应的源文本：续显收敛/缓存命中去重的比较基准 */
  private shownSource: string | null = null;
  /** 在途请求表：源文本 → 标记（Map 插入序即进入序，淘汰取最旧） */
  private readonly flightMap = new Map<string, Flight>();
  /** 会话级结果缓存：源文本 → 译文（LRU ≤ doneLimit，正文不落 DOM 外介质） */
  private readonly doneTexts = new Map<string, string>();
  /** 自增序号：仅作请求 id / flight 标识，无折叠作废语义（v1 的全局 seq 已删） */
  private seq = 0;

  private overlay: HTMLElement | null = null;
  /** T-025 仅双语：双行引用（root 重建时随之重建） */
  private srcRow: HTMLElement | null = null;
  private dstRow: HTMLElement | null = null;
  /** T-027 截帧按钮引用（随 overlay 生命周期） */
  private shotBtn: HTMLButtonElement | null = null;
  /** T-027 成功反馈闪烁计时（stop/重建时清） */
  private flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** T-026 字幕导出：本 tab 内按序双语记录（生命周期见契约「导出」节） */
  private transcript: TranscriptPair[] = [];
  /** T-024 UI 可调：字号/离底（controller.applySettings 注入；null = CSS 默认） */
  private uiStyle: UiStyle | null = null;

  constructor(deps: SubtitleDeps) {
    this.doc = deps.doc;
    this.request = deps.request ?? callRpc;
    this.getTargetLang = deps.getTargetLang ?? (() => 'zh-CN');
    this.debounceMs = deps.debounceMs ?? 50;
    this.doneLimit = deps.doneLimit ?? 300;
    this.lingerMs = deps.lingerMs ?? 2000;
    this.flashMs = deps.flashMs ?? 1200;
    this.segmentSel = deps.segmentSel ?? SEGMENT_SEL;
    this.rootSel = deps.rootSel ?? PLAYER_ROOT_SEL;
    this.nativeSel = deps.nativeSel ?? NATIVE_CONTAINER_SEL;
  }

  get active(): boolean {
    return this.running;
  }

  /** T-024（M3-1 UI 可调）：字号/离底注入；overlay 已存在时即时生效（SETTINGS_CHANGED 实时性） */
  applyUiStyle(style: UiStyle): void {
    this.uiStyle = style;
    this.applyStyleVars();
  }

  private applyStyleVars(): void {
    if (!this.uiStyle || !this.overlay) return;
    this.overlay.style.setProperty('--itr-caption-font-size', `${this.uiStyle.subtitleFontSize}px`);
    this.overlay.style.setProperty('--itr-caption-bottom', `${this.uiStyle.subtitleBottom}px`);
  }

  /** 幂等启动：观察字幕容器变化 */
  start(): void {
    if (this.running) return;
    this.running = true;
    const ObserverCtor = this.doc.defaultView?.MutationObserver;
    if (!ObserverCtor) {
      logger.warn('MutationObserver unavailable, subtitle translation disabled');
      this.running = false;
      return;
    }
    this.observer = new ObserverCtor(() => this.scheduleSample());
    this.observer.observe(this.doc.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    this.scheduleSample(); // 已有字幕在屏时立即翻
  }

  /** 停止：观察断开、状态全清；在途响应因 running=false 自然作废 */
  stop(): void {
    this.running = false;
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.cancelLinger();
    this.flightMap.clear();
    this.doneTexts.clear();
    this.lastVisibleText = null;
    this.shownSource = null;
    if (this.flashTimer) {
      clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }
    this.overlay?.remove();
    this.overlay = null;
    this.srcRow = null;
    this.dstRow = null;
    this.shotBtn = null;
    this.setNativeHidden(false); // T-025：stop 撤原生隐藏（与覆盖层生命周期对称）
  }

  private scheduleSample(): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sample();
    }, this.debounceMs);
  }

  private readCaptionText(): string | null {
    const segments = Array.from(this.doc.querySelectorAll(this.segmentSel));
    if (segments.length === 0) return null;
    const text = segments
      .map((s) => s.textContent ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text || null;
  }

  /** 消费一次采样（契约 v2 数据流 §2~§6）：
   * 空→隐藏；目标语言→隐藏；缓存命中秒上屏；滚动续显；前缀/在途抑制；即刻并行请求。 */
  private sample(): void {
    if (!this.running) return;
    const text = this.readCaptionText();
    this.lastVisibleText = text; // 无条件刷新（即使有请求在途，配对基准仍以屏上现值为准）
    if (!text) {
      this.hideOverlay();
      return;
    }
    // T-018（segmentation Skip #6 字幕侧）：目标语言字幕无翻译价值，隐藏译文行。
    // 不入 flightMap/doneTexts——观察者在屏期间重复采样只会重复走隐藏（幂等、零请求）。
    if (isTargetLangText(text, this.getTargetLang())) {
      this.hideOverlay();
      return;
    }
    const cached = this.doneTexts.get(text);
    // 会话缓存命中：滚动回看/闪回秒上屏，不再发请求。
    // 同值去重：textContent 赋同值也触发 characterData mutation → 自持采样空转，跳过
    // （T-025 双行：比对基准改为 dst 行内容）
    if (cached !== undefined) {
      if (this.shownSource !== text || this.dstRow?.textContent !== cached) {
        this.show(text, cached);
      }
      return;
    }
    // 滚动续显（契约 §6 v2.1）：字幕已变不再立即隐藏——上一行译文原地续显作为过渡，
    // 由「配对换行（show 内取消计时）/ TTL 超时 / 字幕消失·目标语言（上面两个分支）」收敛。
    // 续显仅在 truly 可见时挂计时：已隐藏/未显示过的 overlay 等响应到达再显示即可
    if (text !== this.shownSource) {
      const visible = !!this.overlay && !this.overlay.hasAttribute('data-itr-hidden');
      if (visible) this.armLinger();
    }
    // 前缀抑制 + 在途去重：新文本与某在途文本相同或是其前缀 → 等完整版响应
    for (const key of this.flightMap.keys()) {
      if (key.startsWith(text)) return;
    }
    // 并发上限：超限淘汰最旧在途的跟踪标记（响应届时按配对规则自然失效，不显式 cancel）
    if (this.flightMap.size >= MAX_IN_FLIGHT) {
      const oldest = this.flightMap.keys().next().value;
      if (oldest !== undefined) this.flightMap.delete(oldest);
    }
    void this.translate(text);
  }

  private async translate(text: string): Promise<void> {
    const id = ++this.seq;
    this.flightMap.set(text, { id });
    try {
      const res = await this.request({
        type: 'TRANSLATE_BATCH',
        segments: [{ id: `cap-${id}`, text }],
        source: 'auto',
        target: this.getTargetLang(),
        requestId: `cap-req-${id}`,
      });
      if (!this.running) return; // stop 已清空状态，回包一律不落地
      if (res?.type === 'TRANSLATION' && res.items[0]) {
        const translated = res.items[0].text;
        if (translated) {
          this.remember(text, translated);
          // 配对上屏（契约 §5）：仅当屏上仍是发起时的原字幕；否则丢弃该响应（防张冠李戴）
          if (this.lastVisibleText === text) {
            this.show(text, translated);
          } else {
            logger.debug('caption response dropped: pairing mismatch with on-screen text');
          }
        }
      } else if (res?.type === 'TRANSLATION' && res.error) {
        logger.warn(`caption translate failed: ${res.error.code}`);
      }
    } catch (e) {
      logger.warn('caption request failed', e);
    } finally {
      // 只摘自己登记的标记：被淘汰或被同文本新政请求顶替时不误删他人
      if (this.flightMap.get(text)?.id === id) this.flightMap.delete(text);
    }
  }

  /** 会话结果缓存写入（Map 插入序即 LRU 序：重写刷新，超限淘汰最旧） */
  private remember(text: string, translated: string): void {
    this.doneTexts.delete(text);
    this.doneTexts.set(text, translated);
    while (this.doneTexts.size > this.doneLimit) {
      const oldest = this.doneTexts.keys().next().value;
      if (oldest === undefined) break;
      this.doneTexts.delete(oldest);
    }
  }

  /** T-025 仅双语：原生容器视觉退场的幂等开关（查询落空 → no-op 安全退化）
   * 只动 classList，原文内容/结构零写入（契约红线改约后的唯一接触面） */
  private setNativeHidden(hidden: boolean): void {
    const native = this.doc.querySelector(this.nativeSel) as HTMLElement | null;
    if (!native) return;
    native.classList.toggle(NATIVE_HIDDEN_CLASS, hidden);
  }

  /** 译文覆盖层（T-025 双行）：挂播放器根，src=原文 / dst=译文 整体配对；
   * 上屏即接管（原生隐藏），退场即归还（hideOverlay 撤隐藏）。 */
  private show(source: string, translated: string): void {
    const root = this.doc.querySelector(this.rootSel);
    if (!root) {
      logger.warn('subtitle root not found, skip rendering');
      return;
    }
    // T-020（契约「字幕 overlay 活性」）：SPA 导航重建播放器后旧 overlay 已
    // detached，继续写 textContent 是写进 homeless 节点 → 用户只见第一次字幕。
    if (this.overlay && !this.overlay.isConnected) {
      this.overlay = null;
      this.srcRow = null;
      this.dstRow = null;
      this.shotBtn = null;
      this.transcript = []; // T-026：重建 = 新视频 → 记录重新开篇
    }
    if (!this.overlay) {
      this.overlay = this.doc.createElement('div');
      this.overlay.className = LINE_CLASS;
      this.overlay.setAttribute('data-itr-caption', '1');
      this.overlay.style.setProperty('pointer-events', 'none');
      this.srcRow = this.doc.createElement('div');
      this.srcRow.className = SRC_CLASS;
      this.dstRow = this.doc.createElement('div');
      this.dstRow.className = DST_CLASS;
      this.overlay.append(this.srcRow, this.dstRow);
      root.appendChild(this.overlay);
      this.applyStyleVars(); // T-024：overlay 重建（SPA/stop）后立即带上当前旋钮
    } else if (!this.srcRow || !this.dstRow) {
      // 防御：存量根缺行（异常路径）→ 就地补齐
      this.srcRow = this.ensureRow(SRC_CLASS, this.srcRow);
      this.dstRow = this.ensureRow(DST_CLASS, this.dstRow);
    }
    this.ensureShotBtn(); // T-027：三种根状态（新建/防御补齐/健在）都要有热区按钮
    this.srcRow.textContent = source;
    this.dstRow.textContent = translated;
    this.shownSource = source;
    // T-026 导出记录：配对换行即追加；同值连对不重记（去重防线天然防重）
    const last = this.transcript[this.transcript.length - 1];
    if ((!last || last.src !== source || last.dst !== translated) && this.transcript.length < TRANSCRIPT_CAP) {
      this.transcript.push({ src: source, dst: translated });
    }
    this.overlay.removeAttribute('data-itr-hidden');
    this.cancelLinger(); // 配对换行（含缓存命中）已发生 → TTL 收敛计时作废
    this.setNativeHidden(true); // 双语条接管：原生退场（幂等）
  }

  private ensureRow(cls: string, existing: HTMLElement | null): HTMLElement {
    if (existing) return existing;
    const row = this.doc.createElement('div');
    row.className = cls;
    this.overlay?.append(row);
    return row;
  }

  /** T-026 字幕导出：记录读出（深拷贝；stop 不清空，见契约「导出」节生命周期） */
  transcriptSnapshot(): TranscriptPair[] {
    return this.transcript.map((p) => ({ ...p }));
  }

  /** T-027 截帧上下文：lecture <video>.currentTime + 当前上屏字幕对 + videoId（契约「关键帧绑定」） */
  keyframeContext(): KeyframeContext {
    const video = this.doc.querySelector('video') as HTMLVideoElement | null;
    const t = video && typeof video.currentTime === 'number' && Number.isFinite(video.currentTime) && video.currentTime >= 0
      ? video.currentTime
      : null;
    return {
      videoId: parseVideoId(this.doc.location?.href ?? ''),
      videoTime: t,
      src: this.shownSource ?? '',
      dst: this.dstRow?.textContent ?? '',
    };
  }

  /** T-027 字幕热区按钮：overlay 唯一的 pointer-events:auto 例外（按钮自带 auto） */
  private ensureShotBtn(): HTMLButtonElement {
    if (this.shotBtn?.isConnected) return this.shotBtn;
    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.className = SHOT_CLASS;
    // 契约「三入口」：overlay 内联 none，按钮内联 auto（唯一例外必须不依赖样式表加载序）
    btn.style.pointerEvents = 'auto';
    btn.textContent = SHOT_LABEL;
    btn.addEventListener('click', () => void this.requestCapture());
    this.overlay?.append(btn);
    this.shotBtn = btn;
    return btn;
  }

  /** T-027 点击截帧：直投 Rpc CAPTURE_KEYFRAME（content 零触像素；capture 全在 SW） */
  private async requestCapture(): Promise<void> {
    let res: RpcResponse;
    try {
      res = await this.request({ type: 'CAPTURE_KEYFRAME', ...this.keyframeContext() });
    } catch (e) {
      logger.warn('caption capture request failed', e);
      showTip(this.doc, '截帧请求失败，请确认扩展后台运行', { autoHideMs: 5000 });
      return;
    }
    if (res.type === 'KEYFRAME_SAVED' && !res.error) {
      this.flashShotBtn();
      return;
    }
    const code = res.type === 'KEYFRAME_SAVED' && res.error ? res.error.code : 'E_NO_GESTURE';
    showTip(
      this.doc,
      code === 'E_NO_GESTURE' ? NO_GESTURE_TIP : `截帧失败（${code}），请稍后重试`,
      { autoHideMs: 6000 },
    );
  }

  /** 成功反馈：按钮瞬时闪「✓ 已存」（flashMs 注入，测试注入小值） */
  private flashShotBtn(): void {
    const btn = this.shotBtn;
    if (!btn) return;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    btn.textContent = SHOT_OK_LABEL;
    btn.classList.add(SHOT_OK_CLASS);
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      btn.textContent = SHOT_LABEL;
      btn.classList.remove(SHOT_OK_CLASS);
    }, this.flashMs);
  }

  private hideOverlay(): void {
    this.cancelLinger();
    this.overlay?.setAttribute('data-itr-hidden', 'true');
    this.setNativeHidden(false); // 双语条退场 → 原生兜底直显
  }

  /** 续显计时：TTL 内未见换行则隐藏（新译文/缓存命中会先取消计时）。
   * 已有 pending 计时则不重置——快速滚动下反复续期会造成无限顺延；首轮 TTL 收敛即可。 */
  private armLinger(): void {
    if (this.lingerTimer) return;
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      this.hideOverlay();
    }, this.lingerMs);
  }

  private cancelLinger(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = null;
    }
  }
}
