// 自写的最小 chrome API 类型声明（避免引入新依赖 @types/chrome）。
// 只声明本项目实际用到的 API 面。

declare namespace chrome {
  namespace runtime {
    interface MessageSender {
      tab?: { id?: number; windowId?: number };
    }
    const onMessage: {
      addListener(
        cb: (
          msg: unknown,
          sender: MessageSender,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };
    function sendMessage(msg: unknown): Promise<unknown>;
    /** 扩展内资源 URL（T-028 PDF 页动态加载 pdf.js / worker / cmaps） */
    function getURL(path: string): string;
  }
  namespace storage {
    interface StorageChange {
      [key: string]: { newValue?: unknown; oldValue?: unknown };
    }
    const local: {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
      getBytesInUse(keys?: string | string[] | null): Promise<number>;
    };
    const onChanged: {
      addListener(
        cb: (changes: StorageChange, area: 'local' | 'sync' | 'session' | 'managed') => void,
      ): void;
    };
  }
  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      windowId?: number;
    }
    const onUpdated: {
      addListener(cb: (tabId: number, info: { status?: string }, tab: Tab) => void): void;
    };
    function query(info: Record<string, unknown>): Promise<Tab[]>;
    function sendMessage(tabId: number, msg: unknown): Promise<unknown>;
    /** T-028f：popup 打开 PDF 阅读器（无需额外权限） */
    function create(createProperties: { url?: string; active?: boolean }): Promise<Tab>;
    /** T-027 关键帧：首参是 windowId（窗口 id，非 tab id）；只捕该窗口的活动 tab */
    function captureVisibleTab(
      windowId: number,
      options: { format?: 'jpeg' | 'png'; quality?: number },
    ): Promise<string>;
  }
  namespace scripting {
    const executeScript: (
      details: {
        target: { tabId?: number; allFrames?: boolean };
        files?: string[];
        func?: (...args: unknown[]) => void;
        injectImmediately?: boolean;
      },
    ) => Promise<unknown>;
  }
  namespace commands {
    const onCommand: {
      addListener(cb: (command: string, tab?: chrome.tabs.Tab) => void): void;
    };
  }
}
