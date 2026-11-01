// 关键帧纯函数层（T-027 / M3-4，契约 subtitles.md「关键帧绑定」+ messaging.md「关键帧通道」）。
// 无副作用；capture/存储在 SW 层（service/keyframes.ts），下载在 popup（anchor+blob）。

import { buildFilename } from './export';

/** 关键帧记录（契约 subtitles.md「记录形状」） */
export interface KeyframeRecord {
  /** kf-<uuid>（SW 生成） */
  id: string;
  /** URL `v` 参数；取不到 → ''（导出与分组归并 unknown） */
  videoId: string;
  /** 秒（<video>.currentTime，触发瞬间）；null = 无视频上下文（随手帧） */
  videoTime: number | null;
  /** 触发瞬间的当前上屏字幕对（无字幕 ''） */
  src: string;
  dst: string;
  /** captureVisibleTab jpeg q70 dataURL（只存 SW、读 popup） */
  jpeg: string;
  /** epoch ms */
  createdAt: number;
}

/** TabAction CAPTURE_KEYFRAME 的同步上下文回包 + Rpc CAPTURE_KEYFRAME 请求体的共享形状 */
export interface KeyframeContext {
  videoId: string;
  videoTime: number | null;
  src: string;
  dst: string;
}

/** 空上下文（热键无接收端 / 非视频页随手帧） */
export function emptyKeyframeContext(): KeyframeContext {
  return { videoId: '', videoTime: null, src: '', dst: '' };
}

/** storage.local 单键（契约「放弃每 videoId 一键候选，定稿单键」） */
export const KEYFRAME_STORE_KEY = 'itr-kf-store';

/** 存储值形状 */
export interface KeyframeStoreValue {
  frames: KeyframeRecord[];
}

export function emptyKeyframeStore(): KeyframeStoreValue {
  return { frames: [] };
}

/** LRU 上限（拍板：≥100 帧全局面，跨视频按插入序旧者先出） */
export const KEYFRAME_CAP = 100;

/** videoId 分组键：空 videoId 归并 unknown */
export function videoGroupKey(videoId: string): string {
  return videoId.trim() || 'unknown';
}

/**
 * 秒表时间戳：分钟不封顶（01:07 / 75:03），秒向下取整；
 * null / 负值 / 非有限值 → '--:--'。
 */
export function formatTs(videoTime: number | null | undefined): string {
  if (typeof videoTime !== 'number' || !Number.isFinite(videoTime) || videoTime < 0) return '--:--';
  const total = Math.floor(videoTime);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

/** 内部折行折叠（与字幕导出同规范：样本/译文均按单行对待） */
function oneLineText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 按 videoId 分组（保持插入序）；分组内同样保持插入序 */
export function groupByVideo(frames: ReadonlyArray<KeyframeRecord>): Map<string, KeyframeRecord[]> {
  const groups = new Map<string, KeyframeRecord[]>();
  for (const f of frames) {
    const key = videoGroupKey(f.videoId);
    const list = groups.get(key);
    if (list) list.push(f);
    else groups.set(key, [f]);
  }
  return groups;
}

/** createdAt epoch ms → 当地时间（HH:MM:SS） */
function localTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function cap(frames: ReadonlyArray<KeyframeRecord>): KeyframeRecord[] {
  return frames.slice(0, KEYFRAME_CAP);
}

/**
 * 内嵌图 MD（契约）：# 关键帧（N 帧） + 分组节 ## videoId（k 帧） +
 * 每帧 ### <mm:ss> · <HH:MM:SS> + 内嵌 jpeg + src/文言行（空省略）。
 */
export function buildKeyframesMarkdown(frames: ReadonlyArray<KeyframeRecord>): string {
  const list = cap(frames);
  const lines: string[] = [`# 关键帧（${list.length} 帧）`, ''];
  for (const [videoId, group] of groupByVideo(list)) {
    lines.push(`## ${videoId}（${group.length} 帧）`, '');
    for (const f of group) {
      const ts = formatTs(f.videoTime);
      lines.push(`### ${ts} · ${localTime(f.createdAt)}`, '');
      lines.push(`![${ts} 关键帧](${f.jpeg})`, '');
      const src = oneLineText(f.src);
      const dst = oneLineText(f.dst);
      if (src) lines.push(`- src：${src}`);
      if (dst) lines.push(`- 译文：${dst}`);
      if (src || dst) lines.push('');
    }
  }
  return `${lines.join('\n')}\n`;
}

/** 导出文件名（多视频取首帧 videoId） */
export function keyframesFilename(frames: ReadonlyArray<KeyframeRecord>): string {
  const first = frames[0];
  const videoId = first ? videoGroupKey(first.videoId) : 'unknown';
  return `${buildFilename(`itr-keyframes-${videoId}`)}.md`;
}

/**
 * 纯时间戳清单（契约）：同分组结构，每帧一行 `mm:ss · src`（src 空则只 mm:ss）。
 */
export function buildTimestampList(frames: ReadonlyArray<KeyframeRecord>): string {
  const list = cap(frames);
  const lines: string[] = [`# 关键帧时间戳（${list.length} 帧）`, ''];
  for (const [videoId, group] of groupByVideo(list)) {
    lines.push(`## ${videoId}（${group.length} 帧）`, '');
    for (const f of group) {
      const src = oneLineText(f.src);
      lines.push(src ? `${formatTs(f.videoTime)} · ${src}` : formatTs(f.videoTime));
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

/** URL `v` 参数解析（YT watch；取不到 → ''） */
export function parseVideoId(href: string): string {
  try {
    return new URL(href).searchParams.get('v') ?? '';
  } catch {
    return '';
  }
}
