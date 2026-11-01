// T-010 初建 / T-021a 数据流 v2（契约 .agent/spec/contracts/subtitles.md「数据流 v2」）：
// 即时并行 + 源文本配对 + 滚动续显（TTL 收敛） + 前缀抑制 + 会话 LRU 缓存。
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { SubtitleTranslator } from '../../../src/content/subtitles';
import type { RpcRequest, RpcResponse } from '../../../src/shared/messaging';
import { defaultUiStyle, type UiStyle } from '../../../src/shared/ui-style';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  doc: Document;
  player: HTMLElement;
  setCaption(text: string | null): void;
  /** SW 回包队列：按请求顺序 resolve('显示的译文原文') */
  reply(translationBase: string): void;
  sub: SubtitleTranslator;
  requests: RpcRequest[];
}

function harness(
  html = "<div id='player'><div class='ytp-caption-window-container'><div class='capwin'><div class='cap'>初始字幕文本</div></div></div></div>",
  getTargetLang: () => string = () => 'en', // T-018 内容默认 zh 会被 Skip #6 跳过，行为用例走 en
  doneLimit?: number,
  lingerMs?: number,
): Harness {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, {
    url: 'https://www.youtube.com/watch?v=x',
  });
  const doc = dom.window.document;
  const requests: RpcRequest[] = [];
  const queue: Array<(base: string) => void> = [];
  const request = (msg: RpcRequest): Promise<RpcResponse> => {
    requests.push(msg);
    return new Promise<RpcResponse>((resolve) => {
      queue.push((base) => {
        const seg = msg.type === 'TRANSLATE_BATCH' ? msg.segments[0] : undefined;
        resolve({
          type: 'TRANSLATION',
          items: [{ id: seg?.id ?? '', text: `译：${base}` }],
        });
      });
    });
  };
  const h: Harness = {
    doc,
    player: doc.querySelector('#player') as HTMLElement,
    requests,
    setCaption(text: string | null): void {
      if (text === null) {
        doc.querySelector('.cap')?.remove();
        return;
      }
      let win = doc.querySelector('.capwin');
      if (!win) {
        win = doc.createElement('div');
        win.className = 'capwin';
        h.player.append(win);
      }
      let seg = doc.querySelector('.cap');
      if (!seg) {
        seg = doc.createElement('div');
        seg.className = 'cap';
        win.append(seg);
      }
      seg.textContent = text;
    },
    reply(translationBase: string): void {
      const resolve = queue.shift();
      if (!resolve) throw new Error('no pending request');
      resolve(translationBase);
    },
    sub: new SubtitleTranslator({
      doc,
      request,
      getTargetLang,
      debounceMs: 10,
      ...(doneLimit !== undefined ? { doneLimit } : {}),
      ...(lingerMs !== undefined ? { lingerMs } : {}),
      segmentSel: '.cap',
      rootSel: '#player',
    }),
  };
  return h;
}

