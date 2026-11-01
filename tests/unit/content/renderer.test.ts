// T-007：双语渲染器单测，锚定 .agent/evals/golden/segmentation-render.md 的渲染红线
// T-017：布局安全插入锚点用例（契约 segmentation.md 同名节）
import { describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { extractBlocks, type SegBlock } from '../../../src/content/extractor';
import {
  CONTAINER_CLASS,
  HIDDEN_CLASS,
  PageRenderer,
  safeAnchor,
} from '../../../src/content/renderer';
import { logger } from '../../../src/shared/logger';

function setup(html: string): {
  doc: Document;
  body: HTMLElement;
  blocks: SegBlock[];
  renderer: PageRenderer;
} {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>${html}</body></html>`,
  );
  const doc = dom.window.document;
  const blocks = extractBlocks(doc.body, { sessionId: 't', isVisible: () => true });
  const renderer = new PageRenderer(doc, 'bilingual', 'light');
  return { doc, body: doc.body, blocks, renderer };
}

describe('PageRenderer（契约渲染规则）', () => {
  it('seg-h1 渲染：原文文本不动，译文容器插在 afterend', () => {
    const { body, blocks, renderer } = setup('<h1>The History of Tea</h1>');
    const before = body.querySelector('h1')?.textContent;
    renderer.begin(blocks);
    renderer.appendTranslation(blocks[0] as SegBlock, '茶的历史');
    const h1 = body.querySelector('h1');
    expect(h1?.textContent).toBe(before);
    const container = h1?.nextElementSibling;
    expect(container?.classList.contains(CONTAINER_CLASS)).toBe(true);
    expect(container?.textContent).toBe('茶的历史');
    expect(container?.getAttribute('data-itr-theme')).toBe('light');
  });

  it('seg-inline-links：[[n]] 克隆还原为可点链接（href 保留）', () => {
    const { body, blocks, renderer } = setup(
      "<p>See the <a href='/x'>official guide</a> and <b>notes</b>.</p>",
    );
    renderer.begin(blocks);
    renderer.appendTranslation(blocks[0] as SegBlock, '参见 [[1]] 及 [[2]]。');
    const container = body.querySelector(`.${CONTAINER_CLASS}`);
    const cloned = container?.querySelector('a');
    expect(cloned?.getAttribute('href')).toBe('/x');
    expect(container?.textContent).toBe('参见 official guide 及 notes。');
  });

  it('丢失占位符：静默删除 + warn 日志，其余文本保留', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const { body, blocks, renderer } = setup(
      "<p>See the <a href='/x'>official guide</a>.</p>",
    );
    renderer.begin(blocks);
    renderer.appendTranslation(blocks[0] as SegBlock, '参见 [[1]] 与 [[5]]。');
    const container = body.querySelector(`.${CONTAINER_CLASS}`);
    expect(container?.textContent).toBe('参见 official guide 与 。');
    expect(container?.querySelectorAll('a')).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it('长文本子段：多次 append 并回同一容器且顺序正确', () => {
    const { body, blocks, renderer } = setup('<p>long text</p>');
    const block = blocks[0] as SegBlock;
    renderer.begin(blocks);
    renderer.appendTranslation(block, '第一段译文。');
    renderer.appendTranslation(block, '第二段译文。');
    const containers = body.querySelectorAll(`.${CONTAINER_CLASS}`);
    expect(containers).toHaveLength(1);
    expect(containers[0]?.textContent).toBe('第一段译文。第二段译文。');
  });

  it('translation-only：原文隐藏类可添加/移除，clearAll 彻底还原', () => {
    const { body, blocks, renderer } = setup('<p>only path</p>');
    renderer.begin(blocks);
    renderer.setStyleMode('translation-only');
    const p = body.querySelector('p');
    expect(p?.classList.contains(HIDDEN_CLASS)).toBe(true);
    renderer.appendTranslation(blocks[0] as SegBlock, '只有译文');
    renderer.setStyleMode('bilingual');
    expect(p?.classList.contains(HIDDEN_CLASS)).toBe(false);
  });

  it('appendError：容器出现错误占位样式且带错误码', () => {
    const { body, blocks, renderer } = setup('<p>will fail</p>');
    renderer.begin(blocks);
    renderer.appendError(blocks[0] as SegBlock, 'E_NO_KEY');
    const err = body.querySelector('.itr-error');
    expect(err?.getAttribute('data-itr-error-code')).toBe('E_NO_KEY');
  });

  it('isTranslated：已插入容器的原文可被识别（去重复触发依据）', () => {
    const { blocks, renderer } = setup('<p>again</p>');
    const block = blocks[0] as SegBlock;
    renderer.begin(blocks);
    expect(renderer.isTranslated(block.el)).toBe(false);
    renderer.appendTranslation(block, '樱');
    expect(renderer.isTranslated(block.el)).toBe(true);
  });

  it('红线：clearAll 后 body innerHTML 逐字节还原，head 样式表移除', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const original =
      "<p>See the <a href='/x'>guide</a> and <b>notes</b>.</p><h2 title='t'>Header</h2>";
    const { doc, body, blocks, renderer } = setup(original);
    const snapshot = body.innerHTML;
    renderer.begin(blocks);
    renderer.appendTranslation(blocks[0] as SegBlock, '带 [[1]] 与 [[2]] 的译文');
    renderer.setStyleMode('translation-only');
    expect(doc.head.querySelector('style[data-itr-style]')).not.toBeNull();
    expect(body.innerHTML).not.toBe(snapshot);

    const removed = renderer.clearAll();
    expect(removed).toBe(1);
    expect(body.innerHTML).toBe(snapshot); // 逐字节一致
    expect(doc.head.querySelector('style[data-itr-style]')).toBeNull();
    expect(body.querySelectorAll(`.${CONTAINER_CLASS}`)).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it('样式表幂等：begin/setStyleMode 多次调用只有一个 style 节点', () => {
    const { doc, blocks, renderer } = setup('<p>a</p>');
    renderer.begin(blocks);
    renderer.setStyleMode('translation-only');
    renderer.setStyleMode('bilingual');
    expect(doc.head.querySelectorAll('style[data-itr-style]')).toHaveLength(1);
  });

  it('T-016 容器获取幂等：同原文已有容器（跨会话遗留）→ 复用清空重填，不堆叠', () => {
    const { body, blocks, renderer } = setup('<p>original text here</p>');
    renderer.begin(blocks);
    const block1 = blocks[0] as SegBlock;
    renderer.appendTranslation(block1, '第一次译文');

    // 跨会话：同 el、不同 id（各会话抽取 id）→ 若无 DOM 防御会插出第二个容器
    const el = body.querySelector('p') as Element;
    const block2: SegBlock = { id: 'b1-other-session', el, text: block1.text, placeholders: [] };
    renderer.appendTranslation(block2, '第二次译文');

    const containers = body.querySelectorAll(`.${CONTAINER_CLASS}`);
    expect(containers).toHaveLength(1); // 只有一个，绝不堆叠
    expect(containers[0]?.textContent).toBe('第二次译文'); // 清空重填
  });

  // ---------- T-017 布局安全插入锚点（契约 segmentation.md 同名节） ----------

  function rawDom(html: string): { doc: Document; body: HTMLElement } {
    const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`);
    const doc = dom.window.document;
    return { doc, body: doc.body };
  }

  function blockOf(el: Element, id: string): SegBlock {
    return { id, el, text: el.textContent ?? '', placeholders: [] };
  }

  it('safeAnchor：inline 父容器/横向 flex 上移，块级父容器原地返回，body 停', () => {
    const { doc, body } = rawDom(
      "<p style='display:block'><span style='display:inline'><b>In text here</b></span></p>",
    );
    const b = body.querySelector('b') as Element;
    // b 的父 span 是 inline → 上移；span 的父 p 是 block → 停
    const span = body.querySelector('span') as Element;
    expect(safeAnchor(b)).toBe(span);

    const blockP = body.querySelector('p') as Element;
    // p 的父 body 是 block → 原地返回
    expect(safeAnchor(blockP)).toBe(blockP);

    // body 直下：parentElement = body → 循环终止（不爬出 body）
    const direct = doc.createElement('p');
    direct.textContent = 'direct child';
    body.appendChild(direct);
    expect(safeAnchor(direct)).toBe(direct);
  });

  it('锚点·inline 父容器：h3 嵌在链接里 → 容器挂在链接之后，不进 inline 流', () => {
    const { doc, body } = rawDom(
      // jsdom 无 UA 样式表：default display 为空串，显式声明对齐真实浏览器的 inline
      "<div><a href='#' style='display:inline'><h3>Video title words</h3><span>meta</span></a></div>",
    );
    const renderer = new PageRenderer(doc, 'bilingual', 'light');
    const h3 = body.querySelector('h3') as Element;
    const block = blockOf(h3, 'b1');
    renderer.appendTranslation(block, '视频标题译文');
    const container = body.querySelector(`.${CONTAINER_CLASS}`);
    expect(container).not.toBeNull();
    expect(container?.parentElement).toBe(body.querySelector('div')); // 出了 inline 流，挂包裹块内
    expect(container?.previousElementSibling).toBe(body.querySelector('a'));
    // h3 自己后面（inline 流内）仍是原 meta span，不是我们的容器
    expect(h3.nextElementSibling?.classList.contains(CONTAINER_CLASS)).toBe(false);
    expect(renderer.isTranslated(h3)).toBe(true); // isTranslated 与插入共用同一锚点
  });

  it('锚点·横向 flex 父容器：容器移到整行之后，不挤进行内的 flex item', () => {
    const { doc, body } = rawDom(
      '<div style="display:flex"><h3>Row title text</h3><span>row meta</span></div>',
    );
    const renderer = new PageRenderer(doc, 'bilingual', 'light');
    const h3 = body.querySelector('h3') as Element;
    renderer.appendTranslation(blockOf(h3, 'b1'), '整行之后的译文');
    const container = body.querySelector(`.${CONTAINER_CLASS}`);
    const row = body.querySelector('div') as Element;
    expect(container?.parentElement).toBe(body);
    expect(container?.previousElementSibling).toBe(row); // 挂在整行之后
  });

  it('锚点·纵向 flex 父容器：原地插入（追加行安全，不上移）', () => {
    const { doc, body } = rawDom(
      '<div style="display:flex;flex-direction:column"><h3>Column title</h3><span>col meta</span></div>',
    );
    const renderer = new PageRenderer(doc, 'bilingual', 'light');
    const h3 = body.querySelector('h3') as Element;
    renderer.appendTranslation(blockOf(h3, 'b1'), '列内追加行');
    const container = body.querySelector(`.${CONTAINER_CLASS}`);
    expect(container?.parentElement).toBe(body.querySelector('div'));
    expect(container?.previousElementSibling).toBe(h3); // 就在原位，语义紧邻
  });

  it('锚点·grid 父容器：容器挂在网格项之外，不变成多余格子', () => {
    const { doc, body } = rawDom(
      '<ul style="display:grid"><li>Grid item text</li></ul>',
    );
    const renderer = new PageRenderer(doc, 'bilingual', 'light');
    const li = body.querySelector('li') as Element;
    renderer.appendTranslation(blockOf(li, 'b1'), '格子外的译文');
    const container = body.querySelector(`.${CONTAINER_CLASS}`);
    expect(container?.parentElement).toBe(body);
    expect(container?.previousElementSibling).toBe(body.querySelector('ul'));
  });

  it('锚点协同 T-016 防御：竞态遗留容器挂在锚点后（而非原文后）→ 同样被复用清空重填', () => {
    const { doc, body } = rawDom(
      // jsdom 无 UA 样式表：a 的 default display 为空串，显式声明对齐真实浏览器
      "<a href='#' style='display:inline'><h3>Inline nested title</h3></a><div class='itr-translation'>陈旧内容</div>",
    );
    const renderer = new PageRenderer(doc, 'bilingual', 'light');
    const h3 = body.querySelector('h3') as Element;
    // 同一 el 跨会话 id不同 → DOM 防御应命中锚点（a）后的遗留容器
    renderer.appendTranslation(blockOf(h3, 'b1-other-session'), '复用后的新译文');
    const containers = body.querySelectorAll(`.${CONTAINER_CLASS}`);
    expect(containers).toHaveLength(1); // 不堆叠
    expect(body.querySelector(`.${CONTAINER_CLASS}`)?.textContent).toBe('复用后的新译文');
    expect(renderer.isTranslated(h3)).toBe(true);
  });

  // ---------- T-020b clamp 释放三连（契约「clamp 释放三连」H4） ----------

  it('clamp 释放：新建容器时对锚点及父、祖父追加三连；原有声明保留（附加不重写）', () => {
    const { doc, body } = rawDom(
      '<div id="g" style="color:red"><div id="p"><div id="a">Title words doubled</div></div></div>',
    );
    const renderer = new PageRenderer(doc, 'bilingual', 'light');
    const a = body.querySelector('#a') as HTMLElement;
    renderer.appendTranslation(blockOf(a, 'b1'), '标题译文');
    // jsdom cssText 会丢弃不认识的 -webkit-line-clamp（真实浏览器保留）；
    // 断言用它保留的 max-height / height 两个成员验证三连同达
    expect(a.style.cssText).toContain('max-height: none');
    expect(a.style.cssText).toContain('height: auto');
    const p = body.querySelector('#p') as HTMLElement;
    expect(p.style.cssText).toContain('max-height: none');
    const g = body.querySelector('#g') as HTMLElement;
    expect(g.style.cssText).toContain('height: auto');
    expect(g.style.cssText).toContain('color: red'); // 原有声明未被重写
  });

  it('clamp 释放只发生在首建容器：复用/重复 append 不叠加第二条三连', () => {
    const { doc, body } = rawDom('<div><div><ul><li>List item text here</li></ul></div></div>');
    const renderer = new PageRenderer(doc, 'bilingual', 'light');
    const li = body.querySelector('li') as Element;
    const block1 = blockOf(li, 'b1');
    renderer.appendTranslation(block1, '第一次译文');
    // 同 el 不同 id（跨会话余留）→ 走 DOM 防御复用分支，不再动 style
    renderer.appendTranslation(blockOf(li, 'b2-other'), '第二次译文');
    // DOM 实况：仅 1 个容器（防御复用，绝不堆叠）；clearAll 计数按 block id 登记，
    // 防御复用会以第二个 id 重复登记同一节点（T-016 起既有语义），不断言计数值
    expect(body.querySelectorAll(`.${CONTAINER_CLASS}`)).toHaveLength(1);
    const liStyle = (li as HTMLElement).style.cssText;
    expect(liStyle.split('height: auto').length - 1).toBe(1); // 仅一条三连
    renderer.clearAll();
    expect(body.querySelectorAll(`.${CONTAINER_CLASS}`)).toHaveLength(0);
    expect((li as HTMLElement).getAttribute('style')).toBeNull(); // 三连已还原
  });

  it('clearAll 还原 clamp：原无 style → 属性整个移除；原有 style → 字节级还原', () => {
    const { doc, body } = rawDom('<div><div><b>Bold words more</b></div></div>');
    const before = body.innerHTML;
    const renderer = new PageRenderer(doc, 'bilingual', 'light');
    const b = body.querySelector('b') as HTMLElement;
    renderer.appendTranslation(blockOf(b, 'b1'), '加粗译文');
    expect((body.querySelector('div') as HTMLElement).getAttribute('style')).toContain(
      'max-height: none',
    );
    renderer.clearAll();
    expect(body.innerHTML).toBe(before); // style 属性字节级还原
  });

  it('clearAll 还原 clamp：原有 style 值精确复原（非空原值分支）', () => {
    const { doc, body } = rawDom('<div><b style="color:blue">Bold words more</b></div>');
    const renderer = new PageRenderer(doc, 'bilingual', 'light');
    const b = body.querySelector('b') as HTMLElement;
    renderer.appendTranslation(blockOf(b, 'b1'), '加粗译文');
    expect(b.style.color).toBe('blue'); // sanity：附加后原有声明仍在
    renderer.clearAll();
    expect(b.getAttribute('style')).toBe('color:blue'); // raw 原值（不经解析再序列化）
  });
});
