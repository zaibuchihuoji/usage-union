#!/usr/bin/env node
/**
 * usage-union — Kimi Code Desktop 套餐额度聚合显示（工作区 CLI）
 *
 * 原理：Kimi Code Desktop 通过 app://renderer 协议直接从磁盘上的
 *   <安装目录>/resources/desktop-dist/ 读取前端文件流（每个请求都重新读盘）。
 * 本工具在该目录的 index.html 末尾追加一个 <script>，注入一段自包含的
 * 渲染进程脚本，脚本轮询各 provider 的额度接口，在侧边栏左下角
 * （.side-footer，用户名与设置齿轮之间）渲染额度徽章和悬浮详情。
 *
 * 命令：
 *   node usage-union.mjs install     生成注入脚本并补丁 index.html
 *   node usage-union.mjs uninstall   还原 index.html 并删除注入脚本
 *   node usage-union.mjs status      查看当前状态
 *
 * 选项：
 *   --dist <path>    手动指定 desktop-dist 目录
 *   --config <path>  手动指定 config.toml（默认 ~/.kimi-code/config.toml）
 *
 * 与插件 hook（scripts/auto-patch.mjs）共用 scripts/patch-lib.mjs：
 * 定位、TOML 解析、provider 分类、补丁/还原均为同一份实现，行为一致。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as lib from "./scripts/patch-lib.mjs";

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("--")) ?? "status";
function opt(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

// ---------------------------------------------------------------------------
// install / uninstall / status
// ---------------------------------------------------------------------------
function install() {
  const dist = lib.findDistDir(opt("dist"));
  if (!dist) {
    console.error("✗ 未找到 Kimi Code Desktop 的 desktop-dist 目录（--dist 指定的路径无效或默认位置未找到），请确认后重试。");
    process.exit(1);
  }
  const cfgPath = lib.findConfig(opt("config"));
  const providers = lib.parseProviders(cfgPath);
  const adapters = providers.map(lib.classify);
  if (!adapters.length) {
    console.error("✗ config.toml 未配置任何 provider。");
    process.exit(1);
  }

  const assetsDir = join(dist, "assets");
  mkdirSync(assetsDir, { recursive: true });
  lib.writeProviderConfig(dist, adapters);
  writeFileSync(join(assetsDir, lib.SCRIPT_NAME), lib.buildRuntimeScript(), "utf8");
  lib.patchHtml(join(dist, "index.html"));

  console.log(`✓ 已安装到 ${dist}（usage-union@${lib.VERSION}）`);
  console.log(`  provider 适配器:`);
  for (const a of adapters) {
    console.log(`    - ${a.label} (${a.kind})${a.apiKey ? "" : "  [无 key，仅连通性显示]"}`);
  }
  console.log(`  重启 Kimi Code Desktop（或视图菜单 → 刷新页面）后生效。`);
  console.log(`  应用更新后：插件 hook 会自动重注入；本 CLI 方式需重新运行 install。`);
}

function uninstall() {
  const dist = lib.findDistDir(opt("dist"));
  if (!dist) {
    console.error("✗ 未找到 desktop-dist 目录。");
    process.exit(1);
  }
  lib.uninstallDist(dist);
  console.log(`✓ 已还原 ${join(dist, "index.html")}`);
}

function status() {
  const dist = lib.findDistDir(opt("dist"));
  console.log(`desktop-dist: ${dist ?? "未找到"}`);
  if (!dist) process.exit(1);
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const patched = html.includes(lib.SCRIPT_NAME);
  console.log(`注入状态:   ${patched ? "已注入" : "未注入"}`);
  console.log(`运行时脚本: ${existsSync(join(dist, "assets", lib.SCRIPT_NAME)) ? `存在 (${lib.VERSION})` : "不存在"}`);
  const cfgPath = lib.findConfig(opt("config"));
  console.log(`config:     ${cfgPath}`);
  for (const a of lib.parseProviders(cfgPath).map(lib.classify)) {
    console.log(`  provider: ${a.id}  kind=${a.kind}${a.apiKey ? "  (有 key)" : ""}`);
  }
}

switch (command) {
  case "install": install(); break;
  case "uninstall": uninstall(); break;
  case "status": status(); break;
  default:
    console.error("用法: node usage-union.mjs [install|uninstall|status] [--dist path] [--config path]");
    process.exit(1);
}