describe('SubtitleTranslator（契约 subtitles.md 数据流 v2）', () => {
  it('检测字幕 → 请求 → 覆盖层显示译文；原字幕 DOM 只读', async () => {
    const h = harness();
    h.sub.start();
    await sleep(40);
    expect(h.requests).toHaveLength(1);
    const req = h.requests[0];
    expect(req.type === 'TRANSLATE_BATCH' && req.segments[0]?.text).toBe('初始字幕文本');
    h.reply('原始字幕内容');
    await sleep(10);
    const line = h.player.querySelector('.itr-caption-line');
    expect(line?.textContent).toContain('译：原始字幕内容');
    expect(h.player.querySelector('.itr-caption-src')?.textContent).toBe('初始字幕文本'); // 原文行=采样文本
    expect(h.player.querySelector('.itr-caption-dst')?.textContent).toBe('译：原始字幕内容');
    expect(h.doc.querySelector('.cap')?.textContent).toBe('初始字幕文本'); // 原字幕不动
  });

  it('即时并行（折叠语义已删）：两文本快速先后 → 两条请求均发出，旧响应不配对丢弃', async () => {
    const h = harness();
    h.sub.start();
    await sleep(40); // 请求 A 在途
    expect(h.requests).toHaveLength(1);

    h.setCaption('第二条字幕'); // 在途期间到达 → 不再折叠，立即并发发出
    await sleep(40);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].type === 'TRANSLATE_BATCH' && h.requests[1].segments[0]?.text).toBe(
      '第二条字幕',
    );

    h.reply('第一条字幕'); // 响应到达时屏上已是第二条 → 配对失败 → 丢弃
    await sleep(10);
    expect(h.player.querySelector('.itr-caption-line')).toBeNull(); // 绝不上屏陈旧台词

    h.reply('第二条字幕'); // 恰逢配对 → 重新显示
    await sleep(10);
    const line = h.player.querySelector('.itr-caption-line');
    expect(line?.getAttribute('data-itr-hidden')).toBeNull();
    expect(line?.querySelector('.itr-caption-dst')?.textContent).toBe('译：第二条字幕');

    await sleep(25); // 观察者继续在屏：在途命中不再重复请求
    expect(h.requests).toHaveLength(2);
  });

  it('配对规则：响应到达时 lastVisibleText 已变 → 不渲染；一致 → 渲染', async () => {
    const h = harness("<div id='player'></div>");
    h.sub.start();
    h.setCaption('甲');
    await sleep(30);
    h.setCaption('乙');
    await sleep(30);
    expect(h.requests).toHaveLength(2); // 甲乙两条并发都在途

    h.reply('甲'); // 此时屏上是『乙』→ 甲的响应作废
    await sleep(10);
    expect(h.player.querySelector('.itr-caption-line')).toBeNull();

    h.reply('乙'); // 与屏上字幕配对 → 上屏
    await sleep(10);
    const dstRow = h.player.querySelector('.itr-caption-dst');
    expect(dstRow?.textContent).toBe('译：乙');
  });

  it('滚动续显（T-021a 复测微调）：换行不闪，旧行原地待换；TTL 内配对则原地换行，超时才隐藏', async () => {
    const h = harness("<div id='player'></div>", () => 'en', undefined, 250);
    h.sub.start();
    h.setCaption('甲');
    await sleep(30);
    h.reply('甲');
    await sleep(10);
    const line = () => h.player.querySelector('.itr-caption-line');
    const dst = () => h.player.querySelector('.itr-caption-dst');
    expect(line()?.getAttribute('data-itr-hidden')).toBeNull();

    h.setCaption('乙'); // 新一屏字幕，乙尚无结果也不在途 → 不再立即隐藏（消闪）
    await sleep(30);
    expect(h.requests).toHaveLength(2); // 续显同时不耽误即时并行：乙的请求照发
    expect(line()?.getAttribute('data-itr-hidden')).toBeNull(); // 旧行续显可见
    expect(dst()?.textContent).toBe('译：甲'); // 未配对前不换文案

    h.reply('乙'); // 配对到达 → 原地换行（纯 swap，无先隐藏再显示的闪动）
    await sleep(10);
    expect(line()?.getAttribute('data-itr-hidden')).toBeNull();
    expect(dst()?.textContent).toBe('译：乙');

    h.setCaption('丙'); // 丙无响应 → 超过 TTL 收敛隐藏
    await sleep(30);
    await sleep(260); // > lingerMs(250) + 采样防抖余量
    expect(line()?.getAttribute('data-itr-hidden')).toBe('true');
    expect(dst()?.textContent).toBe('译：乙'); // TTL 隐藏不删内容

    h.reply('丙'); // 迟到响应仍配对（屏上还是丙）→ 重新显示，自然自愈
    await sleep(10);
    expect(line()?.getAttribute('data-itr-hidden')).toBeNull();
    expect(dst()?.textContent).toBe('译：丙');
  });

  it('前缀抑制：在途完整版的短读采样不发新请求；文本增长照发', async () => {
    const h = harness("<div id='player'></div>");
    h.sub.start();
    h.setCaption('L1');
    await sleep(30);
    expect(h.requests).toHaveLength(1); // 'L1' 在途

    // 闪回同一短文本（DOM 抖动重采样）：在途命中跳过
    h.setCaption(null);
    await sleep(25);
    h.setCaption('L1');
    await sleep(25);
    expect(h.requests).toHaveLength(1);

    // 文本增长 'L1 L2'：不是在途键的前缀 → 照发新请求
    h.setCaption('L1 L2');
    await sleep(30);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1].type === 'TRANSLATE_BATCH' && h.requests[1].segments[0]?.text).toBe(
      'L1 L2',
    );
  });

  it('并发上限 4：第 5 条淘汰最旧在途标记；被淘汰文本复现可重新请求', async () => {
    const h = harness("<div id='player'></div>");
    h.sub.start();
    for (const t of ['一', '二', '三', '四', '五']) {
      h.setCaption(t);
      await sleep(30);
    }
    expect(h.requests).toHaveLength(5); // 五条新文本五条请求（不再折叠）

    // 『一』已被淘汰（只摘跟踪标记）：复现时不再被在途抑制 → 重新请求
    h.setCaption('一');
    await sleep(30);
    expect(h.requests).toHaveLength(6);
    expect(h.requests[5].type === 'TRANSLATE_BATCH' && h.requests[5].segments[0]?.text).toBe('一');
  });

  it('doneTexts 会话缓存：已翻文本复现 → 不再发请求、直接 show', async () => {
    const h = harness("<div id='player'></div>");
    h.sub.start();
    h.setCaption('甲');
    await sleep(30);
    h.reply('甲');
    await sleep(10);
    h.setCaption('乙');
    await sleep(30);
    h.reply('乙');
    await sleep(10);
    expect(h.requests).toHaveLength(2);

    h.setCaption('甲'); // 回看上文 → 命中缓存秒上屏
    await sleep(30);
    expect(h.requests).toHaveLength(2);
    const line = h.player.querySelector('.itr-caption-line');
    expect(line?.getAttribute('data-itr-hidden')).toBeNull();
    expect(line?.querySelector('.itr-caption-dst')?.textContent).toBe('译：甲');
  });

  it('doneTexts LRU：超限淘汰最旧（doneLimit 注入 3 验证淘汰行为）', async () => {
    const h = harness("<div id='player'></div>", () => 'en', 3);
    h.sub.start();
    const labels = ['其一', '其二', '其三', '其四'];
    for (const t of labels) {
      h.setCaption(t);
      await sleep(30);
      h.reply(t);
      await sleep(10);
    }
    expect(h.requests).toHaveLength(4);

    h.setCaption('其三'); // 再次命中（未淘汰）
    await sleep(30);
    expect(h.requests).toHaveLength(4);

    h.setCaption('其一'); // 最旧已被淘汰 → 需要重新请求
    await sleep(30);
    expect(h.requests).toHaveLength(5);
    expect(h.requests[4].type === 'TRANSLATE_BATCH' && h.requests[4].segments[0]?.text).toBe('其一');
  });

  it('stop 后重新启动：状态全清（doneTexts 不残留）、此前在途响应作废', async () => {
    const h = harness("<div id='player'></div>");
    h.sub.start();
    h.setCaption('S 一');
    await sleep(30);
    expect(h.requests).toHaveLength(1);

    // stop：响应尚未回来 → 状态清空；回包在 stop 后到达，不得落地任何状态
    h.sub.stop();
    h.reply('S 一');
    await sleep(10);
    expect(h.player.querySelector('.itr-caption-line')).toBeNull();

    // 重启：doneTexts 已清 → 同一段字幕要重新请求（若状态残留则 0 请求）
    h.sub.start();
    await sleep(40);
    expect(h.requests).toHaveLength(2);
    h.reply('S 一');
    await sleep(10);
    const line = h.player.querySelector('.itr-caption-line');
    expect(line?.getAttribute('data-itr-hidden')).toBeNull();
    expect(line?.querySelector('.itr-caption-dst')?.textContent).toBe('译：S 一');
  });

  it('同文本去重：内容不变不重复请求', async () => {
    const h = harness();
    h.sub.start();
    await sleep(40);
    h.reply('一');
    await sleep(30); // 等待新的采样（文本未变）
    expect(h.requests).toHaveLength(1);
  });

  it('字幕消失 → 覆盖层隐藏；重现 → 新文本重新翻译', async () => {
    const h = harness();
    h.sub.start();
    await sleep(40);
    h.reply('一');
    await sleep(10);
    expect(h.player.querySelector('.itr-caption-line')?.getAttribute('data-itr-hidden')).toBeNull();

    h.setCaption(null);
    await sleep(30);
    expect(h.player.querySelector('.itr-caption-line')?.getAttribute('data-itr-hidden')).toBe(
      'true',
    );

    h.setCaption('新的字幕文本');
    await sleep(40);
    expect(h.requests).toHaveLength(2);
    h.reply('二');
    await sleep(10);
    const line = h.player.querySelector('.itr-caption-line');
    expect(line?.getAttribute('data-itr-hidden')).toBeNull();
    expect(line?.querySelector('.itr-caption-dst')?.textContent).toBe('译：二');
  });

  it('stop：覆盖层移除、观察断开', async () => {
    const h = harness();
    h.sub.start();
    await sleep(40);
    h.reply('一');
    await sleep(10);
    h.sub.stop();
    await sleep(10);
    expect(h.player.querySelector('.itr-caption-line')).toBeNull();
    expect(h.sub.active).toBe(false);
  });

  it('T-020 overlay 活性：SPA 重建播放器后 detached 引用不再吞文本，新根内重建', async () => {
    const h = harness();
    h.sub.start();
    await sleep(40);
    expect(h.requests).toHaveLength(1);
    h.reply('第一段');
    await sleep(10);
    const oldLine = h.player.querySelector('.itr-caption-line');
    expect(oldLine?.querySelector('.itr-caption-dst')?.textContent).toBe('译：第一段');

    // 模拟 YouTube SPA 导航：整个播放器子树被重建（旧 #player 连子树一起移除）
    const fresh = h.doc.createElement('div');
    fresh.id = 'player';
    h.doc.body.append(fresh);
    h.player.remove();

    // 新字幕出现在新播放器内（detached 旧根上挂字幕不会触发观察者）
    const seg = h.doc.createElement('div');
    seg.className = 'cap';
    seg.textContent = '第二段新字幕';
    fresh.append(seg);
    await sleep(40);
    expect(h.requests).toHaveLength(2);
    h.reply('第二段');
    await sleep(10);
    // 覆盖层必须出现在新根里（旧根已移除，若仍写 detached 节点则 fresh 内无内容）
    const line = fresh.querySelector('.itr-caption-line');
    expect(line).not.toBeNull();
    expect(line?.querySelector('.itr-caption-dst')?.textContent).toBe('译：第二段');
    expect(line?.getAttribute('data-itr-hidden')).toBeNull();
  });

  it('T-018 目标语言命中：中文字幕（zh 目标）跳过请求、隐藏译文行且不反复触发', async () => {
    const h = harness(undefined, () => 'zh-CN'); // fixture 字幕『初始字幕文本』本身是中文
    h.sub.start();
    await sleep(60);
    expect(h.requests).toHaveLength(0); // 不发请求
    // 译文行：本例从未显示过 → 元素不存在；若从上一条外文留下来 → 必须隐藏
    const line = h.player.querySelector('.itr-caption-line');
    expect(line?.getAttribute('data-itr-hidden') ?? '(absent)').toBe('(absent)');
    await sleep(60); // 在屏重复采样同样零请求
    expect(h.requests).toHaveLength(0);
  });
});

