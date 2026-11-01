// T-006：段落抽取器单测，覆盖 .agent/evals/golden/segmentation-render.md 的 seg-* 用例
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  extractBlocks,
  isNoiseText,
  splitLongText,
  type SegBlock,
} from '../../../src/content/extractor';

function blocksOf(html: string, sessionId = 'test'): SegBlock[] {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  return extractBlocks(dom.window.document.body, {
    sessionId,
    isVisible: () => true,
  });
}

describe('extractBlocks（契约 seg 抽取）', () => {
  it('seg-h1：h1 抽出 1 block，原文属性未动', () => {
    const bs = blocksOf('<h1>The History of Tea</h1>');
    expect(bs).toHaveLength(1);
    expect(bs[0]?.el.tagName).toBe('H1');
    expect(bs[0]?.text).toBe('The History of Tea');
  });

  it('seg-inline-links：2 个占位符且映射指向 A/B 节点', () => {
    const bs = blocksOf("<p>See the <a href='/x'>official guide</a> and <b>notes</b>.</p>");
    expect(bs).toHaveLength(1);
    expect(bs[0]?.text).toBe('See the [[1]] and [[2]].');
    const first = bs[0]?.placeholders[0];
    const second = bs[0]?.placeholders[1];
    expect(first?.tagName).toBe('A');
    expect(first?.getAttribute('href')).toBe('/x');
    expect(second?.tagName).toBe('B');
  });

  it('seg-list：li 各自成段（2 blocks 不合并）', () => {
    const bs = blocksOf(
      "<ul><li>First item</li><li>Second item with <a href='/y'>link</a></li></ul>",
    );
    expect(bs).toHaveLength(2);
    expect(bs[0]?.text).toBe('First item');
    expect(bs[1]?.text).toBe('Second item with [[1]]');
  });

  it('seg-code-skip：pre 整块跳过；p 内 code 子树整体剥除', () => {
    const bs = blocksOf(
      '<pre>const a = 1;</pre><p>Uses <code>Promise.all</code> internally.</p>',
    );
    expect(bs).toHaveLength(1);
    expect(bs[0]?.el.tagName).toBe('P');
    expect(bs[0]?.text).not.toContain('Promise.all');
    expect(bs[0]?.text).toBe('Uses internally.');
  });

  it('seg-input-skip：input/textarea 内容不进 blocks', () => {
    const bs = blocksOf(
      "<input value='Search…'><textarea>hello</textarea><p>Greeting text</p>",
    );
    expect(bs).toHaveLength(1);
    expect(bs[0]?.text).toBe('Greeting text');
  });

  it('seg-notranslate：class 命中 skip 后仅剩普通段', () => {
    const bs = blocksOf("<p class='notranslate'>DO NOT TOUCH</p><p>Normal text</p>");
    expect(bs).toHaveLength(1);
    expect(bs[0]?.text).toBe('Normal text');
  });

  it('translate=no 与 contenteditable 亦跳过', () => {
    const bs = blocksOf(
      "<p translate='no'>Nope</p><p contenteditable='true'>Edit me</p><p>keep</p>",
    );
    expect(bs).toHaveLength(1);
    expect(bs[0]?.text).toBe('keep');
  });

  it('skip 规则 #5：纯数字/纯 URL/纯邮箱不抽取；普通含链接文本保留', () => {
    const bs = blocksOf(
      '<td>12345-6789</td><p>someone@example.com</p><p>Visit https://example.com/a/page for info</p>',
    );
    expect(bs).toHaveLength(1);
    expect(bs[0]?.text).toContain('Visit');
  });

  it('短于 2 字符的块被跳过', () => {
    const bs = blocksOf('<p>a</p><p>ok</p>');
    expect(bs).toHaveLength(1);
    expect(bs[0]?.text).toBe('ok');
  });

  it('id 含 sessionId 且互不相同', () => {
    const bs = blocksOf('<p>one</p><p>two</p>', 'sess9');
    expect(bs[0]?.id.endsWith('sess9')).toBe(true);
    expect(bs[0]?.id).not.toBe(bs[1]?.id);
  });

  it('itr- 前缀译文容器不被再次抽取（red-line 前置条件）', () => {
    const bs = blocksOf(
      '<p>原文段落</p><div class="itr-translation">已插入的译文</div>',
    );
    expect(bs).toHaveLength(1);
    expect(bs[0]?.text).toBe('原文段落');
  });

  it('isVisible 注入：不可见元素被过滤（浏览器可见性判定入口）', () => {
    const dom = new JSDOM('<body><p>hidden</p><p>shown</p></body>');
    const ps = dom.window.document.querySelectorAll('p');
    const bs = extractBlocks(dom.window.document.body, {
      sessionId: 't',
      isVisible: (el) => el === ps[1],
    });
    expect(bs).toHaveLength(1);
    expect(bs[0]?.text).toBe('shown');
  });
});

