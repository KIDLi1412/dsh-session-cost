# dsh-session-cost

DSH（DeepSeek Harness）Web 插件：把**本次会话的 Token 费用估算**与 **DeepSeek API 余额**并入输入框下方的**自带统计栏**。

- 费用估算：服务端按**模型逐条计价**——从会话事件日志折叠出每个模型的输入/输出/缓存命中 token（语义与 `dsh-token-meter` 的 `tokenUsage` 投影一致），再按 CNY 单价表（`lib/cost.js`）计算费用，混合多模型的会话也精确。
- 余额查询：复用官方余额接口 `GET {baseURL}/user/balance`（参考插件 [dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats) 的余额方案），凭据经 DSH 的 credentials 缝解析，2 分钟内存缓存 + 单飞防抖；`?refresh=1` 可强制绕过缓存（状态栏的 ⟳ 手动刷新即用此参数）。
- 每 30 秒刷新费用、每 5 分钟刷新余额；token 用量变化后自动触发费用刷新；**点击统计栏里的费用 pill** 展开分模型明细与余额构成（充值/赠送），面板内 ⟳ 手动刷新（强制查询上游，成功后短暂显示"已更新 HH:MM"）。

## 界面

费用/余额是一个与自带统计项**同款的可点击 pill**，追加在自带统计栏同一行；若该会话自带统计栏整行都不存在（全新会话，或冷会话加载的头一秒），pill 会**先独立显示在输入框上方**（同一套字号/内边距/圆角），统计栏一出现就自动并回那一行：

```
[⏱ 2 轮 61 步 · 287 tok/s]   [🗄 6.6M tok · 缓存命中 97%]   [¥ 费用 ¥1.94 · 余额 ¥3.63]
```

- **点击 pill** 在统计栏上方展开明细面板，用的是自带两个 pill 点击展开时的**同一套皮肤**（圆角 12、`--dsw-specific-menu` 背景、标题 + 分隔线 + `dt/dd` 网格、12/18 字号）：标题行左侧「费用」、右侧总额；网格里**每个模型一行**（输入/输出 tokens 与费用，跨峰谷时附 `高峰/空闲` 拆分），然后是余额与充值/赠送构成；底部是更新时间、⟳ 手动刷新与计价说明。点击面板外或按 `Esc` 关闭。
- 面板以 `position:fixed` 挂到 `document.body` 并做视口夹取（与原生 stat dialog 相同的 measure→place 流程、同样的 8px 间距 / 12px 边距），所以不会被统计栏的 `overflow` 裁掉；数据更新走**原地 patch**（不重建节点），因此面板开着时刷新数值不会闪断、也不会丢焦点。
- DSH 0.1.5 起自带统计栏改为 **`StatsPills`**：居中的 flex 行、由带图标的 pill 组成（`data-composer-stats` 标记），取代了此前单行省略号文本的 `StatsLine`。本插件的 pill 因此按同一套 13/20 字号层级、同一 `1px 8px` 内边距与 24px 圆角、同一 hover / `aria-expanded` 背景渲染，自带 ¥ 图标，视觉上与自带 pill 齐平。
- **自带统计栏会"迟到"**：`StatsPills` 在会话有步骤或 token 之前返回 `null`（整行都不存在），所以插件必须能在统计栏**之后**挂载的情况下仍然接上去——见下文「兼容性」。
- **数据也会迟到**：刚重启 host 时首次费用/余额响应还在路上，组件却已经挂载（费用等第一次 summary、余额等上游查询或缓存）。所以观察器**无条件安装**：曾经在"暂时没东西可画"时干脆不装，结果没有任何人在等统计栏出现，费用段要等页面刷新（数据已被预热）才显示——这就是「每次重启后打开界面都要刷新一次」的原因。现在首个 payload 到达前 `sync()` 只是不画东西，观察器始终在岗。
- **切换会话时整个输入区会被拆掉重建**：打开一个**没有客户端缓存**的会话要等约 1 秒，这一秒里锚点处于**已脱离文档**的子树中。观察器过去只在"宿主仍然连在文档里"时才重新挂载自己——一次这样的回调就让它**永久失效**，费用段再也回不来，只能刷新页面（刷新等于重新挂载、装上新的观察器）。现在重新挂载是**无条件**的（脱离文档的节点依然会派发子树变更），另有一个 1 秒看门狗兜底：只要该显示的 pill 不在位（节点被 React 抹掉、统计栏被整体换掉、锚点换了父节点）就重新接回去。
- ≤ 0.1.4 的自带统计行有 748px 宽度上限 + 省略号截断，会把追加段裁掉；本插件会**自动把统计行放宽到容器全宽并取消裁剪**（效果同 zh_pro「统计全显示」，但不依赖它），因此无需安装 zh_pro 也能完整显示。

