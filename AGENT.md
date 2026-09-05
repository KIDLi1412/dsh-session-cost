# AGENT.md — dsh-session-cost

DSH（DeepSeek Harness）web 插件：把「本会话费用估算 + DeepSeek 账户余额」并入 DSH 自带统计行（StatsLine）同一行显示。服务端按模型计价（CNY），余额走官方 DeepSeek 余额 API。

## 快速命令

- 校验：`npm run check`（`node --check` 全部 lib）
- 测试：`npm test`（`scripts/smoke.mjs` + `dom-smoke.mjs` + `settings-smoke.mjs` + `session-shape-smoke.mjs`）
- 发布：推送 tag `vX.Y.Z` → GitHub Actions（OIDC Trusted Publisher）自动 `npm publish`。**不要手动 npm publish**；版本号与 tag 必须同步 bump。

## 结构

- `lib/index.js` — 服务端 half（cordis plugin，`inject: ["webServer","sessions","credentials","settings"]`）
  - `foldSessionCost()`：增量折叠 live session 事件 → `computeCost()`（`lib/cost.js` 纯函数）
  - **`liveSessionEvents()`：session 事件读取的唯一入口（双兼容，见下）**
  - `deepseekFacts()`：`settings.get("llm-deepseek")` 的 `apiKeyEnv`/`baseURL` + `credentials.resolve(envRef)`（返回 `{value, source}`）
  - 路由：`GET /api/session-cost/summary?session=<id>`、`GET /api/session-cost/balance`（loopback-only 精确路由，`?refresh=1` 绕缓存；2 分钟 TTL + single-flight）
  - settings namespace：**`"session-cost"` 字面量**（0.1.2 起 `@deepseek-ai/dsh-settings` 不再导出 `settingsNamespace()`；`register/get/update` 内部仍校验 `/^[a-z][a-z0-9-]*$/`）
- `lib/client.js` — 浏览器 half：**手写 `window.__ModuleLoader__.load({id, factory})` bundle，无构建步骤**；React 组件（`require("react")` / `require("react/jsx-runtime")`）；CSS 走 `data-plugin-css` 通道（factory 内注入 `<style>`）；exports `{ inject, apply, ... }`
  - `conversation.composer.dock`（list slot，id `session-cost`，order 100）
  - `settings.plugin.item`（keyed slot，**key** `session-cost`；Host 必须 serve 该 namespace 卡片才渲染）
  - `findStatsRow()`：按 `"N 轮 · M 步"` / `"N turns · M steps"` 文本定位内置统计行（rc.7+ 有 748px 裁剪，需放宽 `max-width`/`overflow` 并靠 MutationObserver 重挂）
- `scripts/*.mjs` — 自包含 smoke（无框架依赖，mock DOM / mock settings scope）
- `cordis.patch.yml` — bundle patch；`package.json` `dsh.bundle.patch` 指向它

## 兼容性（重要，改代码前必读）

- 适配 **DSH 0.1.2 版本线**（`0.1.2-alpha.4` / `alpha.5` / `rc.1`），`dsh.compatibility.dshReleases` 精确逐版本声明（DSH STORE 契约；范围声明无效）
- `dsh.client.inject` 必须是 **rc.1 模块图存在**的包（`dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`）；缺失模块会被 loader 静默跳过，但别依赖这个
- `engines.dsh: ^0.1.2-rc.1`；`peerDependencies` 声明 lockstep `@deepseek-ai/dsh-*` 宿主包（dsh-market 据此显示"宿主要求"，合取判定）
- **rc.1 破坏性变更备忘**：
  - live session 无 `.events` 数组 → `session.seq`（事件总数）+ `session.eventAt(seq)`（0 基，官方 `dsh-token-meter` 读法）；旧版保留 `.events` 数组
  - `composerPhase` 字符串 → 布尔 `session.blank`（本项目未直接用，但 client 侧 props 来自新 owner props `{session, input}`）
  - 统计行文案未变（`"{turns} 轮 · {steps} 步"`），`STATS_ROW_TEXT` 正则依然有效
- **DSH STORE 的 protectedDsh 信号是设计使然**（统计行合并没有官方扩展点），README 已披露，保持现状，不要"修复"它

## 修改守则

- 服务端读 session 事件**必须走 `liveSessionEvents()`**（不要直接碰 `session.events`）
- client 保持手写 bundle 格式与 `data-plugin-css` 通道；组件是 React 组件（返回 JSX 元素，不要返回 DOM 节点）
- 新测试加入 `package.json` 的 `"test"` 链；改完必须 `npm run check && npm test` 全绿
- 提交用 Conventional Commits（`feat:` / `fix:` / `chore:` / `docs:`），原子提交；改动涉及运行时契约时同步 bump 版本 + README「兼容性」小节
- 本地仓库有 codegraph 索引（`.codegraph/`，已 gitignore），可先用 codegraph 探索再改
