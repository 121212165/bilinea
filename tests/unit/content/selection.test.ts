// T-009 划词气泡单测（契约 contracts/selection.md §4 锚点）。
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { SelectionBubble } from '../../../src/content/selection';
import { errorTipText } from '../../../src/content/tipbar';
import type { RpcRequest, RpcResponse } from '../../../src/shared/messaging';
import { defaultUiStyle, type UiStyle } from '../../../src/shared/ui-style';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  doc: Document;
  win: Window;
  para: HTMLElement;
  para2: HTMLElement;
  bubble: SelectionBubble;
  requests: RpcRequest[];
  reply(translationBase: string | null): void;
  select(el: HTMLElement): void;
  collapse(): void;
  mouseUp(x?: number): void;
  mouseDown(x?: number): void;
  esc(): void;
  altX(): void;
  /** 在 chip 自身派发 mousedown（模拟真浏览器点 chip 的按下动作） */
  mouseDownOnChip(): void;
  /** 存在性断言用 primitive 计数：失败时 chai 只序列化数字。
   * 直接 expect(element).toBeNull() 在失败路径会深度遍历 jsdom 元素
   * 的 Symbol(SameObject caches)（无 constructor）→ TypeError: reading 'name'。 */
  chipCount(): number;
  bubbleCount(): number;
  chipEl(): HTMLElement | null;
}

