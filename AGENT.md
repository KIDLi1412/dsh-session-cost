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
  - **bundle 内只能 require `react` / `react/jsx-runtime`**：DSH 客户端模块图对未注册模块**抛错**，一处顶层 require 会让整个 client half 加载失败。全部图标（费用钱包、刷新箭头、面板标题）都是内联 SVG 自绘，**不要**再 require `@deepseek-ai/dsh-client-ui-primitives`（0.1.5 起 DSH 安装里已无此包）
  - `conversation.composer.dock`（list slot，id `session-cost`，order 100）——**这是本插件注册的唯一槽位**
  - **不再注册 `settings.plugin.item`**（0.2.6 起）：低余额阈值只有一个编辑器，就是明细面板最后一行（`dt`「低余额阈值」+ 含 `<input data-slot="threshold-input">` 的 `dd` + 单位）。Host 侧仍注册 `session-cost` namespace、客户端仍 `ctx.settingsScope.bind({namespace:"session-cost"})`——**值照旧持久化在 settings.yaml**，搬的只是界面；别再往 DSH 设置里加卡片
    - 该 `dd` 是**含 slot 的单元格**，`patchText` 因此天然跳过它，30 秒自动刷新不会吃掉正在输入的值；提交走 `change`（失焦/回车）+ 显式 Enter，值经 `sanitizeThreshold` 写回 `configStore.set({lowBalanceThreshold})` → `scope.set`；空串/负数**不提交**并把输入框恢复成已存值；回调从 `data.onThreshold` 在**事件时**读取（同 ⟳ 按钮）
  - `findStatsRow()`：优先按 `data-composer-stats` 属性定位自带统计栏（0.1.5 `StatsPills`），文本 `N 轮 61 步` / `N turns 61 steps` 仅作旧版回退（非锚定正则）
  - `startStatsRowObserver(anchor, writeMerge)` → `{ sync, dispose }`：合并段的挂载与重挂载唯一入口，**每个组件挂载只装一次**，数据变化由 `sync()` 推入（不要在数据 effect 里重建观察器：那会每 30 秒拆掉重建节点、并且掩盖"观察器已死"的事实）。**三个"迟到/重建"必须同时处理**：①**统计栏迟到**（`StatsPills` 在会话有步骤/token 前返回 `null`）→ 观察器必须监听锚点 parent 的**子树**（`childList`+`characterData`+`subtree`），只监听容器 `childList` 会在统计栏出现时永不回调；②**数据迟到**（重启 host 后首次 summary/余额仍在路上，而组件已挂载）→ 观察器**必须无条件安装**（曾在 `writeMerge()` 返回 null 时提前 return，导致没人等统计栏、只有页面刷新后才显示）；③**宿主重建**（切会话时整个输入区被拆掉重建，冷会话要等约 1 秒，回调可能在锚点**脱离文档**时触发）→ 重新挂载必须**无条件**（`observer.observe(host, …)` 不要加 `host.isConnected` 判断；脱离文档的子树照样派发变更）。**0.2.0 的 bug 就是③**：一次脱离文档期间的回调让观察器永久失效 → "切到没缓存的旧会话费用消失、切回来也不恢复、必须刷新页面"。另配 1 秒看门狗（`MERGE_WATCHDOG_MS`）兜底：`rendered && (统计栏已脱离文档 || 节点不在宿主里)` 就 `sync()` 重挂。无数据时 `sync()` 只是不画节点
  - 统计栏不存在时**不能什么都不画**：`sync()` 把节点挂到锚点自身并打 `data-solo="true"`（CSS 照抄 `.bOPqQW_root` 的字号/内边距/最大宽度），统计栏出现即 `drop(anchor)` 挪回栏内。否则全新会话/冷会话加载中完全没有费用读数
  - 模板/结构上，组件里 `mergeRef` 负责安装，`mergeInputRef.current`（同一个对象、每次渲染刷新字段）提供 `buildMergeNode` 的输入，数据 effect 依赖 `dict/summary/balance/*Error/refreshing/justRefreshed/panelOpen` 调 `mergeRef.current.sync()`
  - `buildMergeNode()` / `updateMergeNode()`：pill 触发器 + 展开面板的全部 DOM。**形状不变时走原地 patch**（`sameMergeShape` → `updateMergeNode`），点击监听与**展开状态**在数据刷新时都不丢；形状变化（余额出现/消失、段报错）才重建，重建后由 React 的 `panelOpen` 状态重新展开。`patchText` 只写叶子 slot——label 是容器，写它的 `textContent` 会把 cost/balance 子节点整片抹掉。
    - **面板列表（`[data-slot=panel-list]`）的每个子节点本身就是 slot**：`dt` 是 `row-label`，`dd` 是 `row-value`（账户余额那个被改名为 `panel-balance`）。**必须直接 patch 单元格**，`cell.querySelector("[data-slot=row-value]")` 恒为 `null`（querySelector 只搜后代），会让 `patchText` 静默跳过——0.2.4 及以前就是这样：手动 ⟳ 后账户余额变了、充值/赠送余额和逐模型读数停在旧值（0.2.5 修）。同一条循环还要处理**列表原位增长/收缩**（`暂无 token 用量` ↔ 模型行：缺的单元格从候选节点 append、多的删掉；候选节点的单元格要先 `Array.from` 快照，append/replaceWith 会把它移出 `nextList` 打乱下标）与 `data-warn` 同步（模型变未计价、余额低于阈值要变红）。
    - **面板是 `document.body` 的 portal，永远不能用 `node.querySelector("[data-slot=panel]")` 找它**（恒为 null）：面板内部所有 slot（标题总额、余额、更新时间、刷新图标/按钮、`dt/dd` 列表、`hidden` 展开态）一律经 `panelOf(node)`（`mergePanels` WeakMap）取。用 querySelector 的那版让面板读数永不更新，并且在"节点不再每次数据变化都重建"之后**点击展开直接失效**（0.2.1 的回归，0.2.2 修）
    - 节点寿命跨越多次 render，所以 `onToggle`/`onRefresh` 必须在**点击时**从 `data` 上读；组件侧对应维护**同一个 state 对象**（`mergeInputRef.current` 只创建一次、逐字段刷新），不要每次渲染换新对象，否则处理器会停留在构建那一刻的闭包（刷新按钮绑到旧会话）
  - `disposeMergeNode()`：每个节点都持有一个挂到 `body` 的面板 + document 级监听（outside pointerdown / Escape），**discard 掉的候选节点也必须走它**，否则每次 sync 都往 `body` 漏一个面板
  - `placeOpenPanel()`：面板 placement 必须在节点**入 DOM 之后**才做（此前触发器没有盒子，会闪在视口原点）