describe('SubtitleTranslator · 仅双语（T-025 / M3-2）', () => {
  const native = (h: Harness): HTMLElement =>
    h.doc.querySelector('.ytp-caption-window-container') as HTMLElement;

  it('双语条上屏 → 原生容器加 hidden class；src/dst 双行同框配对', async () => {
    const h = harness();
    h.sub.start();
    await sleep(40);
    h.reply('一');
    await sleep(10);
    expect(native(h).classList.contains('itr-caption-native-hidden')).toBe(true);
    const root = h.player.querySelector('.itr-caption-line') as HTMLElement;
    expect(root.querySelector('.itr-caption-src')?.textContent).toBe('初始字幕文本');
    expect(root.querySelector('.itr-caption-dst')?.textContent).toBe('译：一');
    // 原字幕内容零写入（红线改约边界：只动容器 classList）
    expect(h.doc.querySelector('.cap')?.textContent).toBe('初始字幕文本');
  });

  it('字幕消失 → 撤销原生隐藏（原生回归兜底）', async () => {
    const h = harness();
    h.sub.start();
    await sleep(40);
    h.reply('一');
    await sleep(10);
    expect(native(h).classList.contains('itr-caption-native-hidden')).toBe(true);

    h.setCaption(null);
    await sleep(30);
    expect(native(h).classList.contains('itr-caption-native-hidden')).toBe(false);
    expect(h.player.querySelector('.itr-caption-line')?.getAttribute('data-itr-hidden')).toBe('true');
  });

  it('目标语言字幕 → 撤销隐藏且零请求（原生直显）', async () => {
    const h = harness(undefined, () => 'zh-CN');
    h.sub.start();
    h.setCaption('hello world'); // 外文 → 接管
    await sleep(40);
    expect(h.requests).toHaveLength(1);
    h.reply('hello world');
    await sleep(10);
    expect(native(h).classList.contains('itr-caption-native-hidden')).toBe(true);

    h.setCaption('初始字幕文本'); // 中文（zh 目标）命中 Skip
    await sleep(30);
    expect(native(h).classList.contains('itr-caption-native-hidden')).toBe(false);
    expect(h.player.querySelector('.itr-caption-line')?.getAttribute('data-itr-hidden')).toBe('true');
    expect(h.requests).toHaveLength(1); // 不发请求
  });

  it('TTL 收敛 → 双语条隐藏且原生回归；dst 内容不删', async () => {
    const h = harness(undefined, () => 'en', undefined, 250);
    h.sub.start();
    await sleep(40);
    h.reply('甲');
    await sleep(10);
    const nativeEl = native(h);
    expect(nativeEl.classList.contains('itr-caption-native-hidden')).toBe(true);

    h.setCaption('乙'); // 无响应 → 超过 TTL 收敛
    await sleep(30);
    await sleep(260);
    expect(h.player.querySelector('.itr-caption-line')?.getAttribute('data-itr-hidden')).toBe('true');
    expect(nativeEl.classList.contains('itr-caption-native-hidden')).toBe(false);
    expect(h.player.querySelector('.itr-caption-dst')?.textContent).toBe('译：甲');
  });

  it('stop → 撤销原生隐藏（与覆盖层生命周期对称）', async () => {
    const h = harness();
    h.sub.start();
    await sleep(40);
    h.reply('一');
    await sleep(10);
    expect(native(h).classList.contains('itr-caption-native-hidden')).toBe(true);

    h.sub.stop();
    await sleep(10);
    expect(native(h).classList.contains('itr-caption-native-hidden')).toBe(false);
    expect(h.player.querySelector('.itr-caption-line')).toBeNull();
  });

  it('原生容器查询落空 → 安全退化：双语条照常、不 crash、不隐藏', async () => {
    const h = harness("<div id='player'></div>");
    h.sub.start();
    h.setCaption('甲');
    await sleep(30);
    h.reply('甲');
    await sleep(10);
    expect(h.doc.querySelector('.ytp-caption-window-container')).toBeNull();
    const root = h.player.querySelector('.itr-caption-line') as HTMLElement;
    expect(root.getAttribute('data-itr-hidden')).toBeNull();
    expect(root.querySelector('.itr-caption-dst')?.textContent).toBe('译：甲');
  });
});

