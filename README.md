# dsh-session-cost

DSH（DeepSeek Harness）Web 插件：把**本次会话的 Token 费用估算**与 **DeepSeek API 余额**并入输入框下方的**自带统计行**。

- 费用估算：服务端按**模型逐条计价**——从会话事件日志折叠出每个模型的输入/输出/缓存命中 token（语义与 `dsh-token-meter` 的 `tokenUsage` 投影一致），再按 CNY 单价表（`lib/cost.js`）计算费用，混合多模型的会话也精确。
- 余额查询：复用官方余额接口 `GET {baseURL}/user/balance`（参考插件 [dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats) 的余额方案），凭据经 DSH 的 credentials 缝解析，2 分钟内存缓存 + 单飞防抖；`?refresh=1` 可强制绕过缓存（状态栏的 ⟳ 手动刷新即用此参数）。
- 每 30 秒刷新费用、每 5 分钟刷新余额；token 用量变化后自动触发费用刷新；悬停显示分模型明细与余额构成（充值/赠送），⟳ 按钮手动刷新（强制查询上游，成功后短暂显示"已更新 HH:MM"）。

## 界面

费用/余额段**追加到自带统计行同一行**，与轮次/时长/token 统计并列（会话尚无统计内容时暂不显示）。DSH rc.7 起自带统计行有 748px 宽度上限 + 省略号截断，会把追加的费用/余额段裁掉；本插件会**自动把统计行放宽到容器全宽并取消裁剪**（效果同 zh_pro「统计全显示」，但不依赖它），因此无需安装 zh_pro 也能完整显示：

![并入统计栏](docs/并入统计栏.jpg)

设置项（**设置 → 插件 → 插件配置 → 会话费用显示**，经 `session-cost` settings namespace 持久化到 `~/.dsh/settings.yaml`，即时生效；0.1.1 及更早版本的 localStorage 配置会在首次加载时自动迁移）：

- **低余额阈值**（默认 10 元）：余额**低于**该值时显示为红色，达到或高于时显示为黑色。

> 0.1.5 起移除了「独立状态栏」显示方式（统计栏下方单独一行），只保留并入统计栏；旧配置里的 `displayMode` 键会被忽略。

悬停气泡（示例）：

```
本会话费用估算: ¥0.1234
  deepseek-v4-flash · 输入 12,345 tokens · 输出 1,234 tokens · ¥0.0152
余额: ¥36.44
  充值余额: ¥30.00
  赠送余额: ¥6.44
更新于 10:32
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

## 架构

| 文件 | 角色 |
| --- | --- |
| `lib/index.js` | 服务端：`GET /api/session-cost/summary?session=<id>`（增量折叠会话事件并按模型计价）、`GET /api/session-cost/balance`（DeepSeek 余额，loopback-only 精确路由，`?refresh=1` 强制绕过缓存）；注册 `session-cost` settings namespace（`lowBalanceThreshold`，供配置卡读写） |
| `lib/cost.js` | 纯函数：按模型 token 折叠（replace-last-sample 语义）+ CNY 单价表 + 费用计算 |
| `lib/balance.js` | 纯函数：DeepSeek 余额接口查询与状态归一化 |
| `lib/client.js` | 浏览器端：`conversation.composer.dock` 槽位（id `session-cost`, order 100）+ `settings.plugin.item` 设置卡片（key `session-cost`）；把费用/余额段追加进自带统计行 DOM（MutationObserver 在 React 重渲染后重新挂载），并放宽统计行宽度/取消裁剪让追加段可见（DSH rc.7 起 748px 上限 + ellipsis 会裁掉行尾，详见上文） |

费用为**估算值**：token 用量来自会话日志中 provider 上报的 usage 样本，单价表为写死的默认值，价格变动后请更新 `lib/cost.js` 的 `DEFAULT_PRICING`（或通过插件配置 `pricing` 覆盖）。

## 定价表（默认，CNY / 百万 tokens）

取自官方定价页（[模型 & 价格](https://api-docs.deepseek.com/quick_start/pricing/) 中文版，2026-08-17 起生效）。V4 模型实行**峰谷定价**：**高峰时段为北京时间 9:00–12:00、14:00–18:00**，高峰价格 = 空闲价格的 2 倍；其余时间为空闲时段。插件按每条 usage 样本的事件时间归属时段分别计价；2026-08-17 0 时之前的样本按旧的平峰价（`LEGACY_PRICING`）计价。

| 模型 | 输入（缓存未命中）空闲 / 高峰 | 输入（缓存命中）空闲 / 高峰 | 输出 空闲 / 高峰 |
| --- | --- | --- | --- |
| deepseek-v4-flash | ¥1.5 / ¥3.0 | ¥0.05 / ¥0.10 | ¥4.5 / ¥9.0 |
| deepseek-v4-pro | ¥4.5 / ¥9.0 | ¥0.15 / ¥0.30 | ¥13.5 / ¥27.0 |
| deepseek-chat（V3 遗留，默认） | ¥2（平峰） | ¥0.5 | ¥3 |
| deepseek-reasoner（V3 遗留，默认） | ¥4（平峰） | ¥1 | ¥16 |

`cacheWrite` 无 DeepSeek 等价项（上下文缓存自动命中计费），默认按缓存未命中输入价计（分时段），避免低估。V3 遗留模型未列入官方页面，保持最后已知的平峰价。

悬停明细会显示高峰 / 空闲 / 旧价的费用拆分（跨多个时段时）。

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
