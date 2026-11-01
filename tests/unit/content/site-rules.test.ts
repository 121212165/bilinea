// 站点选择器覆盖表单测（契约 segmentation.md「站点选择器覆盖」T-013/T-014）
import { describe, expect, it } from 'vitest';
import { findSiteOverride, isXHost, isYouTubeHost } from '../../../src/content/site-rules';

describe('site-rules（站点覆盖表）', () => {
  it('isXHost：x.com / twitter.com 及子域命中，前缀伪装/后缀拼贴不命中', () => {
    expect(isXHost('x.com')).toBe(true);
    expect(isXHost('twitter.com')).toBe(true);
    expect(isXHost('mobile.twitter.com')).toBe(true);
    expect(isXHost('www.x.com')).toBe(true);
    expect(isXHost('notx.com')).toBe(false);
    expect(isXHost('x.com.evil.io')).toBe(false);
    expect(isXHost('example.com')).toBe(false);
  });

  it('isYouTubeHost：youtube.com 及子域命中，nocookie 也是，伪装不命中', () => {
    expect(isYouTubeHost('youtube.com')).toBe(true);
    expect(isYouTubeHost('www.youtube.com')).toBe(true);
    expect(isYouTubeHost('m.youtube.com')).toBe(true);
    expect(isYouTubeHost('music.youtube.com')).toBe(true);
    expect(isYouTubeHost('youtube-nocookie.com')).toBe(true);
    expect(isYouTubeHost('notyoutube.com')).toBe(false);
    expect(isYouTubeHost('youtube.com.evil.io')).toBe(false);
  });

  it('findSiteOverride：X → 选择器覆盖；YouTube → 选择器+skip 黑名单（T-017/T-020）；其他站 → null', () => {
    const x = findSiteOverride('x.com');
    expect(x?.selector).toBe('[data-testid="tweetText"]');

    const yt = findSiteOverride('www.youtube.com');
    expect(yt?.selector).toContain('[id="video-title"]');
    expect(yt?.selector).toContain('h3.ytLockupMetadataViewModelHeadingReset');
    // T-020b：watch 页描述精确目标（kiss 钉法）+ 播放器整棵子树黑名单
    expect(yt?.selector).toContain('yt-attributed-string.ytd-text-inline-expander>span');
    expect(yt?.skipSelector).toContain('#player');
    // T-020：新 lockup 组件族的元数据行 + Short 货架进站点黑名单
    expect(yt?.skipSelector).toContain('ytContentMetadataViewModel');
    expect(yt?.skipSelector).toContain('ytLockupMetadataViewModelMetadata');
    expect(yt?.skipSelector).toContain('ytd-rich-shelf-renderer');
    expect(yt?.skipSelector).toContain('shortsLockupViewModel');

    expect(findSiteOverride('example.com')).toBeNull();
  });
});
