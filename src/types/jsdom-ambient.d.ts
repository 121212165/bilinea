// jsdom 类型声明：仅声明测试中实际用到的一小块（避免为 dev-only 测试新增 @types 依赖）
declare module 'jsdom' {
  export interface JSDOMWindow extends Window {
    document: Document;
  }
  export class JSDOM {
    window: JSDOMWindow;
    constructor(html?: string, options?: Record<string, unknown>);
  }
}
