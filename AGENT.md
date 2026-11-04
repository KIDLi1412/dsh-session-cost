# AGENT.md — dsh-session-cost

DSH（DeepSeek Harness）web 插件：把「本会话费用估算 + DeepSeek 账户余额」并入 DSH 自带统计栏（0.1.5 起为 `StatsPills`，此前为 `StatsLine`）同一行显示。服务端按模型计价（CNY），余额走官方 DeepSeek 余额 API。

## 快速命令

- 校验：`npm run check`（`node --check` 全部 lib）
- 测试：`npm test`（`scripts/smoke.mjs` + `dom-smoke.mjs` + `settings-smoke.mjs` + `session-shape-smoke.mjs`）
- 发布：推送 tag `vX.Y.Z` → GitHub Actions（OIDC Trusted Publisher）自动 `npm publish`。**不要手动 npm publish**；版本号与 tag 必须同步 bump。

## 结构

- `lib/index.js` — 服务端 half（cordis plugin，`inject: ["webServer","sessions","credentials","settings"]`）
  - **`export const Config = z.object({ lowBalanceThreshold })`：DSH 0.2.0 的设置来源**。0.1.x 的 `ctx.settings.register(ns, schema)` 已不存在；插件导出的 `Config` 就是表单，DSH 以 **profile entry id** 为键（本插件 = bundle patch 里的 `id: session-cost`）生成/持久化。未声明的键（`pricing`）由 schemastery 原样保留，服务端继续按老办法从 `apply(ctx, config)` 里宽松读取
    - **每个可编辑字段都必须 `.volatile()`，这是硬要求而不是风格**：`SettingsForms` 只用 `volatileForm(schema)`（收集带 `meta.volatile` 的字段）建表单，一个都没有就返回 `undefined` → 条目**从 `describe()` 消失**（浏览器表单永远 `unavailable`，读不到也写不进）且写入抛 `Plugin entry "…" has no volatile fields`。两个失败都是静默的（编辑器看起来完全正常），0.3.0 就是这么让"低余额阈值设置不生效"的；`settings-smoke.mjs` 有一条断言盯着 schema 信封里的 `meta.volatile`
    - **volatile 字段解析出来的是活单元格 `{ get() }`，不是普通值**（`JSON.stringify(cell) === "{}"`）：Host 不要直接读它做运算，默认值比较也要用独立常量（`DEFAULT_LOW_BALANCE_THRESHOLD`），别写 `Config({}).字段`。DSH 在投影表单前会自己 `plainConfig()` 拆单元格
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
  - `findStatsRow()`：判定"自带读数是否在场"并给出合并段该挂到哪个元素。**0.2.1 起自带统计栏不是一个元素了**：`activity`（order 0）与 `usage`（order 1）是两个独立的 composer-dock 条目，标记也从复数 `data-composer-stats` 变成单数 `data-composer-stat`，所以"这一行"就是**dock 容器本身**（合并段因此是两个自带条目的同级元素）。顺序固定为：① 0.1.5–0.2.0 的 `data-composer-stats` 单行容器（找到就直接返回它，合并段追加进去）；② 容器里出现单数 `data-composer-stat` → 返回容器；③ ≤ 0.1.4 的文本行（`N 轮 61 步` / `N turns 61 steps`，非锚定正则）。**属性探测必须排在文本探测之前**：`activity` 条目的文本正是文本回退要匹配的 `N 轮 M 步`，顺序反了就会把合并段塞进 activity pill 里面（0.3.1 及以前在 0.2.1 上的实际表现）
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

