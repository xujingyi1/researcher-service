# Figure Editor 集成侦察与决策（F1 · docs/figure-editor）

> 产生方式：PHASE 0 只读侦察（直接阅读 + 2 个并行 Explore agent + 与仓库既有深读交叉印证）。
> 本阶段仅做只读分析；F1 起按 ticket 增量实施。每个代码变更前先回到本文件核对范围。
> **集成目标：`ResearAI/AutoFigure-Edit`（web/ 前端）。** 与既有 AutoFigure 生成（`ResearAI/AutoFigure`）
> 是**两个不同上游**，详见 §3。

## 1. 版本固定（provenance）

| 项 | 值 |
|---|---|
| upstream repository | `ResearAI/AutoFigure-Edit`（https://github.com/ResearAI/AutoFigure-Edit） |
| investigated source commit | `16f3749e9d512bdf7b7b55c162307bc289750b7a` |
| investigated date | 2026-09-08 |
| version / tag | `v1.1`（与 #348 深读相同 commit） |
| 本地只读克隆 | `/tmp/afedit-ph0`（浅克隆，仅调查用，非交付物） |
| 仓库既有先例深读 | `docs/research/autofigure-edit-codebase.md`（issue #348，同 commit 深读） |
| license | `MIT License`（Copyright (c) 2026 Autofigure2 contributors） |

## 2. 结论速览

AutoFigure-Edit 是**单仓库 = FastAPI 控制面（server.py 738 行）+ 纯函数流水线（autofigure2.py）
+ 静态 MPA 前端（web/）**。`web/` 的 `app.js`（2406 行）只是 **MPA 多页工作流编排壳 + SSE 任务监控壳**；
**真正的图片编辑器（图形对象模型/几何/导出）整体是 vendored 第三方 SVG-Edit**（`web/vendor/svg-edit/`
≈18MB，经 iframe 嵌入，同源函数直调 `svgEditor.loadFromString` 注入）。**没有"可拆的自家编辑器核心"。**

## 3. 上游澄清（重要）

- **`ResearAI/AutoFigure`**：text→figure 生成 agent（Python SDK + Flask/Next）。researcher-service 已集成其
  V1 生成能力——feature-flagged 默认关（`AUTOFIGURE_ENABLED=false`），`server/src/figures/` 域挂
  `/api/v1/figures`，前端 `AutoFigureView`（route `/figures`）+ `api/figures.ts` + `stores/autofigure.ts`。
- **`ResearAI/AutoFigure-Edit`（本次集成目标）**：另一代码库，自带 FastAPI `server.py` + `autofigure2.py`
  流水线 + `web/` 编辑器站点。
- **V1 范围裁定（Path A，2026-09-08 确认）**：Figure Editor = researcher-service 内置编辑模块，**不移植
  AutoFigure-Edit 的 Python 流水线**——不引入 `/api/run`、SSE job、SAM/RMBG、provider/API-key 配置 UI。
  后续需要持久化/读取时优先复用 researcher-service 现有 `figures` / `files` 能力。
- 产品主品牌用 **"Figure Editor"**；**不使用 "AutoFigure-Edit" 作为面板内主品牌名**（§6 商标约束）。

## 4. 目标架构（2026-09-08 确认）

- **壳 = 原生 Vue**：route `/figure-editor`（requiresAuth）+ 顶栏 nav 入口 "Figure Editor" + 原生布局/
  auth/API client。editor 的 route / nav / auth / layout / toolbar / import / export / API integration
  全部 Vue 原生实现。
- **编辑器面 = 同源 iframe 承载 vendored SVG-Edit**（仅作为子组件画布，**非**整站/整 MPA iframe）。
  同源使 app.js 既有注入机制（`contentWindow.svgEditor.loadFromString` / `svgCanvas.setSvgString`）可用。
