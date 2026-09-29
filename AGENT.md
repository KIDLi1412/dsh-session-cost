# AGENT.md — dsh-session-cost

DSH（DeepSeek Harness）web 插件：把「本会话费用估算 + DeepSeek 账户余额」并入 DSH 自带统计栏（0.1.5 起为 `StatsPills`，此前为 `StatsLine`）同一行显示。服务端按模型计价（CNY），余额走官方 DeepSeek 余额 API。

## 快速命令

- 校验：`npm run check`（`node --check` 全部 lib）
- 测试：`npm test`（`scripts/smoke.mjs` + `dom-smoke.mjs` + `settings-smoke.mjs` + `session-shape-smoke.mjs`）
- 发布：推送 tag `vX.Y.Z` → GitHub Actions（OIDC Trusted Publisher）自动 `npm publish`。**不要手动 npm publish**；版本号与 tag 必须同步 bump。

## 结构

- `lib/index.js` — 服务端 half（cordis plugin，`inject: ["webServer","sessions","credentials","settings"]`）
  - **`export const Config = z.object({ lowBalanceThreshold })`：DSH 0.2.0 的设置来源**。0.1.x 的 `ctx.settings.register(ns, schema)` 已不存在；插件导出的 `Config` 就是表单，DSH 以 **profile entry id** 为键（本插件 = bundle patch 里的 `id: session-cost`）生成/持久化。未声明的键（`pricing`）由 schemastery 原样保留，服务端继续按老办法从 `apply(ctx, config)` 里宽松读取
  - `foldSessionCost()`：增量折叠 live session 事件 → `computeCost()`（`lib/cost.js` 纯函数）
  - **`liveSessionEvents()`：session 事件读取的唯一入口（双兼容，见下）**
  - `entryConfig(ctx, "llm-deepseek")`：读别的插件条目配置的唯一入口（`ctx.settings.describe()` 里按 `ns` 找，取 `value`）。**不要用 `ctx.settings.get(ns)`——0.2.0 没有这个方法**，写成 `settings?.get?.()` 会静默回落到默认值（baseURL/apiKeyEnv 被忽略）
  - `deepseekFacts()`：上面那个条目的 `apiKeyEnv`/`baseURL` + `credentials.resolve(envRef)`（返回 `{value, source}`）
  - 路由：`GET /api/session-cost/summary?session=<id>`、`GET /api/session-cost/balance`（loopback-only 精确路由，`?refresh=1` 绕缓存；2 分钟 TTL + single-flight）。0.2.0 起整站还有浏览器 cookie 鉴权，未带 cookie 的请求根本到不了这里
  - `rescueLegacyThreshold()`：一次性把旧 `settings.yaml` / `settings.yaml.imported` 里的 `lowBalanceThreshold` 写回配置（DSH 自己的导入按 entry id 走，本插件当时因 peer 不符未挂载而被跳过）。**只在条目还没有用户值、且值非默认时才写**，等 Loader settle 后执行，全程 try/catch
- `lib/client.js` — 浏览器 half：**手写 `window.__ModuleLoader__.load({id, factory})` bundle，无构建步骤**；React 组件（`require("react")` / `require("react/jsx-runtime")`）；CSS 走 `data-plugin-css` 通道（factory 内注入 `<style>`）；exports `{ inject, apply, ... }`
  - **bundle 内只能 require `react` / `react/jsx-runtime`**：DSH 客户端模块图对未注册模块**抛错**，一处顶层 require 会让整个 client half 加载失败。全部图标（费用钱包、刷新箭头、面板标题）都是内联 SVG 自绘，**不要**再 require `@deepseek-ai/dsh-client-ui-primitives`（0.1.5 起 DSH 安装里已无此包）
  - `conversation.composer.dock`（list slot，id `session-cost`，order 100）——**这是本插件注册的唯一槽位**
  - **不再注册 `settings.plugin.item`**（0.2.6 起；该槽位在 0.2.0 也已不存在）：低余额阈值只有一个编辑器，就在明细面板里——**「更新于 / ⟳」下面一行**（0.2.7 起），即 `div[data-slot=panel-setting]`：左侧标签 + 右侧 `<input data-slot="threshold-input">` + 单位。值的来源是**插件配置表单**：`ctx.configForms.get("session-cost")`（0.2.8 起；0.1.x 的 `ctx.settingsScope.bind({namespace})` 已消失）。**entry id 必须同时等于 bundle patch 的 `id` 与 Host 的 `SETTINGS_NAMESPACE`**，`settings-smoke` 有一条断言盯着这个三方一致
    - 该行在 `panel-list`（读数网格）**之外**，也不含任何被 patch 的 slot（`updateMergeNode` 只按名字 patch 已知 slot），所以原地更新根本不碰它，30 秒自动刷新不会吃掉正在输入的值；提交走 `change`（失焦/回车）+ 显式 Enter，值经 `sanitizeThreshold` 写回 `configStore.set({lowBalanceThreshold})` → `form.set(field, value)`；空串/负数**不提交**并把输入框恢复成已存值；回调从 `data.onThreshold` 在**事件时**读取（同 ⟳ 按钮）
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
- `scripts/*.mjs` — 自包含 smoke（无框架依赖，mock DOM / mock config form / mock host ctx）；`dom-smoke.mjs` 的 DOM 替身刻意保留**真实语义**（`textContent` 写入清空子节点、`querySelectorAll` 只搜后代、`getBoundingClientRect`/`replaceWith`/`removeAttribute`），并含 MutationObserver + `window.setInterval` 替身（`tickIntervals()` 手动跑看门狗），覆盖「统计栏迟到」「数据迟到（空状态仍装观察器）」「统计栏缺席时挂锚点」「脱离文档期间回调后观察器仍在岗」「看门狗补挂丢失节点」「原地 patch 保留面板（含 caption 面板读数与点击展开/收起往返）」「点击时读最新处理器」「面板不泄漏」「统计栏行内样式不被改写」「面板列表单元格随数据原地更新（余额构成 / 逐模型读数 / `data-warn` / 列表原位增减，且不得退化成被 `console.warn` 吞掉的失败）」「面板内的阈值输入框（提交 / 拒绝 / 回车 / 刷新不覆盖半途输入）」「`apply()` 只注册 composer dock 一个槽位、用 `configForms.get(entry id)` 取配置、且 inject 里只剩 0.2.0 的服务」回归；`settings-smoke.mjs` 覆盖 `Config` schema、entry id 三方一致、旧文档抢救的文本扫描、以及 `apply()` 只注册两条精确路由
- `cordis.patch.yml` — bundle patch；`package.json` `dsh.bundle.patch` 指向它