- `scripts/*.mjs` — 自包含 smoke（无框架依赖，mock DOM / mock settings scope）；`dom-smoke.mjs` 的 DOM 替身刻意保留**真实语义**（`textContent` 写入清空子节点、`querySelectorAll` 只搜后代、`getBoundingClientRect`/`replaceWith`/`removeAttribute`），并含 MutationObserver + `window.setInterval` 替身（`tickIntervals()` 手动跑看门狗），覆盖「统计栏迟到」「数据迟到（空状态仍装观察器）」「统计栏缺席时挂锚点」「脱离文档期间回调后观察器仍在岗」「看门狗补挂丢失节点」「原地 patch 保留面板（含 caption 面板读数与点击展开/收起往返）」「点击时读最新处理器」「面板不泄漏」「统计栏行内样式不被改写」「面板列表单元格随数据原地更新（余额构成 / 逐模型读数 / `data-warn` / 列表原位增减，且不得退化成被 `console.warn` 吞掉的失败）」「面板内的阈值输入框（提交 / 拒绝 / 回车 / 刷新不覆盖半途输入）」「`apply()` 只注册 composer dock 一个槽位、且仍绑定同一 namespace」回归
- `cordis.patch.yml` — bundle patch；`package.json` `dsh.bundle.patch` 指向它

## 兼容性（重要，改代码前必读）