describe('SubtitleTranslator · UI 可调（T-024 / M3-1）', () => {
  const style = (o: Partial<UiStyle>): UiStyle => ({ ...defaultUiStyle(), ...o });

  it('applyUiStyle 先于显示：overlay 首次出现即带新字号与离底变量', async () => {
    const h = harness();
    h.sub.applyUiStyle(style({ subtitleFontSize: 26, subtitleBottom: 120 }));
    h.sub.start();
    await sleep(40);
    h.reply('对白一');
    await sleep(10);
    const line = h.player.querySelector('.itr-caption-line') as HTMLElement | null;
    expect(line?.style.getPropertyValue('--itr-caption-font-size')).toBe('26px');
    expect(line?.style.getPropertyValue('--itr-caption-bottom')).toBe('120px');
  });

  it('applyUiStyle 在 overlay 已显示时实时更新变量（SETTINGS_CHANGED 即改即得）', async () => {
    const h = harness();
    h.sub.start();
    await sleep(40);
    h.reply('对白一');
    await sleep(10);
    const line = h.player.querySelector('.itr-caption-line') as HTMLElement | null;
    expect(line?.style.getPropertyValue('--itr-caption-font-size')).toBe('');
    h.sub.applyUiStyle(style({ subtitleFontSize: 34 }));
    expect(line?.style.getPropertyValue('--itr-caption-font-size')).toBe('34px');
    expect(line?.style.getPropertyValue('--itr-caption-bottom')).toBe('84px');
  });
});