describe('isNoiseText（Skip #5 阈值）', () => {
  it('纯数字/纯符号 → true', () => {
    expect(isNoiseText('123-456-7890')).toBe(true);
    expect(isNoiseText('**:://??')).toBe(true);
  });
  it('URL/邮箱 → true', () => {
    expect(isNoiseText('https://example.com/x/y?z=1')).toBe(true);
    expect(isNoiseText('foo.bar@sub.example.co.uk')).toBe(true);
  });
  it('正常中英文本 → false', () => {
    expect(isNoiseText('Hello world，你好。version 2.0 is out')).toBe(false);
  });
});

describe('叶子块兜底（契约 T-009：div/span 站点）', () => {
  it('推文结构：tweetText 叶子 div 入选、外围 div 排除；inline 占位符正常', () => {
    const bs = blocksOf(
      "<div class='cel'><div data-testid='tweetText'><span lang='en'>A very insightful tweet about </span><a href='/tag'>#translation</a> and engineering.</div></div>",
    );
    // 叶子只有内层 tweetText div；cel 有块级子 div → 排除
    expect(bs).toHaveLength(1);
    expect(bs[0]?.el.getAttribute('data-testid')).toBe('tweetText');
    // 叶子通道：span 展开为正文，a 仍为占位符（契约 T-009）
    expect(bs[0]?.text).toBe('A very insightful tweet about [[1]] and engineering.');
    expect(bs[0]?.placeholders[0]?.tagName).toBe('A');
  });

  it('纯 span 推文：正文完整进入翻译输入（不会退化为纯占位符）', () => {
    const tweet =
      'The most common mistake I see people make is dealing with their problems as one-offs.';
    const bs = blocksOf(
      `<div><div data-testid='tweetText'><span lang='en'>${tweet}</span></div></div>`,
    );
    expect(bs).toHaveLength(1);
    expect(bs[0]?.text).toBe(tweet);
    expect(bs[0]?.placeholders).toHaveLength(0);
  });

  it('叶子下限：<20 字符的 UI 碎文本不入选（白名单标签仍按 ≥2 生效）', () => {
    const bs = blocksOf("<div><span>ok</span></div><p>fine text here</p>");
    expect(bs).toHaveLength(1); // div 碎文本被叶子下限拦掉，p 正常
    expect(bs[0]?.el.tagName).toBe('P');
  });

  it('非叶子 div（含块级子元素）不重复入选', () => {
    const bs = blocksOf(
      "<div><section><p>outer paragraph text</p></section></div><section><div>leaf section content</div></section>",
    );
    // 第一个 div/section 有块级子 → 排除；leaf section div 入选；p 独立成块
    expect(bs).toHaveLength(2);
    expect(bs.some((b) => b.el.tagName === 'P')).toBe(true);
    expect(bs.some((b) => b.text === 'leaf section content')).toBe(true);
  });

  it('tricky：叶子 div 内的 p 已由主通道捕获，叶子层不重复加（p 占位不进叶子计数）', () => {
    // div 直接子元素含 p → 非叶子，无重复
    const bs = blocksOf('<div><p>paragraph inside a div</p></div>');
    expect(bs).toHaveLength(1);
    expect(bs[0]?.el.tagName).toBe('P');
  });

  it('叶子数量上限：blocks 总数 ≤ 600', () => {
    const leaves = Array.from({ length: 605 }, (_, i) => `<div>leaf item number ${String(i).padStart(3, '0')} with more words</div>`).join('');
    const bs = blocksOf(leaves, 'cap');
    expect(bs).toHaveLength(600);
  });

  it('已插入的 itr- 容器即使为叶子也不会被再抽取', () => {
    const bs = blocksOf(
      "<div class='itr-translation'>already inserted translation text here</div>",
    );
    expect(bs).toHaveLength(0);
  });
});

