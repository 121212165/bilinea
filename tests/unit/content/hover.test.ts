// T-010 悬停单段翻译单测（契约 contracts/hover.md §4 锚点）。
// 存在性断言用 primitive 计数（lessons：失败断言比较 jsdom 元素会炸出无栈 TypeError）。
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { HoverCard } from '../../../src/content/hover';
import { ITR_CSS } from '../../../src/content/styles';
import { errorTipText } from '../../../src/content/tipbar';
import type { RpcRequest, RpcResponse } from '../../../src/shared/messaging';
import { defaultUiStyle } from '../../../src/shared/ui-style';

const sleep = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  para: HTMLElement;
  para2: HTMLElement;
  editable: HTMLElement;
  codeWrap: HTMLElement;
  hover: HoverCard;
  requests: RpcRequest[];
  reply(translationBase: string | null): void;
  altDown(): void;
  altUp(): void;
  blur(): void;
  esc(): void;
  scroll(): void;
  /** 在 el 上派发 mousemove（target = el，bubbles 到 document capture） */
  move(el: HTMLElement): void;
  cardCount(): number;
  cardText(): string;
  cardEl(): HTMLElement | null;
  /** 跑完防抖定时器 */
  flush(): Promise<void>;
}

function harness(enableNow = true): Harness {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>
       <p id="para">hover paragraph one about patient owls</p>
       <p id="para2">paragraph two about the sly fox</p>
       <span id="tweet" data-testid="tweetText">a leaf span like a tweet text</span>
       <pre id="code">let x = 1 in code block</pre>
       <p id="editable" contenteditable="true">inside editable text</p>
     </body></html>`,
    { url: 'https://example.com/h' },
  );
  const doc = dom.window.document;
  const win = dom.window;
  const EventCtor = win as unknown as {
    MouseEvent: typeof MouseEvent;
    KeyboardEvent: typeof KeyboardEvent;
    Event: typeof Event;
  };
  const hoverEl = (): HTMLElement | null => doc.querySelector('.itr-hover-card');
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
  const hover = new HoverCard({ doc, request, getTargetLang: () => 'en', debounceMs: 0 });
  const h: Harness = {
    para: doc.querySelector('#para') as HTMLElement,
    para2: doc.querySelector('#para2') as HTMLElement,
    editable: doc.querySelector('#editable') as HTMLElement,
    codeWrap: doc.querySelector('#code') as HTMLElement,
    hover,
    requests,
    reply(translationBase: string | null): void {
      const resolve = queue.shift();
      if (!resolve) throw new Error('no pending request');
      resolve(translationBase);
    },
    altDown(): void {
      doc.dispatchEvent(new EventCtor.KeyboardEvent('keydown', { key: 'Alt', bubbles: true }));
    },
    altUp(): void {
      doc.dispatchEvent(new EventCtor.KeyboardEvent('keyup', { key: 'Alt', bubbles: true }));
    },
    blur(): void {
      win.dispatchEvent(new EventCtor.Event('blur'));
    },
    esc(): void {
      doc.dispatchEvent(new EventCtor.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    },
    scroll(): void {
      doc.dispatchEvent(new EventCtor.Event('scroll'));
    },
    move(el: HTMLElement): void {
      el.dispatchEvent(new EventCtor.MouseEvent('mousemove', { bubbles: true }));
    },
    cardCount(): number {
      return doc.querySelectorAll('.itr-hover-card').length;
    },
    cardText(): string {
      return hoverEl()?.textContent ?? '';
    },
    cardEl(): HTMLElement | null {
      return hoverEl();
    },
    async flush(): Promise<void> {
      await sleep(5);
    },
  };
  if (enableNow) hover.enable();
  return h;
}

describe('HoverCard（契约 hover.md v1）', () => {
  it('未 enable：Alt 按住 hover 零 UI 零请求；enable 后同流程出卡', async () => {
    const h = harness(false);
    h.altDown();
    h.move(h.para);
    await h.flush();
    expect(h.cardCount()).toBe(0);
    h.hover.enable();
    h.altDown();
    h.move(h.para);
    await h.flush();
    expect(h.cardCount()).toBe(1);
  });

  it('enable 幂等：重复 enable 不重复请求', async () => {
    const h = harness();
    h.hover.enable();
    h.altDown();
    h.move(h.para);
    await h.flush();
    expect(h.requests).toHaveLength(1);
  });

  it('Alt 按下 + hover 段落 → TRANSLATE_BATCH（正确文本/auto/en）→ loading → 原文行+译文行', async () => {
    const h = harness();
    h.altDown();
    h.move(h.para);
    await h.flush();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].type === 'TRANSLATE_BATCH' && h.requests[0].segments[0]?.text).toBe(
      'hover paragraph one about patient owls',
    );
    expect(h.requests[0].type !== 'TRANSLATE_BATCH' ? false : h.requests[0].source).toBe('auto');
    expect(h.requests[0].type !== 'TRANSLATE_BATCH' ? false : h.requests[0].target).toBe('en');
    expect(
      String(h.requests[0].type === 'TRANSLATE_BATCH' ? h.requests[0].requestId : 'none'),
    ).toMatch(/^hover-req-/);
    expect(h.cardCount()).toBe(1);
    expect(h.cardText()).toContain('翻译中…');
    h.reply('owl');
    await sleep(0);
    expect(h.cardText()).toBe('hover paragraph one about patient owls译：owl');
  });

  it('同段落防抖合并：300ms 窗口内多次 mousemove 单请求', async () => {
    const h = harness();
    h.altDown();
    h.move(h.para);
    h.move(h.para);
    h.move(h.para);
    await h.flush();
    expect(h.requests).toHaveLength(1);
  });

  it('换目标：旧在途作废，A 迟到响应不渲染，B 正常落地', async () => {
    const h = harness();
    h.altDown();
    h.move(h.para);
    await h.flush();
    h.move(h.para2); // 换段落 → 立即作废 A
    await h.flush();
    expect(h.requests).toHaveLength(2);
    h.reply('stale-a');
    await sleep(0);
    expect(h.cardText()).not.toContain('stale-a');
    expect(h.cardText()).toContain('翻译中…');
    h.reply('fresh-b');
    await sleep(0);
    expect(h.cardText()).toContain('译：fresh-b');
  });

  it('Alt 松开：卡消失 + 在途作废；之后 mousemove 不再触发（altHeld=false）', async () => {
    const h = harness();
    h.altDown();
    h.move(h.para);
    await h.flush();
    expect(h.cardCount()).toBe(1);
    h.altUp();
    expect(h.cardCount()).toBe(0);
    h.reply('late');
    await sleep(0);
    expect(h.cardCount()).toBe(0);
    expect(h.requests).toHaveLength(1);
    h.move(h.para2);
    await h.flush();
    expect(h.requests).toHaveLength(1); // Alt 未按住
  });

  it('blur / ESC / scroll 三收敛路径：卡消失', async () => {
    const h = harness();
    h.altDown();
    h.move(h.para);
    await h.flush();
    expect(h.cardCount()).toBe(1);
    h.blur();
    expect(h.cardCount()).toBe(0);

    h.altDown();
    h.move(h.para);
    await h.flush();
    expect(h.cardCount()).toBe(1);
    h.esc();
    expect(h.cardCount()).toBe(0);

    // scroll 收敛需要 altHeld 状态无关（scroll 直接 hideAll）
    h.altDown();
    h.move(h.para);
    await h.flush();
    expect(h.cardCount()).toBe(1);
    h.scroll();
    expect(h.cardCount()).toBe(0);
  });

  it('pickParagraph 边界：editable / code / 空白 / span 叶子（X 推文形）', async () => {
    const h = harness();
    // editable 内 → 不触发
    h.altDown();
    h.move(h.editable);
    await h.flush();
    expect(h.cardCount()).toBe(0);
    expect(h.requests).toHaveLength(0);

    // code/pre 内 → 不触发
    h.move(h.codeWrap);
    await h.flush();
    expect(h.requests).toHaveLength(0);

    // 空白段落 → 不触发
    const ownerDoc = h.para.ownerDocument;
    if (!ownerDoc) throw new Error('no ownerDocument');
    const blank = ownerDoc.createElement('p');
    blank.textContent = '   ';
    h.para.after(blank);
    h.move(blank);
    await h.flush();
    expect(h.requests).toHaveLength(0);

    // leaf span（无 p 祖先）→ fallback target 自身，文本正确
    const tweet = ownerDoc.querySelector('#tweet') as HTMLElement;
    h.move(tweet);
    await h.flush();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0].type === 'TRANSLATE_BATCH' && h.requests[0].segments[0]?.text).toBe(
      'a leaf span like a tweet text',
    );
  });

  it('错误包：译文行渲染 errorTipText 语义文案', async () => {
    const h = harness();
    h.altDown();
    h.move(h.para);
    await h.flush();
    h.reply(null);
    await sleep(0);
    expect(h.cardCount()).toBe(1);
    expect(h.cardText()).toBe(
      'hover paragraph one about patient owls' + errorTipText('E_RATE_LIMITED'),
    );
  });
});

describe('HoverCard · UI 可调（T-024 / M3-1）', () => {
  it('floatOffset 注入 → 下一次悬停锚点用新偏移（rectAnchor 重算）', async () => {
    const h = harness();
    h.hover.applyUiStyle({ ...defaultUiStyle(), floatOffset: 30 });
    h.altDown();
    h.move(h.para);
    await h.flush();
    expect(h.cardCount()).toBe(1);
    const card = h.cardEl() as HTMLElement;
    expect(card.style.left).toBe('30px'); // jsdom rect 0 → anchorX = 0 + 30
  });

  it('hoverFontSize 注入：浮卡不存在时仅登记；已挂卡时变量即时生效', async () => {
    const h = harness();
    h.altDown();
    h.move(h.para);
    await h.flush();
    const card = h.cardEl() as HTMLElement;
    expect(card.style.getPropertyValue('--itr-hover-font-size')).toBe('');
    h.hover.applyUiStyle({ ...defaultUiStyle(), hoverFontSize: 20 });
    expect(card.style.getPropertyValue('--itr-hover-font-size')).toBe('20px');
  });

  it('ITR_CSS：三处字号变量与悬浮卡 src 行 em 相对缩放落地', () => {
    expect(ITR_CSS).toContain('font-size: var(--itr-caption-font-size, 18px)');
    expect(ITR_CSS).toContain('font-size: var(--itr-sel-bubble-font-size, 13px)');
    expect(ITR_CSS).toContain('font-size: var(--itr-hover-font-size, 13px)');
    expect(ITR_CSS).toContain('0.885em');
  });
});
