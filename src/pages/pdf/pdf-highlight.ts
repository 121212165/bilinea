// T-030 PDF 阅读页拆分：CSS Custom Highlight 与「去空白字符偏移」工具。
// 不改 pdf.js text layer DOM；标记只登记 Range。

export interface SpanRun {
  node: Text;
  normStart: number;
  normEnd: number;
  /** 归一化下标 → 节点内原始下标 */
  map: number[];
}

export interface HighlightApi {
  ctor: new (...ranges: Range[]) => unknown;
  registry: Map<string, unknown>;
}

export function highlightApi(): HighlightApi | null {
  const ctor = (window as unknown as { Highlight?: HighlightApi['ctor'] }).Highlight;
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  if (!ctor || !registry) return null;
  return { ctor, registry };
}

export function clearHighlightRegistry(): void {
  const api = highlightApi();
  if (!api) return;
  api.registry.delete('itr-mark-src');
  api.registry.delete('itr-mark-dst');
}

export function setHighlightRanges(api: HighlightApi, name: string, ranges: Range[]): void {
  if (ranges.length === 0) {
    api.registry.delete(name);
    return;
  }
  api.registry.set(name, new api.ctor(...ranges));
}

export function normOffsetAt(runs: SpanRun[], node: Node, rawOffset: number): number | null {
  if (!(node instanceof Text)) return null;
  const run = runs.find((item) => item.node === node);
  if (!run) return null;
  const before = node.data.slice(0, Math.max(0, rawOffset)).replace(/\s+/g, '').length;
  return run.normStart + before;
}

export function textRun(node: Text, start: number): SpanRun | null {
  const map: number[] = [];
  for (let i = 0; i < node.data.length; i++) {
    if (!/\s/.test(node.data[i] ?? '')) map.push(i);
  }
  if (map.length === 0) return null;
  return { node, normStart: start, normEnd: start + map.length, map };
}

export function rangeFromRuns(runs: SpanRun[], start: number, end: number): Range | null {
  if (end <= start) return null;
  const startRun = runs.find((run) => start >= run.normStart && start < run.normEnd);
  const endRun = runs.find((run) => end - 1 >= run.normStart && end - 1 < run.normEnd);
  if (!startRun || !endRun) return null;
  const startIndex = startRun.map[start - startRun.normStart];
  const endIndex = endRun.map[end - endRun.normStart - 1];
  if (startIndex === undefined || endIndex === undefined) return null;
  const range = document.createRange();
  try {
    range.setStart(startRun.node, startIndex);
    range.setEnd(endRun.node, endIndex + 1);
  } catch {
    return null;
  }
  return range;
}

/** run 序列对应的去空白文本，下标与 SpanRun.normStart 同一口径。 */
export function runsText(runs: SpanRun[]): string {
  let out = '';
  for (const run of runs) out += run.node.data.replace(/\s+/g, '');
  return out;
}
