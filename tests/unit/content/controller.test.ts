// T-008：content 编排层单测（fake RPC 注入，验证契约行为而非 chrome API）
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { PageController, type ControllerDeps } from '../../../src/content/controller';
import type { RpcRequest, RpcResponse } from '../../../src/shared/messaging';
import type { ExtensionSettings, TranslatedSegment } from '../../../src/shared/types';

const CONTAINER = 'itr-translation';

function makeDom(html: string, url = 'https://example.com/page'): { dom: JSDOM; doc: Document } {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, { url });
  return { dom, doc: dom.window.document };
}

function baseSettings(...overrides: Partial<ExtensionSettings>[]): ExtensionSettings {
  return {
    providers: [],
    targetLang: 'zh-CN',
    autoTranslateSites: [],
    styleMode: 'bilingual',
    theme: 'light',
    hoverEnabled: false,
    selectionEnabled: false,
    pdfEntryEnabled: true,
    ...overrides.reduce((acc, o) => ({ ...acc, ...o }), {}),
  } satisfies ExtensionSettings;
}

interface Harness {
  doc: Document;
  body: HTMLElement;
  controller: PageController;
  /** 全部非 GET/SET 请求留痕 */
  batches: Extract<RpcRequest, { type: 'TRANSLATE_BATCH' }>[];
}

/**
 * 默认 RPC：GET/SET_SETTINGS 由内存 settings 处理；
 * TRANSLATE_BATCH 由注入的 reply(requestId, segments) 决定回包或挂起。
 */
function harness(
  html: string,
  reply: (
    segments: Array<{ id: string; text: string }>,
  ) => RpcResponse | Promise<RpcResponse>,
  settingsOverride: Partial<ExtensionSettings> = {},
  extraDeps: Partial<ControllerDeps> = {},
  url = 'https://example.com/page',
): Harness & { settings: ExtensionSettings } {
  const { doc } = makeDom(html, url);
  const settings = baseSettings(settingsOverride);
  const batches: Extract<RpcRequest, { type: 'TRANSLATE_BATCH' }>[] = [];
  const request = async (msg: RpcRequest): Promise<RpcResponse> => {
    switch (msg.type) {
      case 'GET_SETTINGS':
        return { type: 'SETTINGS', settings };
      case 'GET_PUBLIC_SETTINGS':
        return {
          type: 'PUBLIC_SETTINGS',
          settings: { targetLang: settings.targetLang, pdfEntryEnabled: settings.pdfEntryEnabled },
        };
      case 'SET_SETTINGS':
        Object.assign(settings, msg.patch);
        return { type: 'SETTINGS', settings };
      case 'TRANSLATE_BATCH':
        batches.push(msg);
        return await reply(msg.segments);
      case 'CANCEL':
        return { type: 'CANCELED', ok: true };
      case 'CLEAR_CACHE':
      case 'PING':
        return { type: 'NOT_SUPPORTED' };
      case 'SUMMARIZE_TEXT':
        return { type: 'SUMMARY', text: '概要' }; // T-026：假路由覆盖新 RPC 变体
      case 'CAPTURE_KEYFRAME':
        return { type: 'KEYFRAME_SAVED', id: 'kf-test', videoTime: null }; // T-027：假路由覆盖新 RPC 变体
      case 'OPEN_PDF_READER':
        return { type: 'PDF_READER_OPENED', ok: true }; // T-028f：假路由覆盖新 RPC 变体
    }
  };
  const controller = new PageController({
    doc,
    request,
    spaDebounceMs: 20,
    sessionId: 'test',
    ...extraDeps,
  });
  return { doc, body: doc.body, controller, batches, settings };
}

