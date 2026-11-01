// 站点选择器覆盖表（契约 segmentation.md「站点选择器覆盖」）
// 站点规则：按域名给 X 等 SPA 站点补选择器与等待策略。
// 强定制站点用 data-testid 选择器直取，避免通用规则漏覆盖。
export interface SiteOverride {
  /** 域名匹配（location.hostname） */
  test: (host: string) => boolean;
  /** 覆盖候选选择器（命中即优先提取，无视祖先 skip）；不配 = 无选择器覆盖 */
  selector?: string;
  /** 站点级抽取黑名单（T-020）：closest 命中即整块跳过，三通道统一生效 */
  skipSelector?: string;
}

export function isXHost(host: string): boolean {
  return /(^|\.)(twitter\.com|x\.com)$/i.test(host);
}

export function isYouTubeHost(host: string): boolean {
  return /(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(host);
}

export const SITE_OVERRIDES: SiteOverride[] = [
  {
    test: isXHost,
    selector: '[data-testid="tweetText"]',
  },
  {
    test: isYouTubeHost,
    // T-017：恢复 YouTube 整页翻译（标题/评论区）；T-020 补新 lockup 标题节点；
    // T-020b watch 页描述精确目标（kiss 订阅规则同款钉法）：钉住 span 层以避免吞噬
    // ytd-text-inline-expander 宿主（宿主被吞会连同折叠态 snippet 一起成块，与
    // #snippet-text 覆盖目标重复翻译）。
    selector:
      '[id="video-title"], h3.ytLockupMetadataViewModelHeadingReset, ' +
      '[id="content-text"], [id="snippet-text"], ' +
      'yt-attributed-string.ytd-text-inline-expander>span',
    // T-020（契约 segmentation.md「站点级 skipSelector」，/feed/trending 拓扑采样定名）：
    // 元数据行（作者/播放量/时间）无翻译价值且会以第二行形式重复；Short 货架是
    // 横向 scroller，插入块级容器会挤爆条目（用户实测巨圆）。
    // T-020b 补 #player（watch 拓扑实锤：播放器子树 6 个容器，最重者把块级译文
    // 插进 #player-container 后面，视频被压成扁条——「视频区挤压」根因）。
    skipSelector:
      '#player, ' +
      'ytd-video-meta-block, [class*="ytContentMetadataViewModel"], ' +
      '[class*="ytLockupMetadataViewModelMetadata"], ' +
      'ytd-rich-shelf-renderer, [class*="shortsLockupViewModel"]',
  },
];

export function findSiteOverride(host: string): SiteOverride | null {
  return SITE_OVERRIDES.find((r) => r.test(host)) ?? null;
}
