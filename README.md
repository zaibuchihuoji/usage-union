# usage-union — Kimi Code Desktop 套餐额度聚合显示

在 Kimi Code Desktop 侧边栏左下角（用户名右侧、设置齿轮左边）常驻显示**当前所用
模型对应套餐**的额度：套餐名（如 GLM智谱 MAX / Kimi Free）+ 5小时/每周 两行窗口，
点击弹出所有 provider 的完整明细（每月窗口、信用点已用/总量、重置倒计时）。

```
┌────────────────────────────┐
│  会话列表                   │
│  …                         │
├────────────────────────────┤
│ 🐔 火鸡面大王  ●GLM智谱 MAX ⚙│
│                 5小时 1%     │
│                 每周 22%     │
└────────────────────────────┘
```

## 跟随当前套餐（v1.1.0）

- 每 10 秒从本地 server 读取当前活跃模型：优先**正在运行的会话**，其次**最近更新
  的会话**（`/api/v1/sessions` 的 `agent_config.model`），最后全局 `default_model`
  （`/api/v1/config`）。模型→provider 的归属以 `/api/v1/providers` 返回的模型
  列表为权威（托管 Kimi 的模型串用短别名 `kimi-code/...`，与 provider id 的
  `managed:` 前缀不一致）。
- 切换 provider 时徽章跟着切；同一 provider 内换模型（套餐不变）显示不变。
- 检测到一轮对话结束（会话 busy→空闲）立即刷新额度，不用等 3 分钟轮询。
- 检测不到当前模型时回退为"用量最高的 provider"并在徽章标注"（兜底显示）"。
- 当前模型用的是没有额度接口的渠道（自定义 OpenAI 兼容等）时，徽章诚实显示
  "该渠道暂无额度接口"。

## 自适应窗口组合（v1.2.0）

窗口组合由套餐类型决定，从 API 实际返回的字段自适应，不写死"5小时+每周"：

- 短窗口：固定显示 5 小时窗口
- 长窗口：**有周显示周，没周有月就显示月**（Kimi 新套餐只有月限额，旧套餐是周
  限额；智谱目前是周限额）。周月同时存在时徽章显示周、详情里追加月。
- "无限制"仅当套餐确认活跃（智谱有 level / Kimi 有任一窗口字段）且该层确实没有
  限制时才显示（长窗口整层缺失显示"长期 无限制"）；查询失败或无套餐数据不显示。
- 智谱的 TIME_LIMIT（MCP 按次数计的窗口）不进徽章，但在详情里可见。
- 无套餐但账号有按量余额（extraUsage.balance）时，显示"余额 ¥x.xx"而不是干巴巴
  的"无套餐数据"。
- 详情里会列出配置了但没有额度接口的渠道（标"该渠道暂无额度接口"），避免
  "少了一个 provider"的困惑。

## 使用

**方式 A（推荐）：从 GitHub 安装。** 在 Kimi Code Desktop 设置 → 插件 →
"安装自定义插件"里填仓库地址即可：

```
https://github.com/<你的用户名>/usage-union
```

引擎会拉取 `codeload.github.com` 的 zip 包（**优先锚定最新 GitHub Release
tag**，没有 Release 才用默认分支 HEAD），解压拷贝到
`~/.kimi-code/plugins/managed/usage-union/`。要求 `kimi.plugin.json` 在仓库
根目录。之后每次会话启动时，插件的 SessionStart hook 自动检查并注入（应用
更新后下一次会话启动自动修复），无需手动维护。

**方式 B：本地目录安装（开发模式）。** 插件对话框里填本地目录
`<本仓库路径>`（要求根目录含 kimi.plugin.json，即当前结构）。

**方式 C：直接用构建器（不装插件）。**

```bash
node usage-union.mjs install     # 安装（读取 ~/.kimi-code/config.toml，生成并注入脚本）
node usage-union.mjs status      # 查看状态与识别到的 provider
node usage-union.mjs uninstall   # 卸载还原
```

- 安装后**重启 Kimi Code Desktop** 生效（或视图菜单 → 刷新页面）。
- 非默认安装路径时用 `--dist <desktop-dist目录>` 指定；`--config <config.toml>` 同理。
- 插件脚本 `scripts/auto-patch.mjs` 也可独立手动使用：
  `--status`（检查并修复）、`--force`（强制重注入）、`--uninstall`（还原）。