describe('splitLongText（长文本按句切分）', () => {
  it('短文本原样返回单数组', () => {
    expect(splitLongText('short')).toEqual(['short']);
  });

  it('长文本切分：每段 ≤ 4000 且拼回与原文一致', () => {
    const sentence = 'This is a sentence about translation quality testing. ';
    const text = sentence.repeat(200); // ~10800 chars
    const parts = splitLongText(text);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.join('')).toBe(text);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4000);
  });

  it('中文句号同样是切分点', () => {
    const text = `${'这是一段很长的中文内容，用来测试切分逻辑。'.repeat(300)}`;
    const parts = splitLongText(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('')).toBe(text);
  });

  it('无句边界的超长串按硬切兜底', () => {
    const text = 'a'.repeat(9000);
    const parts = splitLongText(text);
    expect(parts.join('')).toBe(text);
    expect(parts.every((p) => p.length <= 4000)).toBe(true);
  });
});

describe('extractBlocks 站点覆盖通道（契约「站点选择器覆盖」T-013）', () => {
  const X_FIXTURE = `
    <div><span>quoted short text</span></div>
    <div data-testid="tweetText"><span>Tweet body inside nested <a href="/u">@span</a> structure</span></div>
    <p>Regular paragraph that the main pass would normally catch.</p>`;

  function overrideOf(html: string, selector = '[data-testid="tweetText"]'): SegBlock[] {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    return extractBlocks(dom.window.document.body, {
      sessionId: 'test',
      isVisible: () => true,
      overrideSelector: selector,
    });
  }

  it('覆盖命中优先：tweetText 依 span 展开抽取，占位符指向链接', () => {
    const bs = overrideOf(X_FIXTURE);
    expect(bs.length).toBeGreaterThanOrEqual(1);
    const tweet = bs[0];
    expect(tweet?.el.getAttribute('data-testid')).toBe('tweetText');
    expect(tweet?.text).toBe('Tweet body inside nested [[1]] structure');
    expect(tweet?.placeholders[0]?.tagName).toBe('A');
  });

  it('根节点 translate=no 不阻断覆盖通道（主通道仍被拉黑）', () => {
    const dom = new JSDOM(`<!doctype html><body translate="no">${X_FIXTURE}</body>`);
    const bs = extractBlocks(dom.window.document.body, {
      sessionId: 'test',
      isVisible: () => true,
      overrideSelector: '[data-testid="tweetText"]',
    });
    // 主通道全黑：任何 block 都不含主通道 p 正文
    expect(
      bs.every((b) => b.text !== 'Regular paragraph that the main pass would normally catch.'),
    ).toBe(true);
    // 覆盖通道照常工作
    expect(bs[0]?.text).toContain('Tweet body inside nested');
  });

  it('嵌套去重：引用内层 tweetText 不单独成块（只取最外层，避免同文双重翻译）', () => {
    const html = `
      <div data-testid="tweetText"><span>Outer tweet full text here</span>
        <div data-testid="tweetText"><span>Inner quoted tweet</span></div>
      </div>`;
    const bs = overrideOf(html);
    expect(bs).toHaveLength(1); // 内层候选被祖先去重剔除
    expect(bs[0]?.text).toBe('Outer tweet full text here Inner quoted tweet');
    expect(bs[0]?.el.textContent).toContain('Inner quoted tweet'); // 最外层元素
  });

  it('元素自身 skip 生效：notranslate 的 tweetText 被跳过', () => {
    const bs = overrideOf(
      `<div data-testid="tweetText" class="notranslate do-not-translate">This tweet is marked notranslate</div>`,
    );
    expect(bs).toHaveLength(0);
  });

  it('边界放宽：短推文（<20）可翻，超 4000 不进通道', () => {
    const short = overrideOf('<div data-testid="tweetText"><span>so true bestie</span></div>');
    expect(short).toHaveLength(1);
    expect(short[0]?.text).toBe('so true bestie');

    const long = overrideOf(`<div data-testid="tweetText"><span>${'x'.repeat(4500)}</span></div>`);
    expect(long).toHaveLength(0);
  });
});

