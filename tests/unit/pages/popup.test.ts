// popup 指令投递单测（契约 messaging.md「指令投递可靠性」T-015）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { KEYFRAME_STORE_KEY, type KeyframeRecord } from '../../../src/shared/keyframes';
import type { KeyframeContextPayload } from '../../../src/shared/messaging';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** T-026 下载捕获：bootPopup 内 stub anchor.click，记录点击时刻的文件名/href */
let downloadCapture: Array<{ name: string | null; href: string | null }> = [];

const POPUP_HTML = `
  <button id="translate"></button>
  <button id="stop"></button>
  <input type="checkbox" id="auto" />
  <input type="checkbox" id="sel" />
  <input type="checkbox" id="hover" />
  <section id="export" hidden>
    <p class="export-title">字幕导出 <span id="export-count"></span></p>
    <div class="export-row">
      <button id="export-md"></button>
      <button id="export-html"></button>
      <button id="export-sum"></button>
    </div>
  </section>
  <section id="kframe">
    <p class="export-title">关键帧 <span id="kframe-count"></span></p>
    <div class="export-row">
      <button id="kframe-shot"></button>
    </div>
    <div class="export-row" id="kframe-actions" hidden>
      <button id="kframe-md"></button>
      <button id="kframe-list"></button>
      <button id="kframe-clear"></button>
    </div>
  </section>
  <span id="state"></span>`;

interface MockState {
  /** true = 首次 sendMessage 抛「Receiving end does not exist」（陈旧 tab） */
  failFirstSend: boolean;
  injectFails: boolean;
  /** 注入完成后 sendMessage 恢复正常 */
  healed: boolean;
  sent: unknown[];
  injections: Array<{ files: string[]; tabId: number }>;
  /** storage.local.get 回读快照（boot 回显 / 失败恢复用） */
  settingsSnapshot?: { selectionEnabled?: boolean; hoverEnabled?: boolean };
  /** runtime.sendMessage（rpc）响应中的服务端权威设置 */
  rpcSettings?: { selectionEnabled?: boolean; hoverEnabled?: boolean };
  /** true = runtime.sendMessage（rpc）直接失败 */
  rpcFails?: boolean;
  /** T-026：GET_TRANSCRIPT 回包（undefined → 空 payload → section 隐藏） */
  transcript?: { title: string; pairs: Array<{ src: string; dst: string }> };
  /** T-026：SUMMARIZE_TEXT 回包行为 */
  summaryText?: string;
  summaryError?: string;
  /** T-027：itr-kf-store 回读帧（缺省 → 空帧/actions 隐藏）；clear 的 set 会回写此字段以驱动 refreshKeyframes */
  keyframes?: KeyframeRecord[];
  /** T-027：Rpc CAPTURE_KEYFRAME 回包错误码（undefined → 成功 KEYFRAME_SAVED） */
  kfRpcError?: string;
  kfRpcNoResp?: boolean;
  /** T-027：content 对 TabAction CAPTURE_KEYFRAME 的同步回包（缺省 → 空上下文 KEYFRAME_CONTEXT） */
  kfTabContext?: KeyframeContextPayload;
}