- 适配 **DSH 0.2 版本线**（本机已更新到 `0.2.1-rc.5`，官方 npm 的 `latest` 也已从 `0.2.0-rc.2` 移到 `0.2.1-rc.5`，`alpha` 是 `0.2.2-alpha.2`）。`dshReleases` 声明 `0.2.0-rc.2`、`0.2.1-rc.2`、`0.2.1-rc.5`；`engines.dsh` 与全部宿主 `peerDependencies` 都是 `^0.2.0-rc.2 || ^0.2.1-rc.2`（该范围覆盖整条 0.2.1 线，含 rc.3/rc.4；`[0,2,1]` 元组在普通 semver 下也匹配）
  - **新线必须显式写进范围**：闸门与 dsh-market 都用 `semver.satisfies(..., { includePrerelease: true })`，`^0.2.0-rc.2` 本来也覆盖 `0.2.1-rc.2`；但**普通 semver**（npm/pnpm 的 peer 解析、没开 `includePrerelease` 的第三方工具）只认**同一个 `[major,minor,patch]` 元组**上带先行版本号的比较器，`^0.2.0-rc.2` 只点名 `0.2.0`，因此不匹配 `0.2.1-rc.2`，会被读成"不支持当前宿主"。写成并集后两种语义都成立，也顺带覆盖 `0.2.1` 稳定版与后续 `0.2.1-rc.x`；`0.2.2-rc.x` 这类**下一条**补丁线的先行版本在普通 semver 下仍不匹配（semver 固有规则），跟进方式是再点名一条线
- **宿主兼容闸门会拒绝挂载，不只是警告**：`dsh-app-boot` 的 `evaluatePluginCompatibility()` 判定运行时版本（`semver.satisfies(..., { includePrerelease: true })`），不符时 `dsh plugin add` 直接拒绝安装、已装的 bundle 在 `plugin_manager list_bundles` 里显示 `incompatible-version` + `rows: []`（插件完全没挂载，不是"降级运行"）。**判定顺序很关键**：`unmetRequirements()` 只要发现声明了 `engines.dsh` 就**只看它并立即返回**，`peerDependencies` 里那 9 个宿主包**根本不参与挂载判定**（只有没写 `engines.dsh` 时才逐条比对 peer）。所以"9 个 peer"现在的用途是喂给 dsh-market 的"宿主要求"显示，真正决定能不能挂载的是 `engines.dsh`——换线时两者都要写对。改范围前先跑 `temp/compat-preflight.mjs` 那种预检
- 宿主包同时标 `peerDependenciesMeta.optional`：它们由 DSH 运行时提供、本插件**从不 import**，标 optional 让 npm/pnpm 不再把它们装进依赖树（0.2.0 起这些包彼此还有 peer，沿用自动安装会解析冲突）。闸门只读 `peerDependencies`，语义不受影响
- `dsh.client.inject` 必须是客户端模块图里存在的包（`dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`，0.2.0 实测都在图里）；客户端 `inject` 服务是 `["slots","locale","configForms"]`
- **0.2.0 破坏性变更备忘**：
  - **设置模型**：插件自建 namespace + `settings.register(ns, schema)` → **导出 `Config`（schemastery）**，以 profile entry id 为键的表单；Host 读别人用 `settings.describe()`、写自己用 `settings.update(ns, patch)`；浏览器端 `ctx.configForms.get(entryId)`（`getSnapshot`/`subscribe`/`set`/`unset`/`mutate`），`settingsScope` 与 `settings.get(ns)` 都已删除
  - **`settings.yaml` 被取消**：DSH 在启动后把旧文档整体导入 profile 并改名为 `settings.yaml.imported`（按 section→entry id，`LEGACY_SECTION_ENTRIES` 只映射少数几个），导入失败的 section 只留在重命名后的文件里——所以插件自己被拒挂载时值不会被自动带走（本插件的抢救逻辑就是为它写的）
  - **统计栏几何搬家**：`.bOPqQW_root` 从 0.2.0 起不再有 `width:100%` / 748px 上限 / 侧边 padding（交给 composer 的 `uV2eYG_dock`：`justify-content:center; align-items:center; gap:12px; max-width:100%; padding-top:4px`），字号变 `calc(var(--dsh-content-font-size-secondary,13px) - 1px)`，stat-dialog 面板用 `border-radius:var(--dsw-radius-lg)` + `backdrop-filter:var(--dsw-menu-backdrop-filter)`。**0.2.1 又改了两处**：`.bOPqQW_root` **整个消失**（行被拆成 `activity`/`usage` 两个 dock 条目），pill 圆角从 `999px` + `corner-shape:round` 改成 `--dsw-radius-sm`（8px）。**本插件的 pill/solo 行/明细面板必须跟着这套值走**，否则第三项与自带 pill 不齐平；字号层级现在也得由合并段自己声明（见 `lib/client.js` 的 `.sco_merge`），因为 dock 容器不定字号
  - 自带读数的注册者：0.1.5–0.2.0 是 `StatsPills`（单个 `conversation.composer.dock` 条目，带 `data-composer-stats`，在 `steps === 0 && !hasTokens` 时返回 `null`）；**0.2.1 起是 `dsh-client-ui-chat` 的两个条目** `activity`（order 0，`steps === 0` 时 null）与 `usage`（order 1，无 token 时 null），各自带单数 `data-composer-stat`。与插件同槽位这点不变（锚点的 `parentElement` 仍同时容纳它们）——"统计栏迟到"逻辑因此仍然必要，而且现在是**两个独立的 null**
  - **整站 cookie 鉴权不覆盖插件端点（0.2.1 实测）**：cookie 闸门挂在 `/api` **前缀**路由上，而插件注册的是 `kind: "exact"` 精确路由，host-webserver 的路由表**先查精确表**，所以未带 cookie 的 loopback 请求会**直接到达插件**（实测 `GET /api/session-cost/summary?session=x` → 插件自己的 `404 {"ok":false,"error":"unknown-session"}`，而**未匹配**的 `/api/...` 才是 401）。0.2.0 时期"没 cookie → 401"的说法对 0.2.1 不成立，**别拿 401 判断插件是否挂载**；插件自己那两道 fence（loopback peer + `Host` 校验）是插件端点唯一的闸门，外站 `Host` 实测被拒（403）
  - `session.seq` + `session.eventAt(seq)`、`sessions.list()`、`credentials.resolve(ref)`、`ctx.webServer.register({kind,path,handler})` 在 0.2.0 均未变（已逐项核对 0.2.0-rc.2 的类型与实现）；**0.2.1-rc.2 逐项复核仍全部成立**（`eventAt` 读 `log[seq]`、`seq` 读 `SessionLogOffset(log.length)`、`list()` 映射 store、`resolve` 返回 `{value, source}` 或 `undefined`、`register` 按 `kind` 分表且精确表优先），**0.2.1-rc.5 复查亦同**（四个 API 都在，且 live 探针拿到真实余额）。注意 `session.eventAt()` / `snapshotEvents()` / `ownEvents()` 在 0.2.1 被标为 `@deprecated`（**仍可用**，官方注明 "new calls are prohibited"），本插件的 `liveSessionEvents()` 仍走它——等官方投影 API 定稿后再迁移，别在没替代品时提前改
