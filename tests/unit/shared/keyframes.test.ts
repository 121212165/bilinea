// T-027 / M3-4 关键帧纯函数（契约 subtitles.md「关键帧绑定」+ messaging.md「关键帧通道」）
import { describe, expect, it } from 'vitest';
import {
  buildKeyframesMarkdown,
  buildTimestampList,
  emptyKeyframeContext,
  formatTs,
  groupByVideo,
  keyframesFilename,
  KEYFRAME_CAP,
  parseVideoId,
  videoGroupKey,
  type KeyframeRecord,
} from '../../../src/shared/keyframes';

const JPEG = 'data:image/jpeg;base64,AAAA';

function frame(partial: Partial<KeyframeRecord>): KeyframeRecord {
  return {
    id: partial.id ?? 'kf-1',
    videoId: partial.videoId ?? 'v1',
    videoTime: partial.videoTime ?? 75.4,
    src: partial.src ?? 'hello',
    dst: partial.dst ?? '译：hello',
    jpeg: partial.jpeg ?? JPEG,
    createdAt: partial.createdAt ?? 1769500800000,
  };
}

describe('formatTs（契约：mm:ss 秒表格式，分钟不封顶）', () => {
  it('0 / 75.4 / 越小时的值', () => {
    expect(formatTs(0)).toBe('00:00');
    expect(formatTs(75.4)).toBe('01:15'); // 向下取整
    expect(formatTs(61.9)).toBe('01:01');
    expect(formatTs(4500)).toBe('75:00'); // 分钟不封顶
  });

  it('null / 负值 / 非有限值 → --:--（随手帧语义）', () => {
    expect(formatTs(null)).toBe('--:--');
    expect(formatTs(undefined)).toBe('--:--');
    expect(formatTs(-1)).toBe('--:--');
    expect(formatTs(Number.NaN)).toBe('--:--');
    expect(formatTs(Number.POSITIVE_INFINITY)).toBe('--:--');
  });
});

describe('videoId 解析与分组', () => {
  it('parseVideoId：watch 链接取 v 参数；缺参/坏链接 → 空', () => {
    expect(parseVideoId('https://www.youtube.com/watch?v=abc&x=1')).toBe('abc');
    expect(parseVideoId('https://www.youtube.com/feed/subscriptions')).toBe('');
    expect(parseVideoId('not a url')).toBe('');
  });

  it('videoGroupKey：空 → unknown；trim 生效', () => {
    expect(videoGroupKey('')).toBe('unknown');
    expect(videoGroupKey('  v9  ')).toBe('v9');
  });

  it('groupByVideo：插入序 + unknown 归并', () => {
    const groups = groupByVideo([frame({ videoId: 'a' }), frame({ videoId: '' }), frame({ id: 'k2', videoId: 'a' })]);
    expect([...groups.keys()]).toEqual(['a', 'unknown']);
    expect(groups.get('a')).toHaveLength(2);
    expect(groups.get('unknown')).toHaveLength(1);
  });
});

describe('buildKeyframesMarkdown（内嵌图 MD）', () => {
  it('标题 + 分组节 + mm:ss 小节 + 内嵌 jpeg + src/文言行', () => {
    const md = buildKeyframesMarkdown([
      frame({ videoTime: 75.4, src: 'hello\n world', dst: '译：hello' }),
      frame({ id: 'k2', videoId: '', videoTime: 2, src: '', dst: '' }),
    ]);
    expect(md).toContain('# 关键帧（2 帧）');
    expect(md).toContain('## v1（1 帧）');
    expect(md).toContain('## unknown（1 帧）');
    expect(md).toContain('### 01:15 ·');
    expect(md).toContain(`![01:15 关键帧](${JPEG})`);
    expect(md).toContain('- src：hello world'); // 内部换行折叠
    expect(md).toContain('- 译文：译：hello');
    expect(md).toContain('### 00:02 ·');
  });

  it('空 src/dst 行整行省略（仅图与时间头部）', () => {
    const md = buildKeyframesMarkdown([frame({ src: '', dst: '' })]);
    expect(md).not.toContain('- src：');
    expect(md).not.toContain('- 译文：');
  });

  it('导出面固定截前 100 帧（KEYFRAME_CAP）', () => {
    const many = Array.from({ length: KEYFRAME_CAP + 5 }, (_, i) => frame({ id: `k${i}`, videoTime: i }));
    const md = buildKeyframesMarkdown(many);
    expect(md).toContain(`# 关键帧（${KEYFRAME_CAP} 帧）`);
    const list = buildTimestampList(many);
    expect(list).toContain(`# 关键帧时间戳（${KEYFRAME_CAP} 帧）`);
  });
});

describe('buildTimestampList（纯时间戳清单）', () => {
  it('行格式 mm:ss · src；src 空 → 只 mm:ss', () => {
    const list = buildTimestampList([
      frame({ videoTime: 61, src: 'second line text' }),
      frame({ id: 'k2', videoTime: 3, src: '' }),
    ]);
    expect(list).toContain('01:01 · second line text');
    expect(list).toContain('\n00:03\n');
  });
});

describe('文件名与空上下文', () => {
  it('keyframesFilename 首帧 videoId + 清洗降级', () => {
    expect(keyframesFilename([frame({ videoId: 'abc_DEF-9' })])).toBe('itr-keyframes-abc_DEF-9.md');
    expect(keyframesFilename([])).toBe('itr-keyframes-unknown.md');
  });

  it('emptyKeyframeContext：全空（随手帧语义）', () => {
    expect(emptyKeyframeContext()).toEqual({ videoId: '', videoTime: null, src: '', dst: '' });
  });
});