function makeChromeMock(state: MockState) {
  const chrome = {
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: 'https://x.com/home' }]),
      sendMessage: vi.fn(async (_tabId: number, msg: unknown) => {
        if (!state.healed && state.failFirstSend) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        const type = (msg as { type?: string } | null)?.type;
        if (type === 'GET_TRANSCRIPT') {
          // T-026：transcript 未配置 → 空 payload（0 条 → section 隐藏）；探针不入 state.sent（保持既有精确断言）
          return { type: 'TRANSCRIPT', title: state.transcript?.title ?? '', pairs: state.transcript?.pairs ?? [] };
        }
        if (type === 'CAPTURE_KEYFRAME') {
          // T-027 第二跳入口：content 同步回包 KEYFRAME_CONTEXT（消费方 popup 未配 → 空上下文回包）
          return (
            state.kfTabContext ?? {
              type: 'KEYFRAME_CONTEXT',
              videoId: '',
              videoTime: null,
              src: '',
              dst: '',
            }
          );
        }
        state.sent.push(msg);
        return undefined;
      }),
    },
    scripting: {
      executeScript: vi.fn(async (details: { files: string[]; target: { tabId: number } }) => {
        if (state.injectFails) throw new Error('Cannot access contents of the url');
        state.healed = true;
        state.injections.push({ files: details.files, tabId: details.target.tabId });
      }),
    },
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[] | null) => {
          // T-027：popup 按单键读关键帧 store；其余调用（'itr_settings'）维持原快照
          if (keys === KEYFRAME_STORE_KEY) {
            return { [KEYFRAME_STORE_KEY]: { frames: state.keyframes ?? [] } };
          }
          return {
            itr_settings: { autoTranslateSites: [], ...(state.settingsSnapshot ?? {}) },
          };
        }),
        set: vi.fn(async (obj?: Record<string, unknown>) => {
          // T-027 清除回写：真实语义为「写 {frames:[]}」→ refreshKeyframes 回读即空
          const val = obj?.[KEYFRAME_STORE_KEY] as { frames?: KeyframeRecord[] } | undefined;
          state.keyframes = val?.frames ?? [];
        }),
      },
      onChanged: { addListener: vi.fn() },
    },
    runtime: {
      sendMessage: vi.fn(async (msg?: unknown) => {
        if (state.rpcFails) throw new Error('service worker down');
        if ((msg as { type?: string } | null)?.type === 'CAPTURE_KEYFRAME') {
          // T-027：缺接收端 → 空上下文 Rpc 回包（成功 KEYFRAME_SAVED / 拍板上仅有 E_NO_GESTURE 降级）
          if (state.kfRpcNoResp) return undefined; // 端口即闭：callRpc 归一 NOT_SUPPORTED
          return state.kfRpcError
            ? { type: 'KEYFRAME_SAVED', error: { code: state.kfRpcError } }
            : { type: 'KEYFRAME_SAVED', id: 'kf-1', videoTime: null };
        }
        if ((msg as { type?: string } | null)?.type === 'SUMMARIZE_TEXT') {
          if (state.summaryError) return { type: 'SUMMARY', error: { code: state.summaryError } };
          return { type: 'SUMMARY', text: state.summaryText ?? '测试简述' };
        }
        return {
          type: 'SETTINGS',
          settings: {
            selectionEnabled: true,
            hoverEnabled: true,
            ...(state.rpcSettings ?? {}),
          },
        };
      }),
    },
  };
  return chrome;
}

async function bootPopup(chromeMock: unknown): Promise<HTMLElement> {
  vi.resetModules();
  const dom = new JSDOM(`<!doctype html><html><body>${POPUP_HTML}</body></html>`);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('chrome', chromeMock);
  // T-026 导出下载链路：jsdom 无 createObjectURL → 本测试域 stub；anchor click 阻导航并捕获
  downloadCapture = [];
  const domWin = dom.window as unknown as {
    URL: Record<string, unknown>;
    HTMLAnchorElement: { prototype: HTMLAnchorElement };
  };
  domWin.URL.createObjectURL = (): string => 'blob:itr-test';
  domWin.URL.revokeObjectURL = (): void => undefined;
  domWin.HTMLAnchorElement.prototype.click = function testClick(this: HTMLAnchorElement): void {
    downloadCapture.push({ name: this.getAttribute('download'), href: this.getAttribute('href') });
  };
  await import('../../../src/pages/popup/index');
  await sleep(20); // 等 click 事件的异步处理器走完
  return dom.window.document.documentElement;
}

function stateText(): string {
  return document.getElementById('state')?.textContent ?? '';
}

async function click(id: string): Promise<void> {
  const target = document.getElementById(id);
  const Ctor = target?.ownerDocument.defaultView?.Event;
  if (!target || !Ctor) throw new Error('click target missing');
  target.dispatchEvent(new Ctor('click', { bubbles: true }));
  await sleep(20);
}

async function toggle(id: string): Promise<void> {
  const target = document.getElementById(id) as HTMLInputElement | null;
  const Ctor = target?.ownerDocument.defaultView?.Event;
  if (!target || !Ctor) throw new Error('toggle target missing');
  target.checked = !target.checked;
  target.dispatchEvent(new Ctor('change', { bubbles: true }));
  await sleep(20);
}