- **DSH STORE 的 protectedDsh 信号是设计使然**（统计栏合并没有官方扩展点），README 已披露，保持现状，不要"修复"它

## 定价（改 `lib/cost.js` 前必读）

- 计价是**两层**：`periodOf(time)` 先判**价格世代**（`legacy` → `v4:peak`/`v4:offpeak` → 当前 `peak`/`offpeak`），再由 `peakStateOf(time)` 提供日内峰谷。V4 世代必须同时保留两个维度，否则 V4 时代的高峰流量会被按空闲价计（少算一半）
- 世代表：`DEFAULT_PRICING`（2026-09-10 起，V4.1-Flash：Flash ¥1/2、¥0.02/0.04、¥4/8；Pro ¥4.5/9、¥0.15/0.30、¥13.5/27）、`V4_ERA_PRICING`（2026-08-17–09-09）、`LEGACY_PRICING`（之前的平峰价）。`PERIODS` 数组是 fold/计价共用的时段清单，加时段要同步 `zeroBuckets` 初始化、`periodsOf` 的 fallback 与 row 汇总
- `priceOf` 按**名称边界前缀**匹配（`deepseek-v4-flash-2026-01` 命中 `deepseek-v4-flash`，`deepseek-v99` 不命中）；世代表用 `eraEntryOf` + `PRICING_ALIASES` 解析别名。**新增模型 id 时必须同步当前表与别名表**，否则费用静默变 ¥0（0.1.5 的 `deepseek-flash` 就是这么炸的）
- 每次官方调价：更新 `DEFAULT_PRICING`、把上一代价目挪进新世代表并加 cutover 常量、同步 README 定价小节与 `scripts/smoke.mjs` 的用例，**以及面板脚注 `tooltipPricingNote`（zh / en 两份，在 `lib/client.js`）**——脚注是面向用户的价格文案唯一副本：2026-09 换成 V4.1-Flash 后它一直停在 V4 时代的 ¥1.5–3.0 / ¥0.05–0.10 / ¥4.5–9.0，到 2026-11 才被发现。`dom-smoke.mjs` 现在断言脚注带当前世代标记（`2026-09-10`）且不再出现旧价
- **订阅 / 第三方渠道的模型 id 故意不计价**（例如 opencode-go 订阅上报的 `deepseek-v4.1-flash`，官方叫 `deepseek-flash`）：官方价目里没有它，面板显示 `未计价`，用户可用 `pricing` 覆盖。不要把订阅渠道的 id 硬塞进 `DEFAULT_PRICING` 去套官方价——订阅不是逐 token 计费，那样只会给出误导性的"精确"数字。`pricing` 的写法：它**没有声明在 `Config` 里**（schemastery 保留未知键，面板里看不到），只能写进 profile patch 的 `session-cost` 条目 config；`resolvePricing()` 按键合并到 `DEFAULT_PRICING`，平峰/分时段两种形态，**新键缺省字段按 0 计**（所以新 id 要写全四个字段），改完需重启 `dsh web`