设置项（**设置 → 插件 → 插件配置 → 会话费用显示**，经 `session-cost` settings namespace 持久化到 `~/.dsh/settings.yaml`，即时生效；0.1.1 及更早版本的 localStorage 配置会在首次加载时自动迁移）：

- **低余额阈值**（默认 10 元）：余额**低于**该值时显示为红色，达到或高于时显示为黑色。

> 0.1.5 起移除了「独立状态栏」显示方式（统计栏下方单独一行），只保留并入统计栏；旧配置里的 `displayMode` 键会被忽略。

展开面板内容（示例）：

```
费用                                    ¥1.9400
────────────────────────────────────────────────
deepseek-v4-flash     输入 169,013 · 输出 46,512 · ¥1.8900
deepseek-v4-pro       输入 1,000 · 输出 500 · ¥0.0500 · 高峰 ¥0.02 · 空闲 ¥0.03
余额                                    ¥36.44
充值余额                                ¥30.00
赠送余额                                 ¥6.44
更新于 10:32                                 ⟳
费用为估算值：token 用量来自会话日志，单价见官方定价页（…）。
```

## 安装

从 npm 安装：

```powershell
dsh plugin --profile web add @kidli1412/dsh-session-cost
```

从 GitHub 安装：

```powershell
dsh plugin --profile web add github:KIDLi1412/dsh-session-cost
```

本地开发（链接安装，改动即时生效）：

```powershell
dsh plugin --profile web add link:path/to/dsh-session-cost
```

安装后重启 `dsh web`，浏览器硬刷新（Ctrl+Shift+R）。打开任意会话即可在自带统计行末尾看到费用与余额。

移除：

```powershell
dsh plugin --profile web remove @kidli1412/dsh-session-cost
```

## 兼容性 / Compatibility

- **DSH**：manifest 通过 `dsh.compatibility.dshReleases` 将官方最新版本 `0.1.5-rc.1`、`0.1.5-rc.2` 逐项声明为 `compatible`（DSH STORE 的精确逐版本兼容证据；仅范围声明不会恢复上架）。插件使用的客户端注入（`dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`）与 Host 服务（`settings` namespace、`webServer` 精确路由、`session.seq` + `session.eventAt`）在 0.1.5 版本线上保持稳定。
- **Node**：`^22.19.0 || >=24.0.0`（与 DSH 一致）。
- **宿主要求（dsh-market 显示）**：`engines.dsh: ^0.1.5-rc.1`，并将运行时依赖的 lockstep 宿主包声明为 `peerDependencies`（`dsh-host-webserver` / `dsh-session` / `dsh-credentials` / `dsh-settings` 与客户端模块 `dsh-api-remotes` / `dsh-client-connection` / `dsh-client-locale` / `dsh-client-ui-conversation` / `dsh-client-ui-settings`，均为 `^0.1.5-rc.1`）；插件市场会据此显示"宿主要求"并判断与当前 DSH 是否匹配。
- **0.2.0（DSH 0.1.5 适配 + 交互重做）**：三处必须改动，否则统计栏里**完全看不到**费用/余额段——
  1. **不再 require `@deepseek-ai/dsh-client-ui-primitives`**。0.1.5 起该包不再随 DSH 安装（依赖树里已无此包，客户端模块图因此没有这一行），而 plugin bundle 的 `require()` 对**未注册模块是抛错**的（loader 的 loud 语义），一处 require 就会让**整个客户端 half 加载失败**：dock 锚点、合并段、设置卡片全部消失。本插件的图标改为内联 SVG 自绘，bundle 不再依赖任何可选宿主模块。
  2. **统计栏标记与定位**：优先按 `data-composer-stats` 属性定位（0.1.5 新增），文本 `N 轮 · M 步` 只作旧版回退且改为非锚定匹配（0.1.5 的 pill 文本已无 `·` 分隔）。
  3. **两个"迟到"**必须同时处理：`StatsPills` 在会话有步骤/token 前返回 `null`（**统计栏迟到**）→ 观察器必须监听容器**子树**（`childList` + `characterData` + `subtree`）；重启 host 后首次 summary/余额响应仍在路上（**数据迟到**）→ 观察器必须**无条件安装**。
  4. **价格与模型 id 同步跟进**：0.1.5 把 V4-Flash 路由成短 id `deepseek-flash`，且官方在 2026-09-10 发布 V4.1-Flash 并调价；本版引入**价格世代**模型（`legacy` / `v4:*` / 当前 `peak`/`offpeak`）与别名解析，详见下文「定价表」。
  交互上，费用/余额段从"悬停气泡"改为**与自带统计项同款的可点击 pill + 点击展开面板**。