function box(id: string): HTMLInputElement {
  const b = document.getElementById(id) as HTMLInputElement | null;
  if (!b) throw new Error(`${id} missing`);
  return b;
}

describe('popup 划词/悬停总开关（SET_SETTINGS patch → 权威快照回写）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('关闭划词：发 SET_SETTINGS{selectionEnabled:false}，状态提示 + 快照回写', async () => {
    const chromeMock = makeChromeMock({
      failFirstSend: false,
      injectFails: false,
      healed: false,
      sent: [],
      injections: [],
      rpcSettings: { selectionEnabled: false },
    });
    await bootPopup(chromeMock);
    await toggle('sel');
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SET_SETTINGS',
      patch: { selectionEnabled: false },
    });
    expect(stateText()).toBe('划词翻译已关闭');
    expect(box('sel').checked).toBe(false); // 服务端权威值
  });

  it('关闭悬停：发 SET_SETTINGS{hoverEnabled:false}，状态提示 + 快照回写', async () => {
    const chromeMock = makeChromeMock({
      failFirstSend: false,
      injectFails: false,
      healed: false,
      sent: [],
      injections: [],
      rpcSettings: { hoverEnabled: false },
    });
    await bootPopup(chromeMock);
    await toggle('hover');
    expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'SET_SETTINGS',
      patch: { hoverEnabled: false },
    });
    expect(stateText()).toBe('悬停翻译已关闭');
    expect(box('hover').checked).toBe(false);
  });

  it('storage.onChanged 外部改动（如 options 页保存）→ 开关回显', async () => {
    const st: MockState = {
      failFirstSend: false,
      injectFails: false,
      healed: false,
      sent: [],
      injections: [],
    };
    const chromeMock = makeChromeMock(st);
    await bootPopup(chromeMock);
    // boot 时 storage 缺省 → 两开关均为 true（代码默认）
    expect(box('sel').checked).toBe(true);
    expect(box('hover').checked).toBe(true);
    // options 页在别处保存了关闭 → storage.onChanged 推送 + 回读
    st.settingsSnapshot = { selectionEnabled: false, hoverEnabled: false };
    const listener = (chromeMock.storage.onChanged.addListener as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as (c: unknown, area: string) => void;
    listener(
      { itr_settings: { newValue: { selectionEnabled: false, hoverEnabled: false } } },
      'local',
    );
    await sleep(20);
    expect(box('sel').checked).toBe(false);
    expect(box('hover').checked).toBe(false);
  });

  it('rpc 失败：提示重试并回读 storage 恢复显示', async () => {
    await bootPopup(
      makeChromeMock({
        failFirstSend: false,
        injectFails: false,
        healed: false,
        sent: [],
        injections: [],
        rpcFails: true,
      }),
    );
    await toggle('sel'); // 本地翻转为 false，但 SW 不可达
    expect(stateText()).toBe('切换失败，请重试');
    expect(box('sel').checked).toBe(true); // 回读 storage（缺省 true）
  });
});