## 兼容性（重要，改代码前必读）

- 适配 **DSH 0.2.0 版本线**（本机 `0.2.0-rc.2`；`dshReleases` 声明 `0.2.0-rc.2`）。`engines.dsh` 与全部宿主 `peerDependencies` 都是 `^0.2.0-rc.2`（整条 0.2 线，含 prerelease）
- **宿主兼容闸门会拒绝挂载，不只是警告**：`dsh-app-boot` 的 `evaluatePluginCompatibility()` 逐条比对 `peerDependencies` 里的 `@deepseek-ai/dsh*` 与运行时版本（`semver.satisfies(..., { includePrerelease: true })`），不符时 `dsh plugin add` 直接拒绝安装、已装的 bundle 在 `plugin_manager list_bundles` 里显示 `incompatible-version` + `rows: []`（插件完全没挂载，不是"降级运行"）。改 peer 范围前先跑 `temp/compat-preflight.mjs` 那种预检
- 宿主包同时标 `peerDependenciesMeta.optional`：它们由 DSH 运行时提供、本插件**从不 import**，标 optional 让 npm/pnpm 不再把它们装进依赖树（0.2.0 起这些包彼此还有 peer，沿用自动安装会解析冲突）。闸门只读 `peerDependencies`，语义不受影响
- `dsh.client.inject` 必须是客户端模块图里存在的包（`dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`，0.2.0 实测都在图里）；客户端 `inject` 服务是 `["slots","locale","configForms"]`
- **0.2.0 破坏性变更备忘**：
  - **设置模型**：插件自建 namespace + `settings.register(ns, schema)` → **导出 `Config`（schemastery）**，以 profile entry id 为键的表单；Host 读别人用 `settings.describe()`、写自己用 `settings.update(ns, patch)`；浏览器端 `ctx.configForms.get(entryId)`（`getSnapshot`/`subscribe`/`set`/`unset`/`mutate`），`settingsScope` 与 `settings.get(ns)` 都已删除
  - **`settings.yaml` 被取消**：DSH 在启动后把旧文档整体导入 profile 并改名为 `settings.yaml.imported`（按 section→entry id，`LEGACY_SECTION_ENTRIES` 只映射少数几个），导入失败的 section 只留在重命名后的文件里——所以插件自己被拒挂载时值不会被自动带走（本插件的抢救逻辑就是为它写的）
  - **统计栏几何搬家**：`.bOPqQW_root` 不再有 `width:100%` / 748px 上限 / 侧边 padding（交给 composer 的 `uV2eYG_dock`：`justify-content:center; align-items:center; gap:12px; max-width:100%; padding-top:4px`），字号变 `calc(var(--dsh-content-font-size-secondary,13px) - 1px)`，pill 圆角 `999px` + `corner-shape:round`，stat-dialog 面板改 `border-radius:var(--dsw-radius-lg)` + `backdrop-filter:var(--dsw-menu-backdrop-filter)`。**本插件的 pill/solo 行/明细面板必须跟着这套值走**，否则第三项与自带 pill 不齐平
  - `StatsPills` 仍是 `conversation.composer.dock` 槽位的注册者（与插件同槽位，锚点的 `parentElement` 仍同时容纳两者），仍带 `data-composer-stats`，仍在 `steps === 0 && !hasTokens` 时返回 `null`（"统计栏迟到"逻辑不变）；另有 `usePerformanceUsage` 的 compact 模式（只渲染 速度/缓存命中 两个 pill）
  - **整站 cookie 鉴权**：0.2.0 给 `dsh web` 的每个请求加了签名 cookie（无 cookie → `401 dsh web authentication required`）。插件端点的 loopback 精确路由 fence 保留；用 node 直接探端点会拿到 401，这**不代表插件没挂载**，别据此误判
  - `session.seq` + `session.eventAt(seq)`、`sessions.list()`、`credentials.resolve(ref)`、`ctx.webServer.register({kind,path,handler})` 在 0.2.0 均未变（已逐项核对 0.2.0-rc.2 的类型与实现）