describe('SubtitleTranslator · transcript 导出记录（T-026 / M3-3）', () => {
  it('配对换行即按序追加；在途未响应不记；同值连对不重记；stop 不清空；snapshot 为拷贝', async () => {
    const h = harness();
    h.sub.start();
    await sleep(40);
    h.reply('甲'); // 第一 pair：初始字幕文本 → 译：甲
    await sleep(10);
    expect(h.sub.transcriptSnapshot().map((p) => p.dst)).toEqual(['译：甲']);

    h.setCaption('乙');
    await sleep(30);
    expect(h.sub.transcriptSnapshot()).toHaveLength(1); // 在途未响应 → 不记
    h.reply('乙');
    await sleep(10);
    const snap = h.sub.transcriptSnapshot();
    expect(snap).toEqual([
      { src: '初始字幕文本', dst: '译：甲' },
      { src: '乙', dst: '译：乙' },
    ]);

    h.setCaption('乙'); // 同值再采样 → 配对去重不重 show → 记录不变
    await sleep(30);
    expect(h.sub.transcriptSnapshot()).toHaveLength(2);

    snap.length = 0; // 外层改动不泄漏内部（拷贝语义）
    expect(h.sub.transcriptSnapshot()).toHaveLength(2);

    h.sub.stop();
    await sleep(10);
    expect(h.sub.transcriptSnapshot()).toHaveLength(2); // stop 不清空（停止后可导出）
  });

  it('SPA 重建（overlay detached）→ 记录清空重开篇', async () => {
    const h = harness();
    h.sub.start();
    await sleep(40);
    h.reply('第一段');
    await sleep(10);
    expect(h.sub.transcriptSnapshot()).toHaveLength(1);

    // 模拟 YouTube SPA 导航：整个播放器子树被重建
    const fresh = h.doc.createElement('div');
    fresh.id = 'player';
    h.doc.body.append(fresh);
    h.player.remove();
    const seg = h.doc.createElement('div');
    seg.className = 'cap';
    seg.textContent = '第二段新字幕';
    fresh.append(seg);
    await sleep(40);
    h.reply('第二段');
    await sleep(10);

    const snap = h.sub.transcriptSnapshot();
    expect(snap).toEqual([{ src: '第二段新字幕', dst: '译：第二段' }]); // 旧视频记录已清空
  });
});