const okBatch = (segments: Array<{ id: string; text: string }>): RpcResponse => ({
  type: 'TRANSLATION',
  items: segments.map((s) => ({ id: s.id, text: `译：${s.text}` })),
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('PageController', () => {
  it('TRANSLATE_PAGE：整页抽取 → 批量请求 → 双语渲染到原文之后', async () => {
    const h = harness('<p>Hello world paragraph</p>', (segments) => okBatch(segments));
    await h.controller.handleAction({ type: 'TRANSLATE_PAGE' });
    await sleep(10);
    expect(h.batches).toHaveLength(1);
    const batch = h.batches[0];
    expect(batch.segments).toEqual([{ id: 'b1-test', text: 'Hello world paragraph' }]);
    expect(batch.source).toBe('auto');
    expect(batch.target).toBe('zh-CN');

    const p = h.body.querySelector('p');
    expect(p?.textContent).toBe('Hello world paragraph'); // 原文不动
    const container = p?.nextElementSibling;
    expect(container?.classList.contains(CONTAINER)).toBe(true);
    expect(container?.textContent).toBe('译：Hello world paragraph');
  });

  it('PROGRESS 增量先响；最终响应不重复渲染', async () => {
    const gate = { resolve: null as null | ((res: RpcResponse) => void) };
    const h = harness(
      '<p>Full text</p>',
      (_segments) =>
        new Promise<RpcResponse>((resolve) => {
          gate.resolve = resolve;
        }),
    );
    void h.controller.handleAction({ type: 'TRANSLATE_PAGE' });
    await sleep(5);

    h.controller.handleEvent({
      type: 'TRANSLATION_PROGRESS',
      requestId: h.batches[0].requestId,
      done: 0,
      total: 1,
      items: [{ id: 'b1-test', text: '译：增量到达' }],
    });
    const container = h.body.querySelector(`.${CONTAINER}`);
    expect(container?.textContent).toBe('译：增量到达');

    gate.resolve?.(okBatch(h.batches[0].segments)); // 响应回同一段
    await sleep(5);
    expect(h.body.querySelectorAll(`.${CONTAINER}`)).toHaveLength(1); // 无重复
    expect(h.body.querySelector(`.${CONTAINER}`)?.textContent).toBe('译：增量到达');
  });

  it('toggle：进行中再触发 → CANCEL + 清空已插入译文', async () => {
    const h = harness(
      '<p>pending text</p>',
      () =>
        new Promise<RpcResponse>(() => undefined), // 永挂起
    );
    void h.controller.handleAction({ type: 'TRANSLATE_PAGE' });
    await sleep(5);
    h.controller.handleEvent({
      type: 'TRANSLATION_PROGRESS',
      requestId: h.batches[0].requestId,
      done: 0,
      total: 1,
      items: [{ id: 'b1-test', text: '译：已上屏' }],
    });
    expect(h.body.querySelectorAll(`.${CONTAINER}`)).toHaveLength(1);

    await h.controller.handleAction({ type: 'TRANSLATE_PAGE' }); // toggle off
    await sleep(5);
    expect(h.body.querySelectorAll(`.${CONTAINER}`)).toHaveLength(0);
    expect(h.body.querySelector('p')?.textContent).toBe('pending text'); // 原文完好
  });

  it('段级错误 → 容器内 .itr-error；请求级 E_NO_KEY → 提示条', async () => {
    const h = harness('<p>some text</p>', () => ({
      type: 'TRANSLATION',
      items: [{ id: 'b1-test', text: '', error: { code: 'E_RATE_LIMITED' } }],
      error: { code: 'E_NO_KEY' },
    } satisfies RpcResponse));
    await h.controller.handleAction({ type: 'TRANSLATE_PAGE' });
    await sleep(10);
    expect(h.body.querySelector('.itr-error')).not.toBeNull();
    const tip = h.body.querySelector('.itr-tip') as HTMLElement | null;
    expect(tip?.textContent).toContain('API Key');
  });

  it('长文本：>4000 拆子段请求，无句界硬切兜底', async () => {
    // 5200 字符单句（A 无边界）→ 硬切 [4000, 1200]
    const html = `<p>${'A'.repeat(5200)}</p>`;
    const h = harness(
      html,
      (segments) => ({
        type: 'TRANSLATION',
        items: segments.map((s) => ({ id: s.id, text: `#${(s.id.split('#')[1] ?? '0')}译` })),
      }),
    );
    await h.controller.handleAction({ type: 'TRANSLATE_PAGE' });
    await sleep(10);
    expect(h.batches[0].segments.map((s) => s.id)).toEqual(['b1-test#0', 'b1-test#1']);
    expect(h.batches[0].segments.map((s) => s.text.length)).toEqual([4000, 1200]);

    // 乱序：先消费 #1，再 #0 → 最终按序拼接且单容器
    const c2 = h.controller as unknown as { consumeItem: (i: TranslatedSegment) => void };
    c2.consumeItem({ id: 'b1-test#1', text: '[乱序注入]' });
    // #1 已随响应渲染且 renderedIds 去重：容器内容仍是响应的有序拼接，无重复
    const container = h.body.querySelector(`.${CONTAINER}`);
    expect(container?.getAttribute('data-itr-id')).toBe('b1-test');
    expect(container?.textContent).toBe('#0译#1译');
  });

  it('重复触发：已翻译块跳过（不发第二批空请求）', async () => {
    const h = harness('<p>content one</p><p>content two</p>', (segments) => okBatch(segments));
    await h.controller.handleAction({ type: 'TRANSLATE_PAGE' });
    await sleep(10);
    await h.controller.handleAction({ type: 'TRANSLATE_PAGE' }); // toggle off → stop（清掉）
    await sleep(5);
    expect(h.body.querySelectorAll(`.${CONTAINER}`)).toHaveLength(0);
    await h.controller.handleAction({ type: 'TRANSLATE_PAGE' }); // toggle on 重新翻译
    await sleep(10);
    expect(h.batches).toHaveLength(2);
    expect(h.batches[1].segments).toHaveLength(2); // 清空后重译，仍 2 段不重复
    expect(h.body.querySelectorAll(`.${CONTAINER}`)).toHaveLength(2);
  });

  it('AUTO_ON/AUTO_OFF：折叠为 SET_SETTINGS 增删当前 host', async () => {
    const h = harness('<p>x</p>', () => ({ type: 'TRANSLATION', items: [] }));
    await h.controller.handleAction({ type: 'AUTO_ON' });
    await sleep(5);
    expect(h.settings.autoTranslateSites).toEqual(['example.com']);
    await h.controller.handleAction({ type: 'AUTO_OFF' });
    await sleep(5);
    expect(h.settings.autoTranslateSites).toEqual([]);
  });

  it('白名单命中：init() 自动开始整页翻译', async () => {
    const h = harness(
      '<p>auto start me</p>',
      (segments) => okBatch(segments),
      { autoTranslateSites: ['example.com'] },
    );
    await h.controller.init();
    await sleep(10);
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0].segments[0]?.text).toBe('auto start me');
  });

  it('SETTINGS_CHANGED：主题热切换（样式表属性更新）', () => {
    const h = harness('<p>x</p>', () => ({ type: 'TRANSLATION', items: [] }));
    void h.controller.handleAction({ type: 'AUTO_ON' });
    h.controller.handleEvent({
      type: 'SETTINGS_CHANGED',
      settings: baseSettings({ theme: 'dark' }),
    });
    const style = h.doc.head.querySelector('style[data-itr-style]');
    expect(style?.getAttribute('data-itr-theme')).toBe('dark');
  });

  it('SPA：会话结束后新增段落，防抖后只翻译新块', async () => {
    const h = harness('<p>first round</p>', (segments) => okBatch(segments));
    await h.controller.handleAction({ type: 'TRANSLATE_PAGE' });
    await sleep(10);
    expect(h.batches).toHaveLength(1);

    const fresh = h.doc.createElement('h2');
    fresh.textContent = 'newly inserted heading';
    h.body.append(fresh);
    await sleep(60); // 防抖 20ms 后重抽
    expect(h.batches).toHaveLength(2);
    expect(h.batches[1].segments).toEqual([{ id: 'b2-test', text: 'newly inserted heading' }]);
  });

  it('来源标签非本会话的 PROGRESS 被忽略（跨 tab 隔离）', () => {
    const h = harness('<p>x</p>', () => ({ type: 'TRANSLATION', items: [] }));
    h.controller.handleEvent({
      type: 'TRANSLATION_PROGRESS',
      requestId: 'req-from-another-tab',
      done: 1,
      total: 1,
      items: [{ id: 'b1-test', text: '别的页' }],
    });
    expect(h.body.querySelectorAll(`.${CONTAINER}`)).toHaveLength(0);
  });

  it('T-017 YouTube：整页翻译与字幕通道并行（不再一刀切禁页）', async () => {
    const leaf = `<div><span>this is a long leaf span text well over twenty chars</span></div>`;
    const h = harness(leaf, (segments) => okBatch(segments), {}, {}, 'https://www.youtube.com/watch?v=abc');
    await h.controller.handleAction({ type: 'TRANSLATE_PAGE' });
    await sleep(10);
    expect(h.batches).toHaveLength(1); // 整页抽取恢复（此 fixture 无 override 命中，走通用叶子块）
    expect(h.body.querySelectorAll(`.${CONTAINER}`)).toHaveLength(1);
    const internals = h.controller as unknown as { subtitle: { active: boolean } };
    expect(internals.subtitle.active).toBe(true); // 字幕通道同时监听

    await h.controller.handleAction({ type: 'TRANSLATE_PAGE' }); // toggle off
    await sleep(5);
    expect(h.body.querySelectorAll(`.${CONTAINER}`)).toHaveLength(0);
    expect(internals.subtitle.active).toBe(false);
  });

  it('T-018 目标语言命中：中文块不入批、不渲染容器（Skip #6）', async () => {
    const h = harness(
      '<p>这是一条已经读完的中文内容段落，不再需要翻译。</p><p>English paragraph worth translating here</p>',
      (segments) => okBatch(segments),
    );
    await h.controller.handleAction({ type: 'TRANSLATE_PAGE' });
    await sleep(10);
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0].segments).toEqual([
      { id: 'b2-test', text: 'English paragraph worth translating here' },
    ]); // b1 中文块被跳过
    expect(h.body.querySelectorAll(`.${CONTAINER}`)).toHaveLength(1);
  });

  it('T-013 空块仍挂观察者：虚拟列表/懒加载内容出现后补扫', async () => {
    const h = harness('<div><span>short box note</span></div>', (segments) => okBatch(segments));
    await h.controller.handleAction({ type: 'TRANSLATE_PAGE' });
    await sleep(10);
    expect(h.batches).toHaveLength(0); // 首扫为空（span 短于叶子阈值 20）

    const p = h.doc.createElement('p');
    p.textContent = 'late arriving paragraph content';
    h.body.append(p);
    await sleep(60); // 防抖 20ms 后补扫
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0].segments).toEqual([{ id: 'b1-test', text: 'late arriving paragraph content' }]);
  });
});