## 已支持的 provider

| provider                        | 显示内容                     | 数据来源 |
| ------------------------------- | ---------------------------- | -------- |
| Kimi 托管（OAuth 登录）          | 套餐名 + 5h/周或月窗口 + 按量余额 | 本地 server `/api/v1/oauth/usage`（复用 SPA 会话凭据） |
| 智谱 GLM Coding Plan             | 套餐等级 + 5h/周窗口 + 信用点明细 | `open.bigmodel.cn/api/monitor/usage/quota/limit` |
| z.ai GLM Coding Plan（国际）     | 同智谱                        | `api.z.ai/api/monitor/usage/quota/limit` |
| Moonshot 开放平台                | 按量余额                      | `/v1/users/me/balance`（公开文档实现，未实测） |
| DeepSeek                         | 按量余额                      | `/user/balance`（公开文档实现，未实测） |
| OpenRouter                       | 剩余/已用美元                 | `/api/v1/credits`（公开文档实现，未实测） |
| 硅基流动 SiliconFlow             | 按量余额                      | `/v1/user/info`（公开文档实现，未实测） |
| MiniMax                          | 按量余额（若端点可用）        | `/v1/get_balance`（未公开文档化，防御性尝试，失败走通用探测） |
| **任意其它渠道**（one-api/new-api 系中转站、OpenAI 兼容网关等） | 订阅额度 `已用 $x / $y`；探不到额度则显示"已连接 · 无额度接口"；连不上显示"连接失败" | 通用探测 `/v1/dashboard/billing/*`，回退 `/v1/models` 连通性检查 |

**调研结论（2026-09，确认无法按 key 查询、只能控制台查看的官方平台）**：
Qwen 阿里云百炼 Coding Plan（sk-sp- 专用 key 无用量 API）、火山方舟 Coding Plan、
百度千帆、腾讯混元、讯飞星火、京东云、MiniMax Token Plan、OpenAI、xAI、Together
——这些渠道会走通用探测显示"已连接 · 无额度接口"。Mistral 的 billing API 需要
admin 密钥，普通 key 不适用。这些平台未来若开放接口，按上文方法加适配器即可。