describe('popup 指令投递（契约「指令投递可靠性」）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('正常 tab：直接 sendMessage，不注入', async () => {
    const state: MockState = {
      failFirstSend: false,
      injectFails: false,
      healed: false,
      sent: [],
      injections: [],
    };
    await bootPopup(makeChromeMock(state));
    await click('translate');
    expect(state.sent).toEqual([{ type: 'TRANSLATE_PAGE' }]);
    expect(state.injections).toHaveLength(0);
    expect(stateText()).toBe('已请求翻译');
  });

  it('陈旧 tab（接收端不存在）：补注入 content/index.js 后重发成功', async () => {
    const state: MockState = {
      failFirstSend: true,
      injectFails: false,
      healed: false,
      sent: [],
      injections: [],
    };
    await bootPopup(makeChromeMock(state));
    await click('translate');
    expect(state.injections).toEqual([{ files: ['content/index.js'], tabId: 7 }]);
    expect(state.sent).toEqual([{ type: 'TRANSLATE_PAGE' }]); // 重发成功
    expect(stateText()).toBe('已请求翻译');
  });

  it('注入也失败（不可注入页）：提示刷新，不误报成功', async () => {
    const state: MockState = {
      failFirstSend: true,
      injectFails: true,
      healed: false,
      sent: [],
      injections: [],
    };
    await bootPopup(makeChromeMock(state));
    await click('stop');
    expect(state.sent).toHaveLength(0);
    expect(stateText()).toBe('页面不支持注入，请刷新后重试');
  });

  it('T-016 注入单飞：陈旧 tab 连点两次只注入一次，各自重发指令', async () => {
    const state: MockState = {
      failFirstSend: true,
      injectFails: false,
      healed: false,
      sent: [],
      injections: [],
    };
    // 注入延迟 30ms，制造「注入进行中再次点击」的竞态窗口
    const chromeMock = makeChromeMock(state);
    (chromeMock.scripting.executeScript as ReturnType<typeof vi.fn>).mockImplementation(
      async (details: { files: string[]; target: { tabId: number } }) => {
        await sleep(30);
        state.healed = true;
        state.injections.push({ files: details.files, tabId: details.target.tabId });
      },
    );
    await bootPopup(chromeMock);
    await Promise.all([click('translate'), click('translate')]); // 并发两次点击
    await sleep(80);
    expect(state.injections).toEqual([{ files: ['content/index.js'], tabId: 7 }]); // 只注入一次
    expect(state.sent.filter((m) => (m as { type: string }).type === 'TRANSLATE_PAGE')).toHaveLength(2);
    expect(stateText()).toBe('已请求翻译');
  });

  it('其他错误（非接收端缺失）：不进入注入路径', async () => {
    const chromeMock = makeChromeMock({
      failFirstSend: false,
      injectFails: false,
      healed: false,
      sent: [],
      injections: [],
    });
    await bootPopup(chromeMock); // T-026 起 boot 会先发 GET_TRANSCRIPT 探针 → 失败注入到「点击」这次调用
    (chromeMock.tabs.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('message port closed'),
    );
    await click('translate');
    expect(chromeMock.scripting.executeScript).not.toHaveBeenCalled();
    expect(stateText()).toBe('无法连接页面，请刷新重试');
  });
});