## 修改守则

- 服务端读 session 事件**必须走 `liveSessionEvents()`**（不要直接碰 `session.events`）
- 服务端读**别的插件配置**必须走 `entryConfig(ctx, id)`（`settings.describe()`）；**不要**写 `ctx.settings.get(ns)`（0.2.0 无此方法，`?.` 会静默回落默认值）
- 改插件配置字段（`lowBalanceThreshold` 之类）时要**三处同步**：Host 的 `Config` schema、客户端 `configForms.get()` 的 entry id（= bundle patch 的 `id` = `SETTINGS_NAMESPACE`）、面板里读写的字段名；`settings-smoke` 会断言前两者的字面量一致
- 升级 DSH 版本线时：把 `engines.dsh` 与 9 个 peer 一起改成**并集**（`旧线 || 新线`，不要直接替换——`latest` 与 `next` 往往同时在用），`dshReleases` 加一条精确版本（只登记真在真实安装里验过的版本），然后用 `dsh-app-boot` 的 `evaluatePluginCompatibility` 做预检（`temp/compat-preflight.mjs` 会扫描 `%LOCALAPPDATA%\pnpm\global\v11\*` 取最新 store 再按前缀找 `dsh-app-boot`——**两个路径都带 hash，而且 DSH 更新会连全局根目录 hash 一起换**，写死必然过期——并逐版本打印判定），再用 `temp/market-view.mjs` 跑 dsh-market 自己的 `discovery-compatibility` 编译产物，确认「宿主要求」的显示值与实际判定，最后核对本文件「破坏性变更备忘」里那几项（设置模型、统计栏几何、鉴权）是否又变了
- client 保持手写 bundle 格式（只 require react 两个模块）与 `data-plugin-css` 通道；组件是 React 组件（返回 JSX 元素，不要返回 DOM 节点）
- 改统计栏合并逻辑时同步更新 `scripts/dom-smoke.mjs` 的回归用例（统计栏迟到 / 原地 patch 保留面板与监听 / discard 不泄漏面板 / 统计栏行内样式不被改写）
- **不要给自带统计栏写行内样式**（`max-width` / `overflow` / `text-overflow`）：统计栏的宽度由 composer 的 dock 容器给，宽度补丁已在 0.2.3 删除；`dom-smoke.mjs` 里有"统计栏行内样式在挂载/重挂/卸载后逐项不变"的断言，写回去会红
- 新测试加入 `package.json` 的 `"test"` 链；改完必须 `npm run check && npm test` 全绿
- 提交用 Conventional Commits（`feat:` / `fix:` / `chore:` / `docs:`），原子提交；改动涉及运行时契约时同步 bump 版本 + README「兼容性」小节
- 本地仓库有 codegraph 索引（`.codegraph/`，已 gitignore），可先用 codegraph 探索再改