- 适配 **DSH 0.1.5 版本线**（本机 `0.1.5-rc.1`；`dshReleases` 逐版本声明 `0.1.5-rc.1` / `0.1.5-rc.2`，二者 `StatsPills.tsx`/`.module.css` 逐字节相同）。**不再声明 0.1.2 线**（需要用 0.1.9）
- `dsh.client.inject` 必须是客户端模块图里存在的包（`dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`）
- `engines.dsh: ^0.1.5-rc.1`；`peerDependencies` 声明 lockstep `@deepseek-ai/dsh-*` 宿主包（dsh-market 据此显示"宿主要求"，合取判定）
- **0.1.5 破坏性变更备忘**：
  - `StatsLine`（单行省略号文本行）→ `StatsPills`（居中 flex 行 + 图标 pill，标记 `data-composer-stats`）：文本不再有 `·` 分隔（`2 轮 61 步`），行的 `display` 从 block 变 flex，追加节点成为 flex item（左右间距交给容器 `gap:12px`，自身 `flex:none` + `max-width:none`）。**统计栏自身的样式一个字节都不改**：`.bOPqQW_root` 是 `width:100%; max-width:748px; gap:12px` 的居中 flex 行，没有 `overflow:hidden`、也不做省略号截断，宽度本来就够，追加段只是这一组里的第三项（≤ 0.1.4 的 `StatsLine` 才有 748px + 裁剪问题，当时的"放宽 + 取消裁剪"行内样式补丁已在 **0.2.3 删除**，别再写回去——`dom-smoke` 有断言）。自带两个 pill 是**按钮**，点击展开 `stat-dialog` 皮肤的面板——本插件的 pill/面板即照这套复制（`.pill` 的 `1px 8px`/24px 圆角/13-20 层级，面板的 `position:fixed` + `--dsw-specific-menu` + `minmax(76px,auto)` 网格 + 8px 间距/12px 边距）
  - `StatsPills` 在 `steps === 0 && !hasTokens` 时返回 `null`：统计栏**会在插件挂载之后才出现**
  - `@deepseek-ai/dsh-client-ui-primitives` 不再随安装提供：require 它会抛错并毁掉整个 client half（改用内联 SVG；原生 `useAnchoredPosition`/`useDismissOnOutsidePointer` 也不可用，placement 与 outside-close 自行实现）
  - `session.seq` + `session.eventAt(seq)`（0.1.2 起的读法）在 0.1.5 未变，`liveSessionEvents()` 双兼容读法继续有效
- **DSH STORE 的 protectedDsh 信号是设计使然**（统计栏合并没有官方扩展点），README 已披露，保持现状，不要"修复"它

## 定价（改 `lib/cost.js` 前必读）

- 计价是**两层**：`periodOf(time)` 先判**价格世代**（`legacy` → `v4:peak`/`v4:offpeak` → 当前 `peak`/`offpeak`），再由 `peakStateOf(time)` 提供日内峰谷。V4 世代必须同时保留两个维度，否则 V4 时代的高峰流量会被按空闲价计（少算一半）
- 世代表：`DEFAULT_PRICING`（2026-09-10 起，V4.1-Flash：Flash ¥1/2、¥0.02/0.04、¥4/8；Pro ¥4.5/9、¥0.15/0.30、¥13.5/27）、`V4_ERA_PRICING`（2026-08-17–09-09）、`LEGACY_PRICING`（之前的平峰价）。`PERIODS` 数组是 fold/计价共用的时段清单，加时段要同步 `zeroBuckets` 初始化、`periodsOf` 的 fallback 与 row 汇总
- `priceOf` 按**名称边界前缀**匹配（`deepseek-v4-flash-2026-01` 命中 `deepseek-v4-flash`，`deepseek-v99` 不命中）；世代表用 `eraEntryOf` + `PRICING_ALIASES` 解析别名。**新增模型 id 时必须同步当前表与别名表**，否则费用静默变 ¥0（0.1.5 的 `deepseek-flash` 就是这么炸的）
- 每次官方调价：更新 `DEFAULT_PRICING`、把上一代价目挪进新世代表并加 cutover 常量、同步 README 定价小节与 `scripts/smoke.mjs` 的用例

## 修改守则

- 服务端读 session 事件**必须走 `liveSessionEvents()`**（不要直接碰 `session.events`）
- client 保持手写 bundle 格式（只 require react 两个模块）与 `data-plugin-css` 通道；组件是 React 组件（返回 JSX 元素，不要返回 DOM 节点）
- 改统计栏合并逻辑时同步更新 `scripts/dom-smoke.mjs` 的回归用例（统计栏迟到 / 原地 patch 保留面板与监听 / discard 不泄漏面板 / 统计栏行内样式不被改写）
- **不要给自带统计栏写行内样式**（`max-width` / `overflow` / `text-overflow`）：0.1.5 的统计栏是居中 flex 行、宽度本来就够，宽度补丁已在 0.2.3 删除；`dom-smoke.mjs` 里有"统计栏行内样式在挂载/重挂/卸载后逐项不变"的断言，写回去会红
- 新测试加入 `package.json` 的 `"test"` 链；改完必须 `npm run check && npm test` 全绿
- 提交用 Conventional Commits（`feat:` / `fix:` / `chore:` / `docs:`），原子提交；改动涉及运行时契约时同步 bump 版本 + README「兼容性」小节
- 本地仓库有 codegraph 索引（`.codegraph/`，已 gitignore），可先用 codegraph 探索再改