describe('SubtitleTranslator · 关键帧热区按钮（T-027 / M3-4）', () => {
  interface CapHarness {
    doc: Document;
    sub: SubtitleTranslator;
    player: HTMLElement;
    video: HTMLVideoElement;
    requests: RpcRequest[];
    /** 按请求序 resolve（translit 经 main harness 形状；capture 由本测试直给响应） */
    respondCapture(res: RpcResponse): void;
  }

  function capHarness(harnessHtml?: string, flashMs = 5): CapHarness {
    const dom = new JSDOM(
      `<!doctype html><html><head></head><body>${
        harnessHtml ??
        "<div id='player'><div class='ytp-caption-window-container'><div class='capwin'><div class='cap'>初始字幕文本</div></div></div><video id='v'></video></div>"
      }</body></html>`,
      { url: 'https://www.youtube.com/watch?v=x' },
    );
    const doc = dom.window.document;
    const requests: RpcRequest[] = [];
    const captureResponders: Array<(res: RpcResponse) => void> = [];
    const request = (msg: RpcRequest): Promise<RpcResponse> => {
      requests.push(msg);
      if (msg.type === 'CAPTURE_KEYFRAME') {
        return new Promise<RpcResponse>((resolve) => {
          captureResponders.push(resolve);
        });
      }
      return Promise.resolve({ type: 'TRANSLATION', items: [{ id: '', text: '译：请求译文' }] });
    };
    const video = doc.querySelector('#v') as HTMLVideoElement;
    Object.defineProperty(video, 'currentTime', { value: 12.5, configurable: true });
    return {
      doc,
      video,
      player: doc.querySelector('#player') as HTMLElement,
      requests,
      respondCapture(res: RpcResponse): void {
        const r = captureResponders.shift();
        if (!r) throw new Error('no pending capture request');
        r(res);
      },
      sub: new SubtitleTranslator({
        doc,
        request,
        getTargetLang: () => 'en',
        debounceMs: 10,
        flashMs,
        segmentSel: '.cap',
        rootSel: '#player',
      }),
    };
  }

  async function bringUp(h: CapHarness): Promise<void> {
    h.sub.start();
    await sleep(40);
  }

  function shotBtn(doc: Document): HTMLButtonElement {
    const btn = doc.querySelector('.itr-caption-shot') as HTMLButtonElement | null;
    if (!btn) throw new Error('shot button missing');
    return btn;
  }

  function clickEl(doc: Document, el: HTMLElement): void {
    const win = doc.defaultView as unknown as { Event: typeof Event } | null;
    if (!win) throw new Error('no window');
    el.dispatchEvent(new win.Event('click', { bubbles: true }));
  }

  it('overlay 建立时带一个截帧按钮（pointer-events:auto、无重复）；stop 后随 overlay 移除', async () => {
    const h = capHarness();
    await bringUp(h);
    const btn = shotBtn(h.doc);
    expect(btn.textContent).toBe('截帧');
    expect(btn.style.getPropertyValue('pointer-events')).toBe('auto');
    // 二次上屏（换行再 show）不重复建钮（幂等）
    const cap = h.doc.querySelector('.cap');
    if (!cap) throw new Error('caption missing');
    cap.textContent = '第二句字幕';
    await sleep(40);
    expect(h.doc.querySelectorAll('.itr-caption-shot')).toHaveLength(1);
    h.sub.stop();
    await sleep(10);
    expect(h.doc.querySelector('.itr-caption-shot')).toBe(null);
  });

  it('点击 → 直投 Rpc CAPTURE_KEYFRAME（videoId / currentTime / 当前上屏对）；UI 零像素', async () => {
    const h = capHarness();
    await bringUp(h);
    await sleep(30);
    clickEl(h.doc, shotBtn(h.doc));
    await sleep(10);
    const req = h.requests.find((m) => m.type === 'CAPTURE_KEYFRAME');
    expect(req).toEqual({
      type: 'CAPTURE_KEYFRAME',
      videoId: 'x', // harness url v=x
      videoTime: 12.5,
      src: '初始字幕文本',
      dst: '译：请求译文',
    });
  });

  it('无 video 元素 → videoTime null；context 与回包同字段', async () => {
    const h = capHarness();
    await bringUp(h);
    h.video.remove();
    await sleep(30);
    clickEl(h.doc, shotBtn(h.doc));
    await sleep(10);
    const req = h.requests.find((m) => m.type === 'CAPTURE_KEYFRAME') as {
      videoTime: number | null;
    };
    expect(req.videoTime).toBe(null);
  });

  it('成功回包 → 按钮闪 ✓ 已存 → flashMs 后复原', async () => {
    const h = capHarness(undefined, 5);
    await bringUp(h);
    await sleep(30);
    clickEl(h.doc, shotBtn(h.doc));
    await sleep(10);
    h.respondCapture({ type: 'KEYFRAME_SAVED', id: 'kf-1', videoTime: 12.5 });
    await sleep(1); // 闪启瞬间（flashMs=5 边界内）
    const btn = shotBtn(h.doc);
    expect(btn.textContent).toBe('✓ 已存');
    expect(btn.classList.contains('itr-caption-shot-ok')).toBe(true);
    await sleep(20); // flashMs=5 → 已复原
    expect(btn.textContent).toBe('截帧');
    expect(btn.classList.contains('itr-caption-shot-ok')).toBe(false);
  });

  it('E_NO_GESTURE（页内点击非手势，probe ⑤）→ 一次性提示条引导 popup/热键', async () => {
    const h = capHarness();
    await bringUp(h);
    await sleep(30);
    clickEl(h.doc, shotBtn(h.doc));
    await sleep(10);
    h.respondCapture({ type: 'KEYFRAME_SAVED', error: { code: 'E_NO_GESTURE' } });
    await sleep(5);
    const tip = h.doc.getElementById('itr-tip');
    expect(tip?.textContent ?? '').toContain('扩展手势');
  });

  it('未配置 flash 且 stop 后 pending 响应不炸（在途捕获回包安全丢弃）', async () => {
    const h = capHarness();
    await bringUp(h);
    await sleep(30);
    clickEl(h.doc, shotBtn(h.doc));
    await sleep(10);
    h.sub.stop();
    await sleep(10);
    expect(() => h.respondCapture({ type: 'KEYFRAME_SAVED', id: 'kf-2', videoTime: null })).not.toThrow();
  });
});