describe('站点级 skipSelector（契约「站点级 skipSelector」T-020：YouTube lockup 新组件）', () => {
  const YT_OVERRIDE =
    '[id="video-title"], h3.ytLockupMetadataViewModelHeadingReset, ' +
    '[id="content-text"], [id="snippet-text"]';
  const YT_SKIP =
    'ytd-video-meta-block, [class*="ytContentMetadataViewModel"], ' +
    '[class*="ytLockupMetadataViewModelMetadata"], ' +
    'ytd-rich-shelf-renderer, [class*="shortsLockupViewModel"]';

  /** /feed/trending 实测拓扑的组件族形态（2026-10-21）：标题是
   *  h3.ytLockupMetadataViewModelHeadingReset，元数据是独立
   *  ytContentMetadataViewModel / ytLockupMetadataViewModelMetadata，shorts 类名前缀小写。 */
  const YT_FIXTURE = `
    <ytd-rich-item-renderer>
      <div class="ytLockupViewModelHost content-id-1">
        <h3 class="ytLockupMetadataViewModelHeadingReset"><a>Fake Video Title Long Enough For Override</a></h3>
        <div class="ytContentMetadataViewModelHost">
          <p>Metadata Channel Row As Block Paragraph</p>
          <div><span>DWS News And DRM News 380k 3 Weeks Ago Here</span></div>
        </div>
        <div class="ytLockupMetadataViewModelTextContainer">
          <div class="ytLockupMetadataViewModelMetadata"><div>Another Channel Line 100k 5 Days Ago</div></div>
        </div>
      </div>
    </ytd-rich-item-renderer>
    <ytd-rich-shelf-renderer>
      <div class="shortsLockupViewModelHost"><div>Short Title Shelf Text Would Otherwise Be A Leaf Block</div></div>
    </ytd-rich-shelf-renderer>
    <ytd-comment-view-model>
      <div id="content-text">Comment Body Text Should Still Be Translated Normally</div>
    </ytd-comment-view-model>`;

  function ytBlocks(html: string): SegBlock[] {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    return extractBlocks(dom.window.document.body, {
      sessionId: 'test',
      isVisible: () => true,
      overrideSelector: YT_OVERRIDE,
      skipSelector: YT_SKIP,
    });
  }

  it('标题/评论照常抽取（lockup host 不在黑名单）', () => {
    const bs = ytBlocks(YT_FIXTURE);
    const texts = bs.map((b) => b.text);
    expect(texts.some((t) => t.includes('Fake Video Title'))).toBe(true);
    expect(texts.some((t) => t.includes('Comment Body Text'))).toBe(true);
  });

  it('元数据行三通道全线封杀：VM host / lockup metadata / 白名单 p / 叶子 div 均不再成块', () => {
    const bs = ytBlocks(YT_FIXTURE);
    const texts = bs.map((b) => b.text);
    expect(texts.some((t) => t.includes('Metadata Channel Row'))).toBe(false);
    expect(texts.some((t) => t.includes('DWS News And DRM News'))).toBe(false);
    expect(texts.some((t) => t.includes('Another Channel Line'))).toBe(false);
  });

  it('Short 货架整货架封杀（横向 scroller 内不得产生任何块）', () => {
    const bs = ytBlocks(YT_FIXTURE);
    expect(bs.some((b) => b.text.includes('Short Title Shelf Text'))).toBe(false);
  });

  it('无 skipSelector 时行为不变（向下兼容：老调用方零影响）', () => {
    const dom = new JSDOM(
      `<!doctype html><body><div class="ytContentMetadataViewModelHost">
         <div><span>DWS News And DRM News 380k 3 Weeks Ago Here</span></div>
       </div><a id="video-title"><span>Fake Video Title Long Enough For Override</span></a></body>`,
    );
    const bs = extractBlocks(dom.window.document.body, {
      sessionId: 'test',
      isVisible: () => true,
      overrideSelector: YT_OVERRIDE,
      // 不传 skipSelector：元数据行应由叶子兜底通道抽出（旧行为）
    });
    expect(bs.some((b) => b.text.includes('DWS News And DRM News'))).toBe(true);
  });

  it('覆盖通道降内联（T-020）：整块被单链接吞掉 → 平铺成正文可翻', () => {
    // 新 lockup 标题真形态：<h3 class=...><a><span>全文</span></a></h3>
    const dom = new JSDOM(
      `<!doctype html><body>
        <h3 class="ytLockupMetadataViewModelHeadingReset">
          <a href="/v"><span>Fake Video Title Long Enough For Override</span></a>
        </h3>
        <div data-testid="tweetText">Text with [[1]]-like link <a href="/u">@mention</a> inside keeps placeholders</div>
      </body>`,
    );
    const bs = extractBlocks(dom.window.document.body, {
      sessionId: 'test',
      isVisible: () => true,
      overrideSelector: YT_OVERRIDE,
      skipSelector: YT_SKIP,
    });
    const title = bs.find((b) => b.text.includes('Fake Video Title'));
    expect(title).toBeDefined(); // 平铺后不再是 [[1]] 空块被弃
    // 混排文本（有裸文本兜着）不受降内联影响：链接仍进占位符
    const tweet = bs.find((b) => b.text.includes('Text with'));
    expect(tweet?.text).toContain('[[1]]');
    expect(tweet?.placeholders[0]?.tagName).toBe('A');
  });
});