**同类项目借鉴**：
- [dsh-quota-panel](https://github.com/brittanistrehlowll-oss/dsh-quota-panel)：
  数据过期不空白（失败保留旧读数+灰点标注）、异常数值不折叠成 0%、明文 http
  不发 key——v1.5.0 已借鉴。
- [QuotaBar](https://github.com/QuotaBar/QuotaBar)（macOS 菜单栏，23 家服务）：
  断网恢复自动刷新、请求协议校验——v1.5.1 已借鉴。
- [Pane](https://github.com/ItsJazii/pane)（Windows 托盘，OpenUsage 的 Windows
  移植，20+ 家）：New API 哨兵值（`hard_limit_usd >= 1 亿` = 无上限）、明文
  http 仅允许 IP 字面量内网地址（主机名一律拒绝防 DNS 指向公网）、无密钥渠道
  显示"已连接 · 未配置密钥"——v1.6.0 已借鉴。它对 Kimi 的套餐名来自
  `api.kimi.com/coding/v1/me`（需 OAuth token），我们只能拿 userinfo 的平台
  等级（Free/…），这是本地 server 不代理 `/me` 导致的已知限制。

**任何配置都不会空白**：所有 provider（含未知渠道）都会烘焙进注入脚本参与显示，
未知渠道通过通用探测尽力展示额度。安全代价是对应渠道的 api_key 也会写进注入
脚本（与 config.toml 同等暴露面）。未知渠道能否查到额度取决于对方是否实现了
billing 约定以及 CORS 策略。

**窗口组合是数据驱动的，不假设套餐形态**：短窗口固定 5 小时；长窗口按
"周 → 月 → 剩余里周期最长的窗口"自适应选取；智谱不认识的 CREDIT_LIMIT unit
组合也会带生成标签进详情；TIME_LIMIT（MCP 次数）进详情。新增专属适配器只需在
`auto-patch.mjs` 的 `classify()` 加识别规则、在 `runtime.js` 加一个 fetcher
并在 `adapterFor()` 注册。

## 实现原理（逆向结论）

**桌面应用架构**（`D:\kimi-code\Kimi Code\`，Electron，包名 `kimi-code-app`）：

- 主进程把前端静态目录 `resources/desktop-dist/` 注册为 `app://renderer` 协议，
  **每个请求都从磁盘实时读文件流**（`protocol.handle` + `createReadStream`）。
  → 往 `desktop-dist/index.html` 追加一个 `<script>` 就是天然注入点，无需解包/重签 app.asar。
- 左下角区域是 SPA 的 Sidebar 组件：`.side-footer` > `.side-footer-account`（头像+昵称）
  + `.side-footer-settings`（齿轮）。注入脚本用 1.5s 轮询保证徽章在 Vue 重渲染后仍然存在。
- SPA 的本地 server 凭据在 `sessionStorage`：
  - `kimi-desktop-server-origin` → 本地 server 地址（127.0.0.1:动态端口）
  - `kimi-web.server-credential` → `{credential: <bearer token>}`

**为什么不用官方插件系统**：`kimi.plugin.json` 只支持 `mcpServers` / `skills` /
hooks / 斜杠命令（`pluginCommand`），**没有任何渲染层 UI 扩展点**，做不了常驻徽章。

**Kimi 额度接口**（本地 server，`GET /api/v1/oauth/usage`）：

```json
{ "code": 0, "data": { "kind": "ok", "quota": { "usages": {
    "limit5h":    { "usedRatio": 0.01, "resetAt": "…" },
    "limit7d":    { "usedRatio": 0.22, "resetAt": "…" },
    "monthTotal": { "usedRatio": 0.10, "resetAt": "…" } } } } }
```

**智谱/z.ai 额度接口**（`GET /api/monitor/usage/quota/limit`，`Authorization: <apiKey>` 原样，CORS 全开可直连）：

```json
{ "code": 200, "data": { "level": "max", "limits": [
    { "type": "CREDIT_LIMIT", "unit": 3, "number": 5, "usage": 28000,
      "currentValue": 268, "percentage": 1, "nextResetTime": 1790019296309 },
    { "type": "CREDIT_LIMIT", "unit": 6, "number": 1, "usage": 140000,
      "currentValue": 31082, "percentage": 22, "nextResetTime": 1790089812999 } ] } }
```

`unit:3/number:5` = 5小时窗口，`unit:6/number:1` = 每周窗口；旧套餐用
`TOKENS_LIMIT`（仅 percentage，按 nextResetTime 排序，第一条为 5 小时窗口）。

## 插件系统能力边界（引擎源码实锤）

从桌面包里内嵌的 `kimi-code/packages/agent-core-v2/src/app/plugin/manifest.ts`
编译产物提取到完整的清单解析器。**支持的字段**：`name`（必填）、`version`、
`description`、`keywords`、`homepage`、`license`、`author`、`skills`、`agents`、
`sessionStart: {skill}`、`mcpServers`、`hooks`、`commands`、`interface`、
`skillInstructions`、`systemPrompt`（≤32KB）。**明确不支持**：
`tools`、`apps`、`inject`、`configFile`、`bootstrap`（出现时报
"present but not supported by Kimi plugins"）。没有任何渲染层 UI 扩展字段，
所以徽章必须走注入。hook 定义 schema：`{event, matcher?, command, timeout?}`（1-600s），
执行时引擎注入 `KIMI_PLUGIN_ROOT`（插件根目录）与 `KIMI_CODE_HOME` 环境变量。

## 文件结构

```
usage-union.mjs              工作区构建器/CLI（install | uninstall | status）
plugin/
├── kimi.plugin.json         官方插件清单（SessionStart hook 自动注入）
├── scripts/auto-patch.mjs   自包含安装器（hook 静默模式 + --status/--force/--uninstall）
├── scripts/runtime.js       注入运行时模板（唯一来源，构建器也读它）
└── skills/usage-union-manager/SKILL.md   诊断/修复/卸载技能
```

## 已知限制

- 安全性：provider 的 apiKey 会明文写进 `desktop-dist/assets/usage-union.js`（本机
  用户目录内，与 config.toml 同等暴露面）。只建议个人机器使用。
- hook 依赖 `node` 在 PATH 中（本机 D:\Nodejs）；找不到时 hook 静默失败，
  用 skill / 手动 `--force` 兜底。
- Kimi Free 账号无套餐窗口，徽章不显示 Kimi，悬浮详情里显示"无套餐数据"。