describe('popup 字幕导出（T-026 / M3-3）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('boot 拉取 transcript → section 显示 + 条数；空记录 → 隐藏', async () => {
    const shown = await bootPopup(
      makeChromeMock({
        failFirstSend: false,
        injectFails: false,
        healed: false,
        sent: [],
        injections: [],
        transcript: { title: '测试片名', pairs: [{ src: 'a', dst: 'b' }, { src: 'c', dst: 'd' }] },
      }),
    );
    expect((shown.querySelector('#export') as HTMLElement | null)?.hidden).toBe(false);
    expect((shown.ownerDocument.getElementById('export-count')?.textContent ?? '')).toContain('2 条');

    const empty = await bootPopup(
      makeChromeMock({ failFirstSend: false, injectFails: false, healed: false, sent: [], injections: [] }),
    );
    expect((empty.querySelector('#export') as HTMLElement | null)?.hidden).toBe(true);
  });

  it('接收端不存在 → 隐藏导出区、不补注入（expired tab 不为导出重启记录）', async () => {
    const chromeMock = makeChromeMock({
      failFirstSend: true,
      injectFails: false,
      healed: false,
      sent: [],
      injections: [],
      transcript: { title: 'T', pairs: [{ src: 'a', dst: 'b' }] },
    });
    const root = await bootPopup(chromeMock);
    expect((root.querySelector('#export') as HTMLElement | null)?.hidden).toBe(true);
    expect((chromeMock.scripting.executeScript as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect((chromeMock.tabs.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toEqual({
      type: 'GET_TRANSCRIPT',
    });
  });

  it('导出 MD：anchor download + 文件名清洗；MD+AI 简述走 SUMMARIZE_TEXT 并产出含简述文件', async () => {
    const chromeMock = makeChromeMock({
      failFirstSend: false,
      injectFails: false,
      healed: false,
      sent: [],
      injections: [],
      transcript: {
        title: '我的"片": 品牌',
        pairs: [{ src: 'hello', dst: '译：hello' }],
      },
      summaryText: '要点概括。',
    });
    await bootPopup(chromeMock);
    await click('export-md');
    expect(downloadCapture).toEqual([{ name: '我的 片 品牌.md', href: 'blob:itr-test' }]);
    expect(stateText()).toBe('已导出 MD');

    await click('export-sum');
    const rpcCalls = (chromeMock.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const last = (rpcCalls.at(-1)?.[0] ?? {}) as { type: string; requestId: string; text: string };
    expect(last.type).toBe('SUMMARIZE_TEXT');
    expect(last.text).toBe('hello');
    expect(last.requestId).toContain('sum-');
    expect(stateText()).toBe('已导出 MD+AI 简述');
    expect(downloadCapture).toHaveLength(2); // 第二个含 AI 简述的 MD 同名产出
  });

  it('简述失败 → 错误文案且不产出文件（E_NO_KEY 映射）', async () => {
    const chromeMock = makeChromeMock({
      failFirstSend: false,
      injectFails: false,
      healed: false,
      sent: [],
      injections: [],
      transcript: { title: 'T', pairs: [{ src: 'x', dst: 'y' }] },
      summaryError: 'E_NO_KEY',
    });
    await bootPopup(chromeMock);
    await click('export-sum');
    expect(stateText()).toBe('简述需先在设置配置 OpenAI 兼容引擎');
    expect(downloadCapture).toHaveLength(0);
  });

  it('限流错误码 E_RATE_LIMITED → 「引擎限流」文案（与 shared/types 权威码一字不差）', async () => {
    const chromeMock = makeChromeMock({
      failFirstSend: false,
      injectFails: false,
      healed: false,
      sent: [],
      injections: [],
      transcript: { title: 'T', pairs: [{ src: 'x', dst: 'y' }] },
      summaryError: 'E_RATE_LIMITED',
    });
    await bootPopup(chromeMock);
    await click('export-sum');
    expect(stateText()).toBe('引擎限流，稍后再试');
    expect(downloadCapture).toHaveLength(0);
  });
});

describe('popup 关键帧区（T-027 / M3-4，契约 subtitles.md「关键帧绑定」）', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  function baseState(): MockState {
    return { failFirstSend: false, injectFails: false, healed: false, sent: [], injections: [] };
  }

  function kf(id: string, videoId: string, videoTime: number | null): KeyframeRecord {
    return {
      id,
      videoId,
      videoTime,
      src: `${videoId} 台词`,
      dst: `译：${videoId}`,
      jpeg: 'data:image/jpeg;base64,AA==',
      createdAt: 1760000000000,
    };
  }

  it('boot 回显：无帧 → 计数空 + actions 隐藏；有帧 → ·N 帧 + actions 现身；onChanged 二刷', async () => {
    const empty = await bootPopup(makeChromeMock(baseState()));
    expect(empty.ownerDocument.getElementById('kframe-count')?.textContent ?? '').toBe('');
    expect(empty.ownerDocument.getElementById('kframe-actions')?.hidden).toBe(true);

    const st: MockState = { ...baseState(), keyframes: [kf('kf-1', 'v1', 65.4), kf('kf-2', 'v1', 90)] };
    const shoMock = makeChromeMock(st);
    const shown = await bootPopup(shoMock);
    expect(shown.ownerDocument.getElementById('kframe-count')?.textContent ?? '').toContain('2 帧');
    expect(shown.ownerDocument.getElementById('kframe-actions')?.hidden).toBe(false);

    // SW 落库成功 → KEYFRAME_SAVED 广播触发 storage.onChanged → 关键帧区二次刷新
    st.keyframes = [...st.keyframes ?? [], kf('kf-3', 'v2', 5)];
    const listener = (shoMock.storage.onChanged.addListener as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as (c: unknown, area: string) => void;
    listener({ [KEYFRAME_STORE_KEY]: { newValue: { frames: st.keyframes } } }, 'local');
    await sleep(20);
    expect(shown.ownerDocument.getElementById('kframe-count')?.textContent ?? '').toContain('3 帧');
  });

  it('popup「截帧」两跳：TabAction 拿 KEYFRAME_CONTEXT → Rpc 代交 SW；缺接收端 → 空上下文直投', async () => {
    const tabCtx: KeyframeContextPayload = {
      type: 'KEYFRAME_CONTEXT',
      videoId: 'v7',
      videoTime: 12.5,
      src: '甲',
      dst: '译：甲',
    };
    const normal = makeChromeMock({ ...baseState(), kfTabContext: tabCtx });
    await bootPopup(normal);
    await click('kframe-shot');
    const sent = normal.tabs.sendMessage as ReturnType<typeof vi.fn>;
    const captureCall = sent.mock.calls
      .map((c) => ({ tabId: c[0], msg: c[1] as { type?: string } }))
      .find((c) => c.msg.type === 'CAPTURE_KEYFRAME');
    expect(captureCall?.tabId).toBe(7);
    expect(captureCall?.msg).toEqual({ type: 'CAPTURE_KEYFRAME' }); // 第一跳：TabAction 拿上下文
    expect(normal.runtime.sendMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({
      type: 'CAPTURE_KEYFRAME', // 第二跳：上下文原样交付 SW capture
      videoId: 'v7',
      videoTime: 12.5,
      src: '甲',
      dst: '译：甲',
    });
    expect((normal.scripting.executeScript as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(stateText()).toBe('已截帧');

    const stale = makeChromeMock({ ...baseState(), failFirstSend: true });
    await bootPopup(stale);
    await click('kframe-shot');
    expect(stale.runtime.sendMessage as ReturnType<typeof vi.fn>).toHaveBeenCalledWith({
      type: 'CAPTURE_KEYFRAME',
      videoId: '',
      videoTime: null,
      src: '',
      dst: '',
    });
    expect((stale.scripting.executeScript as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(stateText()).toBe('已截帧'); // mock 回 KEYFRAME_SAVED 成功
  });

  it('Rpc 拒绝：E_NO_GESTURE → 手势降级文案；其他错误码 → 通用「截帧失败」', async () => {
    await bootPopup(makeChromeMock({ ...baseState(), failFirstSend: true, kfRpcError: 'E_NO_GESTURE' }));
    await click('kframe-shot');
    expect(stateText()).toBe('截帧被拒（需扩展手势）');

    await bootPopup(makeChromeMock({ ...baseState(), failFirstSend: true, kfRpcError: 'E_TIMEOUT' }));
    await click('kframe-shot');
    expect(stateText()).toBe('截帧失败');
  });

  it('Rpc 无应答（端口即闭 → callRpc 归一 NOT_SUPPORTED）→「后台未就绪」而非虚报「已截帧」', async () => {
    // L3 发现：SW capture 悬死（Edge 156 扩展页可见 tab 时 promise 永不落定）曾让 popup 误报成功
    await bootPopup(makeChromeMock({ ...baseState(), failFirstSend: true, kfRpcNoResp: true }));
    await click('kframe-shot');
    expect(stateText()).toBe('后台未就绪，请重试');
  });

  it('导出：MD(图) 按 keyframesFilename 下载（多视频取首帧 videoId）；时间戳清单同链路', async () => {
    await bootPopup(makeChromeMock({ ...baseState(), keyframes: [kf('kf-1', 'v1', 65.4), kf('kf-2', 'v2', -1)] }));
    await click('kframe-md');
    expect(downloadCapture).toEqual([{ name: 'itr-keyframes-v1.md', href: 'blob:itr-test' }]);
    expect(stateText()).toBe('已导出关键帧 MD');

    await click('kframe-list');
    expect(downloadCapture).toHaveLength(2);
    expect(downloadCapture[1]?.name).toBe('itr-keyframes-v1.md');
    expect(stateText()).toBe('已导出时间戳清单');
  });

  it('清除 → storage.set 写 itr-kf-store {frames:[]}，回显清空（actions 复隐）', async () => {
    const st: MockState = { ...baseState(), keyframes: [kf('kf-1', 'v1', 65.4)] };
    const chromeMock = makeChromeMock(st);
    await bootPopup(chromeMock);
    await click('kframe-clear');
    expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
      [KEYFRAME_STORE_KEY]: { frames: [] },
    });
    expect(stateText()).toBe('已清空关键帧');
    await sleep(20); // 清后 refreshKeyframes 回读（mock set 已回写 state）
    expect(document.getElementById('kframe-actions')?.hidden).toBe(true);
    expect(document.getElementById('kframe-count')?.textContent).toBe('');
  });
});
