// 页内提示条（T-008）：契约 messaging.md「错误约定」——
// E_NO_KEY/E_PROVIDER_DOWN 等失败用一次性提示条，不劫持页面。
const TIP_ID = 'itr-tip';

export interface TipOptions {
  theme?: 'auto' | 'light' | 'dark';
  /** > 0 时自动消失（毫秒） */
  autoHideMs?: number;
}

/** 单例：新提示替换旧提示；close 按钮可手动关闭 */
export function showTip(doc: Document, text: string, opts: TipOptions = {}): HTMLElement {
  removeTip(doc); // 单例语义
  const tip = doc.createElement('div');
  tip.className = 'itr-tip';
  tip.id = TIP_ID;
  if (opts.theme) tip.setAttribute('data-itr-theme', opts.theme);

  const msg = doc.createElement('span');
  msg.className = 'itr-tip-msg';
  msg.textContent = text;

  const close = doc.createElement('span');
  close.className = 'itr-tip-close';
  close.textContent = '✕';
  close.addEventListener('click', () => tip.remove());

  tip.append(msg, close);
  doc.body?.append(tip);
  if (opts.autoHideMs && opts.autoHideMs > 0) {
    const timer = setTimeout(() => tip.remove(), opts.autoHideMs);
    // 手动关闭后不再触发无主定时器（无害，但干净些）
    tip.addEventListener('itr-tip-removed', () => clearTimeout(timer), { once: true });
  }
  return tip;
}

export function removeTip(doc: Document): void {
  doc.getElementById(TIP_ID)?.remove();
}

/** ProviderError.code → 用户可读文案（不暴露内部 detail） */
export function errorTipText(code: string): string {
  switch (code) {
    case 'E_NO_KEY':
      return '翻译未配置：请在扩展选项页填写 API Key';
    case 'E_PROVIDER_DOWN':
      return '翻译服务暂时不可用，请检查网络或服务地址设置';
    case 'E_RATE_LIMITED':
      return '请求过于频繁，部分内容翻译失败，请稍后重试';
    case 'E_ABORTED':
      return '翻译已取消';
    default:
      return `翻译失败（${code}），请稍后重试`;
  }
}
