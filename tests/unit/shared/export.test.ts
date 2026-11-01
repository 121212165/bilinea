// T-026 字幕导出产物纯函数（契约 subtitles.md「导出」节 + messaging.md 下载通道）
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  buildFilename,
  buildHtml,
  buildMarkdown,
  downloadText,
  flattenTranscript,
} from '../../../src/shared/export';

describe('export · buildFilename', () => {
  it('清洗非法字符并折叠空白、截 60 字', () => {
    expect(buildFilename('我的"视频": 第一部?')).toBe('我的 视频 第一部');
    expect(buildFilename('  line\r\nbreak  ')).toBe('line break');
    expect(buildFilename('x'.repeat(80)).length).toBe(60);
  });
  it('空标题降级 fallback', () => {
    expect(buildFilename('***')).toBe('itr-subtitles');
    expect(buildFilename('')).toBe('itr-subtitles');
  });
});

describe('export · buildMarkdown', () => {
  const pairs = [
    { src: 'hello world', dst: '译：hello world' },
    { src: 'second\nline', dst: '第二行' },
  ];
  it('标题 + 编号列表 + → 译文行；段内换行折叠', () => {
    const md = buildMarkdown({ title: '测试标题' }, pairs);
    expect(md).toContain('# 测试标题\n');
    expect(md).toContain('1. hello world\n   → 译：hello world');
    expect(md).toContain('2. second line'); // 段内换行折叠
    expect(md).toContain('## 双语字幕（2 条）');
    expect(md).not.toContain('## AI 简述');
  });
  it('带 AI 简述节；空标题降级为「字幕」', () => {
    const md = buildMarkdown({ title: '' }, pairs, '要点一。要点二。');
    expect(md.startsWith('# 字幕\n')).toBe(true);
    expect(md).toContain('## AI 简述\n\n要点一。要点二。');
    expect(md).toContain('## 双语字幕（2 条）');
  });
});

describe('export · buildHtml', () => {
  const pairs = [{ src: '<b>bold</b>', dst: '安全"' }];
  it('standalone 结构 + escape 防注入；summary 节可选', () => {
    const html = buildHtml({ title: '<标题>' }, pairs, '简述内容');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<title>&lt;标题&gt;</title>');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toMatch(/<b>bold<\/b>/);
    expect(html).toContain('&quot;');
    expect(html).toContain('<section class="summary">');
    expect(html).toContain('<p>简述内容</p>');
  });
  it('无简述即无 summary 节', () => {
    const html = buildHtml({ title: 'T' }, pairs);
    expect(html).not.toContain('class="summary"');
    expect(html).toContain('<li><p class="src">&lt;b&gt;bold&lt;/b&gt;</p><p class="dst">安全&quot;</p></li>');
  });
});

describe('export · flattenTranscript', () => {
  it('原文行拼接（逐行折叠空白）+ 截断', () => {
    const pairs = [
      { src: 'a\n b', dst: 'x' },
      { src: '  c  ', dst: 'y' },
      { src: '   ', dst: 'z' }, // 空行剔除
    ];
    expect(flattenTranscript(pairs, 100)).toBe('a b\nc');
    expect(flattenTranscript([{ src: 'x'.repeat(20), dst: '' }], 10)).toBe('x'.repeat(10));
  });
});

describe('export · downloadText', () => {
  it('环境无 createObjectURL → 返回 false（降级路径）', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    expect(downloadText(dom.window.document, 'a.md', 'content')).toBe(false);
  });

  it('anchor+blob 下载：临时 <a download> 点击后即移除（download/href 由点击时捕获）', () => {
    const dom = new JSDOM('<!doctype html><body></body>');
    const win = dom.window as unknown as {
      URL: Record<string, unknown>;
      HTMLAnchorElement: { prototype: HTMLAnchorElement };
    };
    let created = 0;
    win.URL.createObjectURL = (): string => {
      created += 1;
      return 'blob:mock-1';
    };
    win.URL.revokeObjectURL = (): void => undefined;
    // 记录点击时刻的 download/href；阻止 jsdom 导航（navigation not implemented 噪声）
    const clicked: Array<{ download: string | null; href: string | null }> = [];
    win.HTMLAnchorElement.prototype.click = function testClick(this: HTMLAnchorElement): void {
      clicked.push({ download: this.getAttribute('download'), href: this.getAttribute('href') });
    };
    const doc = dom.window.document;
    expect(downloadText(doc, '稿.md', '# 内容', 'text/markdown')).toBe(true);
    expect(created).toBe(1);
    expect(clicked).toEqual([{ download: '稿.md', href: 'blob:mock-1' }]);
    // 点击后临时 anchor 已移除（不留痕迹节点）
    expect(doc.querySelectorAll('a[download]')).toHaveLength(0);
  });
});
