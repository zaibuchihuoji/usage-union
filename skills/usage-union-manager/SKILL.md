---
name: usage-union-manager
description: 管理 Kimi Code Desktop 套餐额度徽章的注入 —— 查看状态、强制重装、卸载还原。当用户想查看/修复/移除左下角的额度徽章，或问额度徽章为什么不显示时使用。
---

# Usage Union 套餐额度徽章管理

本插件通过 SessionStart hook 把渲染脚本注入 Kimi Code Desktop 的
`resources/desktop-dist/`（`app://` 协议从磁盘实时读文件）。hook 每次会话启动时
自动检查并修复，通常无需手动干预。

## 诊断（用户说徽章不显示时）

按顺序执行：

1. 运行 `node "$KIMI_PLUGIN_ROOT/scripts/auto-patch.mjs" --status` 查看注入状态。
   - 本地手动调试时用环境变量传入插件根目录：`KIMI_PLUGIN_ROOT="$(pwd)"`。
   - 若 desktop-dist 未找到：应用可能装在非默认路径，加
     `--dist "应用目录/resources/desktop-dist"`。
   - 若提示"无可识别 provider"：检查 `~/.kimi-code/config.toml` 里
     `[providers."..."]` 是否有 Kimi 托管 / bigmodel.cn / z.ai 配置。
2. 修复：`node "$KIMI_PLUGIN_ROOT/scripts/auto-patch.mjs" --force`，然后让用户
   **完全退出并重启 Kimi Code Desktop**（补丁只对新开的渲染进程生效）。
3. 若重启后仍不显示：确认桌面应用版本，desktop-dist 可能被更新覆盖——hook 会在
   下次会话启动时自动重打，或直接执行第 2 步。

## 卸载

`node "$KIMI_PLUGIN_ROOT/scripts/auto-patch.mjs" --uninstall` —— 还原 index.html
备份并删除注入脚本。然后在插件管理里停用/移除本插件，否则下次会话启动 hook 又会注入。

## 注意

- 修改过 `~/.kimi-code/config.toml` 的 provider 配置后，需 `--force` 重新生成
  注入脚本（provider 列表在注入时固化）。
- 额度数据来源：Kimi 托管 = 本地 server `/api/v1/oauth/usage`；智谱 GLM / z.ai =
  `/api/monitor/usage/quota/limit`（key 取自 config.toml）。