- **0.2.1（切会话丢费用 + 统计栏缺席时的显示）**：
  1. **切会话不再丢 pill**。切换会话（尤其是**没有客户端缓存**、要等约 1 秒的旧会话）时整个输入区被拆掉重建，锚点会短暂处于**脱离文档**的子树中，而 0.2.0 只在宿主仍 `isConnected` 时才重新挂载观察器——一次这样的回调就让观察器**永久失效**：费用消失，切回新会话也不恢复，必须刷新页面（刷新等于重新挂载、装上新的观察器）。0.2.1 无条件重挂（脱离文档的子树照样派发变更），并加 1 秒看门狗兜底补挂；观察器也改为**每个组件挂载只装一次**，数据变化走 `sync()` 推入（不再每 30 秒拆掉重建节点）。
  2. **统计栏缺席时先挂在锚点自身**（`[data-solo]`，字号/内边距/最大宽度照抄 `.bOPqQW_root`），统计栏一出现即挪回栏内——全新会话与冷会话加载中都有费用读数。
- **0.1.8（DSH 0.1.2 适配）**：rc.1 起 live session 不再携带 `.events` 数组——事件总数读 `session.seq`、逐条读 `session.eventAt(seq)`（与官方 `dsh-token-meter` 相同的读法），费用折叠已适配；客户端注入模块列表同步为新架构模块（见上）。
- **降级说明**：本版本已不再声明 `0.1.2-*` 兼容（0.2.0 起 `dshReleases` 只列 0.1.5 线）。需要 0.1.2 线的用户请使用 0.1.9。

## 架构

| 文件 | 角色 |
| --- | --- |
| `lib/index.js` | 服务端：`GET /api/session-cost/summary?session=<id>`（增量折叠会话事件并按模型计价）、`GET /api/session-cost/balance`（DeepSeek 余额，loopback-only 精确路由，`?refresh=1` 强制绕过缓存）；注册 `session-cost` settings namespace（`lowBalanceThreshold`，供配置卡读写） |
| `lib/cost.js` | 纯函数：按模型 token 折叠（replace-last-sample 语义）+ CNY 单价表 + 费用计算 |
| `lib/balance.js` | 纯函数：DeepSeek 余额接口查询与状态归一化 |
| `lib/client.js` | 浏览器端：`conversation.composer.dock` 槽位（id `session-cost`, order 100）+ `settings.plugin.item` 设置卡片（key `session-cost`）；把费用/余额 pill 追加进自带统计栏 DOM（`startStatsRowObserver`：子树 MutationObserver + 无条件重挂 + 1 秒看门狗，统计栏迟到/被 React 重渲染/切会话重建后都会重新挂载；统计栏不存在时先挂在锚点自身；`updateMergeNode` 原地 patch 数值），点击展开挂到 `document.body` 的明细面板（`placeOpenPanel` 做视口夹取） |

费用为**估算值**：token 用量来自会话日志中 provider 上报的 usage 样本，单价表为写死的默认值，价格变动后请更新 `lib/cost.js` 的 `DEFAULT_PRICING`（或通过插件配置 `pricing` 覆盖）。

## 定价表（默认，CNY / 百万 tokens）

