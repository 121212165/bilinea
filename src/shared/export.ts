// 字幕导出产物构建（T-026 / M3-3，契约 subtitles.md「导出」节 + messaging.md 下载通道）
// 纯函数；下载经 popup 页 anchor+blob（content 不触下载 API），无新增依赖/权限。

export interface TranscriptMeta {
  title: string;
}

export interface TranscriptPair {
  src: string;
  dst: string;
}

const FILENAME_FALLBACK = 'itr-subtitles';
const TRANSCRIPT_CAP = 5000;

/** 折叠内部换行与多余空白（字幕采样与译文均按单行对待） */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** 文件名清洗：非法字符 → 空格，60 字截断，空标题降级 */
export function buildFilename(title: string): string {
  const cleaned = title
    .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return cleaned || FILENAME_FALLBACK;
}

/** Markdown 双语字幕稿：标题 + 可选「AI 简述」节 + 编号列表（原文行 / → 译文行） */
export function buildMarkdown(meta: TranscriptMeta, pairs: TranscriptPair[], summary?: string): string {
  const lines: string[] = [];
  lines.push(`# ${oneLine(meta.title) || '字幕'}`, '');
  if (summary) {
    lines.push('## AI 简述', '', summary.trim(), '');
  }
  lines.push(`## 双语字幕（${pairs.length} 条）`, '');
  const capped = pairs.slice(0, TRANSCRIPT_CAP);
  capped.forEach((p, i) => {
    lines.push(`${i + 1}. ${oneLine(p.src)}`);
    lines.push(`   → ${oneLine(p.dst)}`);
  });
  return `${lines.join('\n')}\n`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** standalone HTML（自带轻样式，双击可读）；src/dst 全量 escape 防注入 */
export function buildHtml(meta: TranscriptMeta, pairs: TranscriptPair[], summary?: string): string {
  const title = escapeHtml(oneLine(meta.title) || '字幕');
  const capped = pairs.slice(0, TRANSCRIPT_CAP);
  const items = capped
    .map(
      (p) =>
        `  <li><p class="src">${escapeHtml(oneLine(p.src))}</p><p class="dst">${escapeHtml(
          oneLine(p.dst),
        )}</p></li>`,
    )
    .join('\n');
  const summaryHtml = summary
    ? `  <section class="summary"><h2>AI 简述</h2><p>${escapeHtml(
        summary.trim().replace(/\s+/g, ' '),
      )}</p></section>\n`
    : '';
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    '<style>',
    "body{font:15px/1.6 system-ui,'Segoe UI','Microsoft YaHei',sans-serif;max-width:760px;margin:0 auto;padding:24px;color:#222}",
    'h1{font-size:22px}',
    '.summary{background:#f4f5f7;border-radius:8px;padding:12px 16px}',
    '.src{margin:0;color:#666}',
    '.dst{margin:0 0 10px}',
    '</style>',
    '</head>',
    '<body>',
    `<h1>${title}</h1>`,
    `${summaryHtml}<ol>`,
    items,
    '</ol>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * popup 页 anchor+blob 触发下载；返回 false = 环境无 createObjectURL（降级提示）。
 */
export function downloadText(doc: Document, filename: string, content: string, mime = 'text/plain'): boolean {
  const view = doc.defaultView;
  const urlCtor = view?.URL;
  const create = urlCtor?.createObjectURL;
  if (!view || !urlCtor || typeof create !== 'function') return false;
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = create.call(urlCtor, blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  (doc.body ?? doc.documentElement).append(a);
  a.click();
  a.remove();
  const revoke = urlCtor.revokeObjectURL;
  if (typeof revoke === 'function') {
    // 延迟回收：Firefox/Chrome 需要点击处理完成后再 revoke
    view.setTimeout(() => revoke.call(urlCtor, url), 5000);
  }
  return true;
}

/** AI 简述输入：全部 pair 的原文行拼接并按 SUMMARY_MAX_CHARS 截断（调用方守常量） */
export function flattenTranscript(
  pairs: ReadonlyArray<TranscriptPair>,
  maxChars: number,
): string {
  return pairs
    .map((p) => oneLine(p.src))
    .filter(Boolean)
    .join('\n')
    .slice(0, maxChars);
}
