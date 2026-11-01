// T-018：语言/文字体系工具单测（契约 segmentation.md Skip #6 + translation-provider.md「语言分桶」）
import { describe, expect, it } from 'vitest';
import { dominantScript, isTargetLangText, scriptCounts } from '../../../src/shared/lang';

describe('scriptCounts', () => {
  it('分别计汉字/假名/谚文/拉丁，其他字符不计', () => {
    expect(scriptCounts('中文abcカナ')).toEqual({ han: 2, kana: 2, hangul: 0, latin: 3 });
    expect(scriptCounts('한국어')).toEqual({ han: 0, kana: 0, hangul: 3, latin: 0 });
    expect(scriptCounts('1234 ：、。')).toEqual({ han: 0, kana: 0, hangul: 0, latin: 0 });
    expect(scriptCounts('')).toEqual({ han: 0, kana: 0, hangul: 0, latin: 0 });
  });
});

describe('dominantScript', () => {
  it('CJK 覆拉丁 → cjk；纯拉丁 → latin；无字 → other', () => {
    expect(dominantScript('Anthropic 在准备一款全新的中文模型，据说它也能猜到你要的内容')).toBe('cjk');
    expect(dominantScript('hello world 123')).toBe('latin');
    expect(dominantScript('これは日本語です')).toBe('cjk');
    expect(dominantScript('한국어 텍스트')).toBe('cjk');
    expect(dominantScript('1234 %$#')).toBe('other');
  });
});

describe('isTargetLangText（Skip #6）', () => {
  const zh = 'zh-CN';

  it('中文推文（含英文品牌词）→ 已是目标语言', () => {
    expect(isTargetLangText('The Information：Anthropic 在准备一款全新模型，据说话说一半它也能猜到你要什么，这故事越来越有趣了', zh)).toBe(true);
    expect(isTargetLangText('这是一条完整的中文内容，不必再翻译一遍就可以直接跳过。', zh)).toBe(true);
  });

  it('纯英文 → 需要翻译', () => {
    expect(isTargetLangText('Why do people follow up on this topic so quickly today?', zh)).toBe(false);
  });

  it('混批里的英文长句 + 少量中文字 → 仍判英文（汉字数 < 拉丁数）', () => {
    expect(isTargetLangText('This is an English sentence with only one or two Chinese words here', zh)).toBe(false);
  });

  it('短文本（CJK < 4）不判，避免碎文本误跳', () => {
    expect(isTargetLangText('AI 中文', zh)).toBe(false);
    expect(isTargetLangText('中文', zh)).toBe(false);
  });

  it('日文（有假名）对 zh 目标不跳过；对 ja 目标跳过', () => {
    const ja = 'これは日本語のテキストです、翻訳が必要です。';
    expect(isTargetLangText(ja, 'zh-CN')).toBe(false);
    expect(isTargetLangText(ja, 'ja')).toBe(true);
  });

  it('谚文对 zh 不跳过；对 ko 跳过', () => {
    const ko = '한국어 텍스트가 여기에 있습니다 번역이 필요합니다';
    expect(isTargetLangText(ko, 'zh-CN')).toBe(false);
    expect(isTargetLangText(ko, 'ko')).toBe(true);
  });

  it('拉丁语系目标：不做命中判定（v0 范围外）', () => {
    expect(isTargetLangText('hello world', 'en')).toBe(false);
  });
});