- **DSH STORE 的 protectedDsh 信号是设计使然**（统计栏合并没有官方扩展点），README 已披露，保持现状，不要"修复"它

## 定价（改 `lib/cost.js` 前必读）

- 计价是**两层**：`periodOf(time)` 先判**价格世代**（`legacy` → `v4:peak`/`v4:offpeak` → 当前 `peak`/`offpeak`），再由 `peakStateOf(time)` 提供日内峰谷。V4 世代必须同时保留两个维度，否则 V4 时代的高峰流量会被按空闲价计（少算一半）
- 世代表：`DEFAULT_PRICING`（2026-09-10 起，V4.1-Flash：Flash ¥1/2、¥0.02/0.04、¥4/8；Pro ¥4.5/9、¥0.15/0.30、¥13.5/27）、`V4_ERA_PRICING`（2026-08-17–09-09）、`LEGACY_PRICING`（之前的平峰价）。`PERIODS` 数组是 fold/计价共用的时段清单，加时段要同步 `zeroBuckets` 初始化、`periodsOf` 的 fallback 与 row 汇总
- `priceOf` 按**名称边界前缀**匹配（`deepseek-v4-flash-2026-01` 命中 `deepseek-v4-flash`，`deepseek-v99` 不命中）；世代表用 `eraEntryOf` + `PRICING_ALIASES` 解析别名。**新增模型 id 时必须同步当前表与别名表**，否则费用静默变 ¥0（0.1.5 的 `deepseek-flash` 就是这么炸的）
- 每次官方调价：更新 `DEFAULT_PRICING`、把上一代价目挪进新世代表并加 cutover 常量、同步 README 定价小节与 `scripts/smoke.mjs` 的用例

## 修改守则

- 服务端读 session 事件**必须走 `liveSessionEvents()`**（不要直接碰 `session.events`）
- 服务端读**别的插件配置**必须走 `entryConfig(ctx, id)`（`settings.describe()`）；**不要**写 `ctx.settings.get(ns)`（0.2.0 无此方法，`?.` 会静默回落默认值）
- 改插件配置字段（`lowBalanceThreshold` 之类）时要**三处同步**：Host 的 `Config` schema、客户端 `configForms.get()` 的 entry id（= bundle patch 的 `id` = `SETTINGS_NAMESPACE`）、面板里读写的字段名；`settings-smoke` 会断言前两者的字面量一致
- 升级 DSH 版本线时：先按上面「宿主兼容闸门」把 `engines.dsh` 与 9 个 peer 一起换到新线，用 `dsh-app-boot` 的 `evaluatePluginCompatibility` 做预检，再核对本文件「破坏性变更备忘」里那几项（设置模型、统计栏几何、鉴权）是否又变了
- client 保持手写 bundle 格式（只 require react 两个模块）与 `data-plugin-css` 通道；组件是 React 组件（返回 JSX 元素，不要返回 DOM 节点）
- 改统计栏合并逻辑时同步更新 `scripts/dom-smoke.mjs` 的回归用例（统计栏迟到 / 原地 patch 保留面板与监听 / discard 不泄漏面板 / 统计栏行内样式不被改写）
- **不要给自带统计栏写行内样式**（`max-width` / `overflow` / `text-overflow`）：统计栏的宽度由 composer 的 dock 容器给，宽度补丁已在 0.2.3 删除；`dom-smoke.mjs` 里有"统计栏行内样式在挂载/重挂/卸载后逐项不变"的断言，写回去会红
- 新测试加入 `package.json` 的 `"test"` 链；改完必须 `npm run check && npm test` 全绿
- 提交用 Conventional Commits（`feat:` / `fix:` / `chore:` / `docs:`），原子提交；改动涉及运行时契约时同步 bump 版本 + README「兼容性」小节
- 本地仓库有 codegraph 索引（`.codegraph/`，已 gitignore），可先用 codegraph 探索再改