describe('T-020b（契约：watch 拓扑根修：custom element / 覆盖宿主叶子跳过 / Skip #7 / #player）', () => {
  const YT_OVERRIDE_T20B =
    '[id="video-title"], h3.ytLockupMetadataViewModelHeadingReset, ' +
    '[id="content-text"], [id="snippet-text"], ' +
    'yt-attributed-string.ytd-text-inline-expander>span';
  const YT_SKIP_T20B =
    '#player, ytd-video-meta-block, [class*="ytContentMetadataViewModel"], ' +
    '[class*="ytLockupMetadataViewModelMetadata"], ' +
    'ytd-rich-shelf-renderer, [class*="shortsLockupViewModel"]';

  function extract(
    html: string,
    opts: { overrideSelector?: string; skipSelector?: string } = {},
  ): SegBlock[] {
    const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
    return extractBlocks(dom.window.document.body, {
      sessionId: 't20b',
      isVisible: () => true,
      ...opts,
    });
  }

  it('custom element 直接子视为块级：watch 侧栏 #contents 不再被当叶子整树吞（时长戳成对根因）', () => {
    // watch 拓扑实锤形态：#contents 直接子全是 ytd-*
    const html = `
      <div id="contents"><ytd-item-section-renderer><ytd-video-renderer>
        <a id="video-title"><span>15:05 Steve Jobs Stanford Commencement</span></a>
      </ytd-video-renderer></ytd-item-section-renderer></div>`;
    const bs = extract(html);
    // 此前：#contents 被误判叶子 → 整树 text 一锅端；根修后不再产生该块
    expect(bs).toHaveLength(0);
  });

  it('lockup 真实解剖（watch-lockup-html.json 定名）：metadata div（直接子全 custom element）不再叶子整吞；标题 override 存活', () => {
    const html = `
      <yt-lockup-view-model>
        <div class="ytLockupViewModelHost ytLockupViewModelCompact">
          <yt-touch-feedback-shape class="ytSpecTouchFeedbackShapeHost"></yt-touch-feedback-shape>
          <a class="ytLockupViewModelContentImage"><yt-thumbnail-view-model></yt-thumbnail-view-model></a>
          <div class="ytLockupViewModelMetadata">
            <yt-lockup-metadata-view-model class="ytLockupMetadataViewModelHost">
              <div class="ytLockupMetadataViewModelTextContainer">
                <h3 class="ytLockupMetadataViewModelHeadingReset">
                  <a href="/watch">Sidebar Title Real Anatomy Long Enough Text</a>
                </h3>
              </div>
            </yt-lockup-metadata-view-model>
          </div>
        </div>
      </yt-lockup-view-model>`;
    const bs = extract(html, { overrideSelector: YT_OVERRIDE_T20B, skipSelector: YT_SKIP_T20B });
    // 此前：metadata div 被当叶子 → 标题+元数据一锅炖出第二块（右栏灰底重复行根因）。
    // 根修后：只剩 h3 override 标题块；metadata（作者/播放量/时间）无翻译价值不产出。
    expect(bs).toHaveLength(1);
    expect(bs[0]?.el.tagName).toBe('H3');
    expect(bs[0]?.text).toContain('Sidebar Title');
  });

  it('叶子候选内部命中覆盖目标 → 整块放弃（watch #snippet 与 #snippet-text 重复翻译根因）', () => {
    const html = `
      <ytd-text-inline-expander id="description-inline-expander">
        <div id="snippet"><span id="snippet-text">The official video description text is long enough here</span></div>
      </ytd-text-inline-expander>`;
    const bs = extract(html, { overrideSelector: YT_OVERRIDE_T20B });
    // 覆盖目标 #snippet-text 单独成块；#snippet 叶子不再重复吞整段
    expect(bs).toHaveLength(1);
    expect(bs[0]?.el.getAttribute('id')).toBe('snippet-text');
  });

  it('覆盖目标自身被站点 skip 命中时，叶子兜底仍保留（防「唯一可读文本」漏翻）', () => {
    // 场景：span 命中站点 skip（若走 override 通道会被弃）→ 叶子 guard 判定
    // siteSkipped(ovHost) 成立 → 整块兜底抽取不放弃
    const html = `
      <div><span id="snippet-text" class="ytContentMetadataViewModelRow">Marked Untranslatable Long Enough Snippet</span></div>`;
    const bs = extract(html, {
      overrideSelector: YT_OVERRIDE_T20B,
      skipSelector: YT_SKIP_T20B,
    });
    expect(bs.some((b) => b.text.includes('Marked Untranslatable'))).toBe(true);
  });

  it('Skip #5 天然覆盖独立时长戳块：「1:36」纯数字块不产出（H3 保险实为既有规则，无需新实现）', () => {
    const bs = extract('<p>1:36</p><p>0:05 intro chapter text normally stays</p>');
    expect(bs).toHaveLength(1);
    expect(bs[0]?.text).toContain('intro chapter');
  });

  it('#player 子树整段封杀：卡片/结尾覆盖层/播放器容器后不再有容器锚点（视频挤压根因）', () => {
    const html = `
      <ytd-player id="player">
        <div id="container"><div id="player-container"><div class="ytp-cards-teaser">
          <div class="ytp-cards-teaser-text">Rick Astley Cards Teaser Long Enough Text</div>
        </div></div></div>
      </ytd-player>
      <p>Outside Player Normal Paragraph Text</p>`;
    const bs = extract(html, {
      overrideSelector: YT_OVERRIDE_T20B,
      skipSelector: YT_SKIP_T20B,
    });
    expect(bs).toHaveLength(1);
    expect(bs[0]?.text).toBe('Outside Player Normal Paragraph Text');
  });

  it('watch 描述精确目标：yt-attributed-string.ytd-text-inline-expander>span 钉住 span 层', () => {
    const html = `
      <ytd-text-inline-expander id="description-inline-expander" class="ytd-text-inline-expander">
        <yt-attributed-string class="ytd-text-inline-expander">
          <span>The official video for Never Gonna Give You Up by Rick Astley.</span>
        </yt-attributed-string>
      </ytd-text-inline-expander>`;
    const bs = extract(html, { overrideSelector: YT_OVERRIDE_T20B });
    expect(bs).toHaveLength(1);
    expect(bs[0]?.el.tagName).toBe('SPAN');
    expect(bs[0]?.text).toContain('The official video');
  });
});
