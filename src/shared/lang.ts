// 语言/文字体系工具（T-018）：内容层「目标语言命中即跳过」+ google-free 分桶共用。
// 纯函数，无 chrome / 网络。
export interface ScriptCounts {
  /** 汉字（CJK Unified + Ext A） */
  han: number;
  /** 假名（平/片） */
  kana: number;
  /** 谚文 */
  hangul: number;
  /** 拉丁字母 */
  latin: number;
}

export function scriptCounts(text: string): ScriptCounts {
  let han = 0;
  let kana = 0;
  let hangul = 0;
  let latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) han += 1;
    else if (c >= 0x3040 && c <= 0x30ff) kana += 1;
    else if (c >= 0xac00 && c <= 0xd7af) hangul += 1;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin += 1;
  }
  return { han, kana, hangul, latin };
}

/** 主文字体系分桶（google-free 批内 sl=auto 检测防护，契约 translation-provider.md「语言分桶」） */
export function dominantScript(text: string): 'cjk' | 'latin' | 'other' {
  const c = scriptCounts(text);
  const cjk = c.han + c.kana + c.hangul;
  if (cjk > 0 && cjk >= c.latin) return 'cjk';
  if (c.latin > 0) return 'latin';
  return 'other';
}

/**
 * 文本是否已是目标语言（契约 segmentation.md Skip #6）：
 * zh 目标 = 汉字数 ≥ 拉丁字母数，且无假名/谚文（日文另有假名判据），遇假名/谚文不判 zh；
 * CJK 总数 < 4 不判（防 UI 碎文本误判）。
 */
export function isTargetLangText(text: string, target: string): boolean {
  const t = target.toLowerCase();
  if (!(t.startsWith('zh') || t.startsWith('ja') || t.startsWith('ko'))) return false;
  const c = scriptCounts(text);
  const cjk = c.han + c.kana + c.hangul;
  if (cjk < 4) return false;
  if (t.startsWith('zh')) return c.kana === 0 && c.hangul === 0 && c.han >= c.latin;
  if (t.startsWith('ja')) return c.kana >= 1 && c.kana + c.han >= c.latin;
  return c.hangul >= c.han + c.kana + c.latin; // ko
}
