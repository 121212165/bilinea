# Bilinea

> 双语阅读，不止网页：把原文与译文并排放在你正在读的地方。

Bilinea 是一个自托管的 Chrome / Edge（Manifest V3）双语阅读扩展。它不绑定任何翻译服务：你填入自己的 OpenAI 兼容端点（OpenRouter、本地网关等），或使用内置的免费机翻通道，扩展只负责抽取、排队、缓存与渲染。

名字取自 *bi-*（双）与 *linea*（线）：两条线，一行原文，一行译文。

## 能做什么

- **整页双语对照**：原文节点保留不动，译文作为兄弟节点插入，因此页面结构、链接与交互不受影响。支持整页翻译、停止并清除、按域名自动翻译。
- **划词与悬停**：选中文本弹出译文气泡；按住 `Alt` 悬停段落即时出卡。`Alt+X` 可直接翻译当前选区。
- **视频双语字幕**：YouTube 字幕逐句配对翻译，只显示与当前画面对应的译文，滚动换行不张冠李戴；会话缓存让回看秒出。
- **字幕与关键帧导出**：一键导出 Markdown / HTML 字幕稿、AI 简述；`Alt+Shift+C` 截取当前画面，按时间戳导出图文 Markdown。
- **PDF 阅读器**：在扩展内置阅读器中打开网络或本地 PDF，按页翻译并用「连续全文」侧栏对照阅读；画布分页滚动，侧栏连续滚动，两侧双向定位。支持左右两套独立高亮标记、同步标记、按文档持久化，百页文档按需渲染并回收离屏画布。
- **多引擎与降级**：OpenAI 兼容 / Google 免费机翻 / 微软免费机翻，自上而下自动降级；批处理、限流退避、持久缓存与取消传播都在 service worker 内完成。

## 快速开始

要求 Node ≥ 20。

```bash
npm install
npm run build        # 产物在 dist/
```

在 Chrome / Edge 中打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启「开发者模式」，选择「加载已解压的扩展程序」，指向本项目的 `dist/` 目录。

首次使用请打开扩展的「设置」页配置翻译引擎：

| 引擎 | 说明 |
|---|---|
| OpenAI 兼容 | 任意兼容 `/chat/completions` 的服务；填写 Base URL、API Key 与模型名 |
| Google 免费机翻 | 无需 Key，适合快速试用；稳定性取决于上游 |
| 微软免费机翻 | 无需 Key；部分地区可能不可用 |

API Key 只保存在本机 `chrome.storage.local`，不会写入代码、日志或任何第三方地址。

## 开发

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest，333 个单元测试
npm run build        # esbuild 打包 + 拷贝静态资源
```

### 目录结构

```
src/
  content/     DOM 抽取、双语渲染、划词/悬停、字幕、PDF 入口（不发起网络请求、不持有 Key）
  service/     Service Worker：翻译队列、Provider 适配器、缓存、存储、关键帧
  shared/      消息契约、类型、语言识别、PDF 文本与标记等纯函数
  pages/       options / popup / PDF 阅读器（原生 TS + DOM，无 UI 框架）
tests/unit/    Vitest 单元测试
scripts/       esbuild 构建与图标生成
static/        manifest 与图标
```

约束：content 层只做 DOM 与渲染；所有翻译请求经 `chrome.runtime.sendMessage` 进入 service worker；`shared/` 只放无副作用代码。

### PDF 阅读器的拆分

PDF 页面曾是一个 2300 行的单体，现已拆成 12 个单向依赖模块，入口 `src/pages/pdf/index.ts` 只保留事件装配与启动：

```
index.ts（组合根）
  ├─ pdf-types / pdf-state           类型与唯一可变状态
  ├─ pdf-dom / pdf-ui                DOM 引用与工具栏
  ├─ pdf-loader / pdf-viewer         加载、canvas、文本层、渲染窗口
  ├─ pdf-navigation                  页码、缩放、适宽
  ├─ pdf-page-text / translation-utils  文本块与翻译分段
  ├─ pdf-translation                 按页翻译队列
  ├─ pdf-sidebar                     连续全文侧栏
  ├─ pdf-highlight / pdf-marks       CSS Highlight 与标记持久化
  └─ pdf-navigation                  页码、缩放、适宽（页面同步回调由组合根注入）
```

## 设计与边界

- 译文不会替换原文；DOM 命名空间统一为 `itr-`。
- service 层统一返回 `Result<T>`，不把异常裸抛给 UI；日志不打印 Key、URL 或正文。
- PDF 文本按行、栏、段落聚类后再送翻译，而不是逐 `text item` 直译。
- 标记偏移使用「去除空白后的字符序号」，因此缩放、重排、重新翻译后仍能定位。
- 不加载远程代码；PDF 运行时（pdf.js）随扩展打包，符合 MV3 CSP。

## 已知限制

- 仅支持 Chromium 系浏览器（Chrome / Edge），未适配 Firefox。
- 视频字幕目前针对 YouTube 的播放器结构。
- PDF 支持文本型文档；扫描件没有文本层，会提示无法翻译。加密或使用非嵌入字体的文档可能需要 CMaps，已随包提供常用字符集。
- 免费机翻通道受上游可用性影响，偶发限流时会自动重试或降级。

## 许可

[MIT](LICENSE)
