# AGENT.md — dsh-session-cost

DSH（DeepSeek Harness）web 插件：把「本会话费用估算 + DeepSeek 账户余额」并入 DSH 自带统计栏（0.1.5 起为 `StatsPills`，此前为 `StatsLine`）同一行显示。服务端按模型计价（CNY），余额走官方 DeepSeek 余额 API。

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
  - settings namespace：**`"session-cost"` 字面量**（`@deepseek-ai/dsh-settings` 不导出 `settingsNamespace()`；`register/get/update` 内部仍校验 `/^[a-z][a-z0-9-]*$/`）
- `lib/client.js` — 浏览器 half：**手写 `window.__ModuleLoader__.load({id, factory})` bundle，无构建步骤**；React 组件（`require("react")` / `require("react/jsx-runtime")`）；CSS 走 `data-plugin-css` 通道（factory 内注入 `<style>`）；exports `{ inject, apply, ... }`
  - **bundle 内只能 require `react` / `react/jsx-runtime`**：DSH 客户端模块图对未注册模块**抛错**，一处顶层 require 会让整个 client half 加载失败。全部图标（费用 ¥ 徽标、刷新、设置卡箭头）都是内联 SVG 自绘，**不要**再 require `@deepseek-ai/dsh-client-ui-primitives`（0.1.5 起 DSH 安装里已无此包）
  - `conversation.composer.dock`（list slot，id `session-cost`，order 100）
  - `settings.plugin.item`（keyed slot，**key** `session-cost`；Host 必须 serve 该 namespace 卡片才渲染）
  - `findStatsRow()`：优先按 `data-composer-stats` 属性定位自带统计栏（0.1.5 `StatsPills`），文本 `N 轮 61 步` / `N turns 61 steps` 仅作旧版回退（非锚定正则）
  - `startStatsRowObserver(anchor, writeMerge)`：合并段的挂载与重挂载唯一入口。**统计栏会迟到**（`StatsPills` 在会话有步骤/token 前返回 `null`），所以 MutationObserver 必须监听锚点 parent 的**子树**（`childList`+`characterData`+`subtree`）；只监听容器 `childList` 会导致统计栏出现时永不回调 → 费用段静默消失（0.1.5 的实际故障模式）
- `scripts/*.mjs` — 自包含 smoke（无框架依赖，mock DOM / mock settings scope）；`dom-smoke.mjs` 内含 MutationObserver 替身，覆盖"统计栏迟到"回归
- `cordis.patch.yml` — bundle patch；`package.json` `dsh.bundle.patch` 指向它

## 兼容性（重要，改代码前必读）

- 适配 **DSH 0.1.5 版本线**（本机 `0.1.5-rc.1`；`dshReleases` 逐版本声明 `0.1.5-rc.1` / `0.1.5-rc.2`，二者 `StatsPills.tsx`/`.module.css` 逐字节相同）。**不再声明 0.1.2 线**（需要用 0.1.9）
- `dsh.client.inject` 必须是客户端模块图里存在的包（`dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`）
- `engines.dsh: ^0.1.5-rc.1`；`peerDependencies` 声明 lockstep `@deepseek-ai/dsh-*` 宿主包（dsh-market 据此显示"宿主要求"，合取判定）
- **0.1.5 破坏性变更备忘**：
  - `StatsLine`（单行省略号文本行）→ `StatsPills`（居中 flex 行 + 图标 pill，标记 `data-composer-stats`）：文本不再有 `·` 分隔（`2 轮 61 步`），行的 `display` 从 block 变 flex，追加节点成为 flex item（左右外边距交给容器 `gap:12px`，并需 `max-width:none` 防省略号裁剪）
  - `StatsPills` 在 `steps === 0 && !hasTokens` 时返回 `null`：统计栏**会在插件挂载之后才出现**
  - `@deepseek-ai/dsh-client-ui-primitives` 不再随安装提供：require 它会抛错并毁掉整个 client half（改用内联 SVG）
  - `session.seq` + `session.eventAt(seq)`（0.1.2 起的读法）在 0.1.5 未变，`liveSessionEvents()` 双兼容读法继续有效
- **DSH STORE 的 protectedDsh 信号是设计使然**（统计栏合并没有官方扩展点），README 已披露，保持现状，不要"修复"它

## 修改守则

- 服务端读 session 事件**必须走 `liveSessionEvents()`**（不要直接碰 `session.events`）
- client 保持手写 bundle 格式（只 require react 两个模块）与 `data-plugin-css` 通道；组件是 React 组件（返回 JSX 元素，不要返回 DOM 节点）
- 改统计栏合并逻辑时同步更新 `scripts/dom-smoke.mjs` 的 `startStatsRowObserver` 回归用例（统计栏迟到 / 数据不变不重建 / teardown 还原）
- 新测试加入 `package.json` 的 `"test"` 链；改完必须 `npm run check && npm test` 全绿
- 提交用 Conventional Commits（`feat:` / `fix:` / `chore:` / `docs:`），原子提交；改动涉及运行时契约时同步 bump 版本 + README「兼容性」小节
- 本地仓库有 codegraph 索引（`.codegraph/`，已 gitignore），可先用 codegraph 探索再改