取自官方定价页（[模型 & 价格](https://api-docs.deepseek.com/quick_start/pricing/) 中文版）。计费为**峰谷 + 价格世代**两层：

- **峰谷**：高峰 = 北京时间工作日 9:00–12:00、14:00–18:00（官网英文页写作 UTC 周一至周五 01:00–04:00 / 06:00–10:00），高峰价 = 空闲价的 2 倍；**2026-08-23 0 时起周末（周六、周日）全天按空闲价**。
- **价格世代**（同一条会话可以跨越多次调价，插件按每条 usage 样本的**事件时间**归属世代，不回溯改价）：

| 世代 | 生效区间（北京时间） | 说明 |
| --- | --- | --- |
| `peak` / `offpeak` | 2026-09-10 0:00 起（V4.1-Flash 发布） | 当前价，见下表 |
| `v4:peak` / `v4:offpeak` | 2026-08-17 0:00 – 2026-09-09 | V4 时代的峰谷价（Flash ¥1.5/3、¥0.05/0.10、¥4.5/9），`V4_ERA_PRICING` |
| `legacy` | 2026-08-17 0:00 之前 | 平峰旧价（Flash ¥1、¥0.02、¥2），`LEGACY_PRICING` |

**当前价（2026-09-10 起，CNY / 百万 tokens）**：

| 模型 id | 输入（缓存未命中）空闲 / 高峰 | 输入（缓存命中）空闲 / 高峰 | 输出 空闲 / 高峰 |
| --- | --- | --- | --- |
| deepseek-flash（V4.1-Flash，**DSH 0.1.5 实际路由的 id**） | ¥1 / ¥2 | ¥0.02 / ¥0.04 | ¥4 / ¥8 |
| deepseek-v4-flash（已下线，别名到 V4.1-Flash） | ¥1 / ¥2 | ¥0.02 / ¥0.04 | ¥4 / ¥8 |
| deepseek-v41-flash（同一模型的另一种拼写） | ¥1 / ¥2 | ¥0.02 / ¥0.04 | ¥4 / ¥8 |
| deepseek-v4-flash-vision-exp（已下线，别名到 V4.1-Flash） | ¥1 / ¥2 | ¥0.02 / ¥0.04 | ¥4 / ¥8 |
| deepseek-v4-pro（V4-Pro-0813，官方确认 2026-09-14 后继续提供） | ¥4.5 / ¥9 | ¥0.15 / ¥0.30 | ¥13.5 / ¥27 |
| deepseek-chat / deepseek-reasoner（V3 遗留名，2026-07-24 起别名到 Flash） | ¥1 / ¥2 | ¥0.02 / ¥0.04 | ¥4 / ¥8 |

> **模型 id 会变，变了就会静默算成 ¥0**：DSH 0.1.5 把 V4-Flash 路由成短 id `deepseek-flash`（界面显示 "DeepSeek-V41-Flash"），而旧表里只有 `deepseek-v4-flash` —— 找不到单价 → 整场会话费用恒为 0，这正是 0.1.5 升级后的"费用一直是 0"。因此本版：
> - 当前表列出**全部仍被接受的 id**（含已下线的旧名，避免历史会话读成未计价）；
> - 匹配改为**名称边界前缀**：`deepseek-v4-flash-2026-01` 这类带日期后缀的 id 归到 `deepseek-v4-flash`，而 `deepseek-v99` 这种不同型号**不会**被误当成 flash，而是判为未计价；世代表（`V4_ERA_PRICING`/`LEGACY_PRICING`）通过 `PRICING_ALIASES` 做同样的别名解析，旧世代里的新 id 也按旧价计费；
> - 明细面板里未匹配到单价的模型显示红色 **未计价**，不再伪装成 ¥0；`GET /api/session-cost/summary` 附带 `diagnostics`（事件数 / 已识别模型 / 已计价模型数），便于一眼定位。

`cacheWrite` 无 DeepSeek 等价项（上下文缓存自动命中计费），默认按缓存未命中输入价计（分时段），避免低估。

明细面板会显示高峰 / 空闲 / V4 价 / 旧价的费用拆分（跨时段或跨世代时）。

> 官方英文页另有**美元**价格（Flash $0.15/$0.30 输入、$0.003/$0.006 缓存命中、$0.6/$1.2 输出），与本表的人民币价按同一份价目表换算，插件统一按**人民币**计价（与余额接口的 CNY 口径一致）。

插件配置（可选）可覆盖定价——平峰格式（所有时段同价）或分时段格式：

```yaml
# ~/.dsh/settings.yaml 或 profile 插件配置
session-cost:
  pricing:
    deepseek-v4-flash:
      input: 1
      cacheRead: 0.02
      cacheWrite: 1
      output: 2
    # 或分时段（offpeak/peak 各自覆盖，未给字段继承默认）：
    # deepseek-v4-pro:
    #   offpeak: { input: 4.5, output: 13.5 }
    #   peak: { input: 9, output: 27 }
```

`pricing` 与配置卡写入的 `lowBalanceThreshold` 共存于同一个 `session-cost:` section，互不覆盖（schemastery 解析保留未知键；`pricing` 仍由服务端从插件 config 读取）。

## 安全

- 两个端点均为 loopback-only 精确路由（peer socket 地址 + Host 双重校验），浏览器同源调用。
- API Key 不落盘：请求时经 credentials 缝解析 `llm-deepseek` 命名空间的 `apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）。
- 余额缓存仅存于内存，2 分钟 TTL。

## License

MIT
