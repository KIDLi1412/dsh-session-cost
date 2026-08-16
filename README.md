# dsh-session-cost

DSH（DeepSeek Harness）Web 插件：在**对话底部状态栏**（输入框下方、自带统计行之下）显示**本次会话的 Token 费用估算**与 **DeepSeek API 余额**。

- 费用估算：服务端按**模型逐条计价**——从会话事件日志折叠出每个模型的输入/输出/缓存命中 token（语义与 `dsh-token-meter` 的 `tokenUsage` 投影一致），再按 CNY 单价表（`lib/cost.js`）计算费用，混合多模型的会话也精确。
- 余额查询：复用官方余额接口 `GET {baseURL}/user/balance`（参考插件 [dsh-usage-stats](https://github.com/Ychris12138/dsh-usage-stats) 的余额方案），凭据经 DSH 的 credentials 缝解析，2 分钟内存缓存 + 单飞防抖；`?refresh=1` 可强制绕过缓存（状态栏的 ⟳ 手动刷新即用此参数）。
- 状态栏每 30 秒刷新费用、每 5 分钟刷新余额；token 用量变化后自动触发费用刷新；悬停显示分模型明细与余额构成（充值/赠送），⟳ 按钮手动刷新（强制查询上游，成功后短暂显示"已更新 HH:MM"）。

## 界面

两种显示方式可在 **设置 → 插件 → 插件配置 → 会话费用显示** 中切换（localStorage 持久化，即时生效）：

- **显示方式**：独立状态栏（默认）/ 并入统计栏。
- **低余额阈值**（默认 10 元）：余额**低于**该值时显示为红色，达到或高于时显示为黑色。

**独立状态栏（默认）**——统计栏下方单独一行：

![独立状态栏](docs/独立状态栏.jpg)

**并入统计栏**——追加到自带统计行同一行（会话尚无统计内容时暂不显示）：

![并入统计栏](docs/并入统计栏.jpg)

两种方式下悬停均显示分模型明细与余额构成；⟳ 手动刷新（强制查询上游，成功后短暂显示"已更新 HH:MM"）。

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

安装后重启 `dsh web`，浏览器硬刷新（Ctrl+Shift+R）。打开任意会话即可在输入框下方看到状态栏。

移除：

```powershell
dsh plugin --profile web remove @kidli1412/dsh-session-cost
```

## 架构

| 文件 | 角色 |
| --- | --- |
| `lib/index.js` | 服务端：`GET /api/session-cost/summary?session=<id>`（增量折叠会话事件并按模型计价）、`GET /api/session-cost/balance`（DeepSeek 余额，loopback-only 精确路由，`?refresh=1` 强制绕过缓存） |
| `lib/cost.js` | 纯函数：按模型 token 折叠（replace-last-sample 语义）+ CNY 单价表 + 费用计算 |
| `lib/balance.js` | 纯函数：DeepSeek 余额接口查询与状态归一化 |
| `lib/client.js` | 浏览器端：`conversation.composer.dock` 槽位（id `session-cost`, order 100）+ `settings.plugin.item` 设置卡片；显示方式存 localStorage（`dsh-session-cost:config`），"并入统计栏"模式把费用/余额段追加进自带统计行 DOM（MutationObserver 在 React 重渲染后重新挂载） |

费用为**估算值**：token 用量来自会话日志中 provider 上报的 usage 样本，单价表为写死的默认值，价格变动后请更新 `lib/cost.js` 的 `DEFAULT_PRICING`（或通过插件配置 `pricing` 覆盖）。

## 定价表（默认，CNY / 百万 tokens）

取自官方定价页（[模型 & 价格](https://api-docs.deepseek.com/quick_start/pricing/) 中文版，2026-08 现行价；2026-08-17 起改为峰谷定价，见官方页面）：

| 模型 | 输入（缓存未命中） | 输入（缓存命中） | 输出 |
| --- | --- | --- | --- |
| deepseek-v4-flash | ¥1 | ¥0.02 | ¥2 |
| deepseek-v4-pro | ¥3 | ¥0.025 | ¥6 |
| deepseek-chat（V3 遗留，默认） | ¥2 | ¥0.5 | ¥3 |
| deepseek-reasoner（V3 遗留，默认） | ¥4 | ¥1 | ¥16 |

`cacheWrite` 无 DeepSeek 等价项（上下文缓存自动命中计费），默认按缓存未命中输入价计，避免低估。

插件配置（可选）可覆盖定价：

```yaml
# ~/.dsh/settings.yaml 或 profile 插件配置
session-cost:
  pricing:
    deepseek-v4-flash:
      input: 1
      cacheRead: 0.02
      cacheWrite: 1
      output: 2
```

## 安全

- 两个端点均为 loopback-only 精确路由（peer socket 地址 + Host 双重校验），浏览器同源调用。
- API Key 不落盘：请求时经 credentials 缝解析 `llm-deepseek` 命名空间的 `apiKeyEnv`（默认 `DEEPSEEK_API_KEY`）。
- 余额缓存仅存于内存，2 分钟 TTL。

## License

MIT
