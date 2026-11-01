import { describe, expect, it } from 'vitest';
import { isPdfInfoPayload, isRpcRequest, isTabAction } from '../../../src/shared/messaging';

describe('消息契约 T-028e', () => {
  it('GET_PUBLIC_SETTINGS 是合法 RPC（PDF 页只取 targetLang）', () => {
    expect(isRpcRequest({ type: 'GET_PUBLIC_SETTINGS' })).toBe(true);
  });

  it('未知类型仍被拒绝', () => {
    expect(isRpcRequest({ type: 'GET_SECRETS' })).toBe(false);
    expect(isRpcRequest(null)).toBe(false);
  });
});

describe('消息契约 T-028f（原生 PDF 入口）', () => {
  it('GET_PDF_INFO 是合法 TabAction', () => {
    expect(isTabAction({ type: 'GET_PDF_INFO' })).toBe(true);
    expect(isTabAction({ type: 'GET_PDF_INFO_EXTRA' })).toBe(false);
  });

  it('OPEN_PDF_READER 是合法 Rpc（web 页不能直导航扩展页，开标签交 SW）', () => {
    expect(isRpcRequest({ type: 'OPEN_PDF_READER', fileUrl: 'https://x.com/a.pdf' })).toBe(true);
  });

  it('isPdfInfoPayload：形状校验（isPdf 必须布尔、url 必须字符串）', () => {
    expect(isPdfInfoPayload({ type: 'PDF_INFO', isPdf: true, url: 'https://x.com/a.pdf' })).toBe(true);
    expect(isPdfInfoPayload({ type: 'PDF_INFO', isPdf: false, url: '' })).toBe(true);
    expect(isPdfInfoPayload({ type: 'PDF_INFO', isPdf: 'yes', url: 'https://x.com' })).toBe(false);
    expect(isPdfInfoPayload({ type: 'PDF_INFO', isPdf: true })).toBe(false);
    expect(isPdfInfoPayload({ type: 'TRANSCRIPT', isPdf: true, url: '' })).toBe(false);
    expect(isPdfInfoPayload(null)).toBe(false);
  });
});