- 接入点（贴仓库现有惯例，**不新建 `features/` 目录**）：
  - `views/<Name>View.vue` + 就近 `.test.ts`
  - `router/index.ts` 一条受保护 route
  - `App.vue` `.app-nav` 加一行 `<router-link>`（`data-test="nav-figure-editor"`）
  - API 走 `api/client.ts` `apiFetch/apiJson`（Bearer + 401 刷新链 + #312 信封自动处理），不建第二 fetch 栈
- 目录：`views/FigureEditorView.vue` + `components/figureEditor/*`（镜像 `components/chat/` 先例）
  + `figureEditor/*`（协议/纯逻辑，镜像 `src/chat/` 先例）+ `api/figureEditor.ts`。

## 5. 关键风险与约束（PHASE 0 调查结论）

- **凭证纪律**：浏览器**零 API key**。AutoFigure-Edit 前端把 key 明文进 `/api/run` body 的模式不得移植；
  服务端密钥走既有 provider 配置/env。
- **CSS 隔离**：AutoFigure-Edit `styles.css`（1082 行，页面级 `body`/`*`/通用类）**不得全局 import**。
  chrome 视觉用 Element Plus + `<style scoped>` 重建；vendor SVG-Edit 自带 `svgedit.css` 在 iframe 内天然隔离。
- **生命周期**：app.js 事件绑定/SSE 需按 Vue `onMounted`/`onBeforeUnmount` 适配并显式销毁。
- **资源路径**：AutoFigure-Edit 为根绝对路径假设，vendor 资产须落在可经 `BASE_URL` 静态可达的位置。
- **不破坏面**：不得影响 `/chat`、`/figures`、admin、既有 AutoFigure generation、容器/model/用户管理。

## 6. 许可证与商标注意事项（vendor import 必须遵守）

- 仓库根 `LICENSE` = **MIT**（Autofigure2 contributors，2026）。可 fork/随包分发/商用，**须保留 MIT 版权声明**。
- `web/vendor/svg-edit` 是**独立第三方**（SVG-Edit，MIT：Alexis Deveria / Jeff Schiller 2010），bundle 内含版权头但
  vendor 目录未随附 LICENSE 文件——**后续 vendor import 必须另列/保留其版权**。
- `TRADEMARK.md`：不影响 MIT 代码许可；但改版分发须**清楚标注非官方 / based on AutoFigure-Edit**，不得用其
  logo/名号作主品牌，商用 logo/托管/联名需联系作者（resear.ai@gmail.com）。产品内统一用 "Figure Editor"。
- `CITATION_AND_ATTRIBUTION.md` 是道义性署名请求（非许可证条件），文档级引用即可。

## 7. F-ticket 路线（边界按实际代码重定）

| F | 主题 | 范围摘要 | 状态 |
|---|---|---|---|
| F1 | Feature shell | route `/figure-editor` + nav + 占位 view + tests + 本 reconnaissance | 进行中 |
| F2 | vendor/资产 bring-in | vendored SVG-Edit 进静态目录 + vendor README(provenance/license) | 待办 |
| F3 | CanvasEditor 工作台 | 同源 iframe 编辑器接入 Vue + 空白/导入/导出 | 待办 |
| F4 | API 接入（Gate A/B 后） | 复用 figures/files；浏览器零 key | 待办 |
| F5 | 功能页适配 | 历史/导入/指南 chrome 重建（按产品范围裁剪） | 待办 |
| F6 | tests + E2E | 协议/组件/关键链路 | 待办 |
| F7 | upstream sync 复盘 | vendor 刷新 + 同步流程固化 + ADR | 待办 |

## 8. 环境基线（F1 起始）

- 实现基线：`upstream/master` → 新分支 `feat/figure-editor-shell`（不含旧 `fix/frontend-mockgatewaychat-type`）。
- 工作区 untracked 环境文件（`researcher/`、`server/prisma/panel.db.backup`）属本地运行依赖，
  **不提交、不改动、不 stage**。
