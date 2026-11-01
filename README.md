# dsh-web-cost —— DeepSeek Harness 网页用量计费插件

统计 DeepSeek Harness 里 **所有会话**的 `web_search` / `web_fetch` 用量，并按官方
Search / Fetch 计价（各 5 元 / 1,000 次成功请求）估算费用。

两个入口：

- **模型工具** `web_usage`：任意会话里让 agent 调用，返回文字报表；
- **输入框下方的 `¥` chip**：点开是弹窗，含**总计费**（自 2026-11-01 起累计）、**折合每月**、逐日表格（标注哪天起计费）、最费 query 的会话。

## 为什么按 query 计价

DeepSeek 的 Search 接口按请求计费，而 Harness 的 `web_search` 一次可以带多条 query——
一条 query 就是一次计费请求。所以真正决定账单的是 query 条数，不是工具调用次数：

```
总计费 = 计费期内 query 条数 × 5 / 1000 元
```

**计费从 2026-11-01 00:00（北京时间）开始**，之前的调用一律不计费；插件把这条时间点写死为
`BILLING_START_DAY`，只有该日零点及之后的 query 进入账单。

`折合每月` = 计费期内 query 总量 ÷ 已计费天数 × 30（总量法）。这等价于"按各月使用天数加权"：
把每月用量除以该月已过天数再加权平均，分子分母同比例，结果与总量 ÷ 总天数相同；唯一的
差异来自月长（28/30/31 天），"÷ 天数 × 30" 已经把它摊平。

`web_fetch` 若由本地 HTTP 提供方完成（Harness 默认），**不计费**；弹窗与报表都会注明这一点，
也可通过 `billedFetch` 参数按 Fetch API 计费口径重算。

## 安装

需要 DeepSeek Harness 0.2.1 及以上，且 `plugin_manager` 能找到 `pnpm`。

从 GitHub 安装（把 `<owner>` 换成你的用户名）：

```text
plugin_manager { action: "install_bundle", target: "github:<owner>/dsh-web-cost" }
```

或从本地目录安装：

```text
plugin_manager { action: "install_bundle", target: "C:\\path\\to\\dsh-web-cost" }
```

安装后：`web_usage` 工具立即生效；`¥` chip 需要**重启一次 DSH**（客户端模块表只在 Host 启动时合成）。

## 使用

模型侧：

```text
web_usage { days: 30, detail: "daily" }
```

参数：`days`（默认 30）、`detail`（`summary` / `daily` / `sessions`）、
`searchRate`、`fetchRate`（元 / 1000 次，默认 5）、`billedFetch`（默认 false）。

UI 侧：`GET /api/web-cost/summary?days=30` 返回 JSON，供 chip 读取；同一份数据也被工具使用。

## 数据来源

- 只读本机会话日志（`ctx.sessionPersistence`），不联网、不写会话、不改任何配置；
- 每个会话按 `eventCount` 增量缓存，日志不增长就不重扫；
- 计费日按**北京时间**切分。

## 目录

| 文件 | 作用 |
|---|---|
| `index.js` | Host 半边：`web_usage` 工具 + `/api/web-cost/summary` |
| `client.js` | 浏览器半边：dock chip 与详情弹窗 |
| `cordis.patch.yml` | bundle 的插件行 |
| `locale/{en,zh}.json` | 插件页的标题与描述 |
| `icon.svg` | 插件图标 |

## 已知限制

- 客户端半边改动后必须重启 DSH 才生效（`dsh-client-modules` 没有全量重扫路径）；
- 抓取是否计费取决于部署的 fetch provider，插件无法自动识别，默认按「本地 HTTP / 不计费」计算；
- 未安装 `dsh-client-modules`（非 Web 端）时只提供 `web_usage` 工具。

## License

MIT