function harness(enableNow = true): Harness {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>
       <p id="para">the quick brown fox falls down the hill</p>
       <p id="para2">a second paragraph about patient owls</p>
       <span id="blank">   </span>
       <p id="editable" contenteditable="true">inside editable text</p>
     </body></html>`,
    { url: 'https://example.com/page' },
  );
  const doc = dom.window.document;
  const win = dom.window;
  /** jsdom DOMWindow 类型未暴露事件构造器（运行时存在），按 lib.dom 类型 cast */
  const EventCtor = win as unknown as {
    MouseEvent: typeof MouseEvent;
    KeyboardEvent: typeof KeyboardEvent;
  };
  const requests: RpcRequest[] = [];
  const queue: Array<(base: string | null) => void> = [];
  const request = (msg: RpcRequest): Promise<RpcResponse> => {
    requests.push(msg);
    return new Promise<RpcResponse>((resolve) => {
      queue.push((base) => {
        const seg = msg.type === 'TRANSLATE_BATCH' ? msg.segments[0] : undefined;
        if (base === null) {
          resolve({ type: 'TRANSLATION', items: [{ id: seg?.id ?? '', text: '' }],
            error: { code: 'E_RATE_LIMITED' } });
        } else {
          resolve({ type: 'TRANSLATION', items: [{ id: seg?.id ?? '', text: `译：${base}` }] });
        }
      });
    });
  };
  const bubble = new SelectionBubble({ doc, request, getTargetLang: () => 'en' });
  const h: Harness = {
    doc,
    win,
    para: doc.querySelector('#para') as HTMLElement,
    para2: doc.querySelector('#para2') as HTMLElement,
    bubble,
    requests,
    reply(translationBase: string | null): void {
      const resolve = queue.shift();
      if (!resolve) throw new Error('no pending request');
      resolve(translationBase);
    },
    select(el: HTMLElement): void {
      const range = doc.createRange();
      range.selectNodeContents(el);
      const sel = doc.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    collapse(): void {
      doc.getSelection()?.removeAllRanges();
    },
    mouseUp(x?: number): void {
      doc.body.dispatchEvent(
        new EventCtor.MouseEvent('mouseup', { bubbles: true, clientX: x ?? 100, clientY: 100 }),
      );
    },
    mouseDown(x?: number): void {
      doc.body.dispatchEvent(
        new EventCtor.MouseEvent('mousedown', { bubbles: true, clientX: x ?? 100, clientY: 100 }),
      );
    },
    esc(): void {
      win.dispatchEvent(new EventCtor.KeyboardEvent('keydown', { key: 'Escape' }));
    },
    altX(): void {
      win.dispatchEvent(new EventCtor.KeyboardEvent('keydown', { key: 'x', altKey: true }));
    },
    mouseDownOnChip(): void {
      const chip = doc.querySelector('.itr-sel-chip') as HTMLElement | null;
      chip?.dispatchEvent(new EventCtor.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    },
    chipCount(): number {
      return doc.querySelectorAll('.itr-sel-chip').length;
    },
    bubbleCount(): number {
      return doc.querySelectorAll('.itr-sel-bubble').length;
    },
    chipEl(): HTMLElement | null {
      return doc.querySelector('.itr-sel-chip') as HTMLElement | null;
    },
  };
  if (enableNow) bubble.enable();
  return h;
}

describe('SelectionBubble（契约 selection.md v1）', () => {
  it('未 enable：选区 + mouseup 零 UI 零请求；enable 后同流程出 chip', () => {
    const h = harness(false);
    h.select(h.para);
    h.mouseUp();
    expect(h.chipCount()).toBe(0);
    h.bubble.enable();
    h.select(h.para);
    h.mouseUp();
    expect(h.chipCount()).toBe(1);
  });

  it('点击 chip → TRANSLATE_BATCH（文本/自动源/en）→ loading → 译文上屏；enable 幂等不重复请求', async () => {
    const h = harness();
    h.bubble.enable(); // 冗余 enable，验证幂等
    h.select(h.para);
    h.mouseUp();
    const chip = h.doc.querySelector('.itr-sel-chip') as HTMLElement;
    chip.click();
    await sleep(0);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].type === 'TRANSLATE_BATCH' && h.requests[0].segments[0]?.text).toBe(
      'the quick brown fox falls down the hill',
    );
    expect(h.requests[0].type !== 'TRANSLATE_BATCH' ? false : h.requests[0].source).toBe('auto');
    expect(h.requests[0].type !== 'TRANSLATE_BATCH' ? false : h.requests[0].target).toBe('en');
    expect(
      String(h.requests[0].type === 'TRANSLATE_BATCH' ? h.requests[0].requestId : 'none'),
    ).toMatch(/^sel-req-/);
    expect(h.doc.querySelector('.itr-sel-bubble')?.textContent).toBe('翻译中…');
    h.reply('keeper');
    await sleep(0);
    expect(h.doc.querySelector('.itr-sel-bubble')?.textContent).toBe('译：keeper');
  });

  it('Alt+X 热键路径：有选区直接翻译，无需 chip 点击', async () => {
    const h = harness();
    h.select(h.para2);
    h.altX();
    await sleep(0);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].type === 'TRANSLATE_BATCH' && h.requests[0].segments[0]?.text).toBe(
      'a second paragraph about patient owls',
    );
  });

  it('T-009a：chip mousedown preventDefault（真浏览器清选区的兜底）；选区被外部清掉后点击 chip 仍用快照翻译', async () => {
    const h = harness();
    h.select(h.para);
    h.mouseUp();
    // 真浏览器点 chip 的 mousedown：不清选区（preventDefault），chip 不消失
    h.mouseDownOnChip();
    expect(h.chipCount()).toBe(1);
    expect(h.bubbleCount()).toBe(0);

    // 极端兜底：选区已被外部完全清掉（isCollapsed）→ 点击 chip 用挂载时快照
    h.collapse();
    (h.chipEl() as HTMLElement).click();
    await sleep(0);
    expect(h.requests).toHaveLength(1);
    expect(
      h.requests[0].type === 'TRANSLATE_BATCH' && h.requests[0].segments[0]?.text,
    ).toBe('the quick brown fox falls down the hill');
  });

  it('三消失路径：ESC / 外部 mousedown / 选区折叠', () => {
    // 注：ESC 与外部 mousedown 都不清选区，此后再次 mouseup（选区仍在）
    // chip 复活是契约内行为；各路径独立验证「消失」本身。
    const h = harness();
    // 路径 1：ESC
    h.select(h.para);
    h.mouseUp();
    expect(h.chipCount()).toBe(1);
    h.esc();
    expect(h.chipCount()).toBe(0);

    // 路径 2：chip / bubble 外的 document mousedown
    h.select(h.para2);
    h.mouseUp();
    expect(h.chipCount()).toBe(1);
    h.mouseDown();
    expect(h.chipCount()).toBe(0);

    // 路径 3：选区折叠后 mouseup
    h.select(h.para);
    h.mouseUp();
    expect(h.chipCount()).toBe(1);
    h.collapse();
    h.mouseUp();
    expect(h.chipCount()).toBe(0);
  });

  it('陈旧响应忽略：A 在途发起 B，A 迟到不渲染；B 恰逢在途渲染', async () => {
    const h = harness();
    h.select(h.para);
    h.mouseUp();
    (h.doc.querySelector('.itr-sel-chip') as HTMLElement).click();
    await sleep(0);

    h.select(h.para2);
    h.mouseUp();
    (h.doc.querySelector('.itr-sel-chip') as HTMLElement).click();
    await sleep(0);
    expect(h.requests).toHaveLength(2);

    h.reply('stale-a'); // A 迟到 → 忽略
    await sleep(0);
    expect(h.doc.querySelector('.itr-sel-bubble')?.textContent).toBe('翻译中…');
    h.reply('fresh-b');
    await sleep(0);
    expect(h.doc.querySelector('.itr-sel-bubble')?.textContent).toBe('译：fresh-b');
  });

  it('错误码渲染 + 新一轮翻译清旧 bubble 内容', async () => {
    const h = harness();
    h.select(h.para);
    h.mouseUp();
    (h.doc.querySelector('.itr-sel-chip') as HTMLElement).click();
    await sleep(0);
    h.reply(null); // 错误包
    await sleep(0);
    const boxErr = h.doc.querySelector('.itr-sel-bubble') as HTMLElement;
    expect(boxErr.getAttribute('data-itr-sel-error')).toBe('1');
    // 渲染走 errorTipText 语义（契约 §2.4）：抖出原始码，改为比对语义转换后的文案
    expect(boxErr.textContent).toBe(errorTipText('E_RATE_LIMITED'));

    h.select(h.para2);
    h.mouseUp();
    (h.doc.querySelector('.itr-sel-chip') as HTMLElement).click();
    await sleep(0);
    const box = h.doc.querySelector('.itr-sel-bubble') as HTMLElement;
    expect(box.getAttribute('data-itr-sel-error')).toBeNull(); // 旧错误态清掉
    expect(box.textContent).toBe('翻译中…');
  });

  it('disable：UI 清空、迟到响应不落地；再 enable 后停在 chip 等待', async () => {
    const h = harness();
    h.select(h.para);
    h.mouseUp();
    (h.doc.querySelector('.itr-sel-chip') as HTMLElement).click();
    await sleep(0);
    h.bubble.disable();
    expect(h.chipCount()).toBe(0);
    expect(h.bubbleCount()).toBe(0);
    h.reply('late');
    await sleep(0);
    expect(h.bubbleCount()).toBe(0); // 作废

    h.bubble.enable();
    h.select(h.para2);
    h.mouseUp();
    expect(h.chipCount()).toBe(1);
  });

  it('边界：空选区（全文空白）/ editable 内选区不挂 chip', () => {
    const h = harness();
    h.select(h.doc.querySelector('#blank') as HTMLElement);
    h.mouseUp();
    expect(h.chipCount()).toBe(0);

    h.select(h.doc.querySelector('#editable') as HTMLElement);
    h.mouseUp();
    expect(h.chipCount()).toBe(0);
  });
});

describe('SelectionBubble · UI 可调（T-024 / M3-1）', () => {
  const style = (o: Partial<UiStyle>): UiStyle => ({ ...defaultUiStyle(), ...o });

  it('floatOffset 注入后 chip 与 bubble 的锚点偏移随之变化', async () => {
    const h = harness();
    h.bubble.applyUiStyle(style({ floatOffset: 30 }));
    h.select(h.para);
    h.mouseUp(100);
    const chip = h.doc.querySelector('.itr-sel-chip') as HTMLElement;
    expect(chip.style.left).toBe('130px'); // clientX 100 + offset 30（jsdom rect 为 0，无内收）
    chip.click();
    await sleep(0);
    const bubble = h.doc.querySelector('.itr-sel-bubble') as HTMLElement;
    expect(bubble.style.left).toBe('130px'); // bubble 复用 chip 锚点
  });

  it('bubbleFontSize 注入后 bubble 内联变量生效；未注入时无变量（CSS 默认兜底）', async () => {
    const h = harness();
    h.select(h.para);
    h.mouseUp();
    (h.doc.querySelector('.itr-sel-chip') as HTMLElement).click();
    await sleep(0);
    const bubble = h.doc.querySelector('.itr-sel-bubble') as HTMLElement;
    expect(bubble.style.getPropertyValue('--itr-sel-bubble-font-size')).toBe('');
    h.bubble.applyUiStyle(style({ bubbleFontSize: 20 }));
    expect(bubble.style.getPropertyValue('--itr-sel-bubble-font-size')).toBe('20px');
  });
});
