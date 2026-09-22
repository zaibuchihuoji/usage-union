/**
 * usage-union 插件 —— 自动补丁脚本
 *
 * 由插件 hook（SessionStart）调用：node --input-type=module -e "await import(...)"
 * 引擎会注入 KIMI_PLUGIN_ROOT 环境变量指向插件根目录。
 *
 * 行为（默认 hook 模式）：静默检查 desktop-dist 的注入状态，缺失或版本变化时重新
 * 注入；任何错误都静默退出（exit 0），绝不阻塞会话启动。
 *
 * 手动模式：
 *   node auto-patch.mjs --status      查看状态与识别到的 provider
 *   node auto-patch.mjs --force       强制重新注入
 *   node auto-patch.mjs --uninstall   还原 desktop-dist
 *   其余参数：--dist <desktop-dist目录>  --config <config.toml>
 *
 * 定位/解析/补丁逻辑与工作区 CLI 共用 scripts/patch-lib.mjs（单一实现，防漂移）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as lib from "./patch-lib.mjs";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const quiet = !has("--status") && !has("--uninstall") && !has("--force") && !args.includes("--verbose");
const say = (m) => { if (!quiet) console.log(m); };

function opt(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function printProviders(cfgPath, adapters) {
  console.log(`  config: ${cfgPath}`);
  for (const a of adapters) {
    console.log(`  provider: ${a.label} (${a.kind})${a.apiKey ? "  (有 key)" : "  (无 key)"}`);
  }
}

// --- 主流程 -------------------------------------------------------------------
function main() {
  if (has("--uninstall")) {
    const dist = lib.findDistDir(opt("--dist"));
    if (!dist) { console.error("未找到 desktop-dist"); process.exit(1); }
    lib.uninstallDist(dist);
    console.log(`✓ 已还原 ${dist}`);
    return;
  }

  const dist = lib.findDistDir(opt("--dist") || process.env.USAGE_UNION_DIST);
  if (!dist) { say("usage-union: desktop-dist 未找到，跳过"); return; }
  const indexPath = join(dist, "index.html");
  const runtimePath = join(dist, "assets", lib.SCRIPT_NAME);

  const cfgPath = lib.findConfig(opt("--config"));
  const adapters = lib.parseProviders(cfgPath).map(lib.classify);
  if (!adapters.length) { say("usage-union: config.toml 未配置任何 provider，跳过"); return; }

  mkdirSync(join(dist, "assets"), { recursive: true });
  // 供应商清单每次都刷新（不依赖版本号），渠道增删在下次会话启动后自动生效
  lib.writeProviderConfig(dist, adapters);

  const html = readFileSync(indexPath, "utf8");
  const patched = html.includes(lib.SCRIPT_NAME);
  const current = existsSync(runtimePath) ? readFileSync(runtimePath, "utf8") : "";
  const stale = !current.includes(`usage-union@${lib.VERSION}`);

  if (patched && !stale && !has("--force")) {
    say(`usage-union: 已是最新 (@${lib.VERSION})`);
    // --status 的核心诉求之一就是看 provider 识别结果，"已是最新"时也要打印
    if (has("--status")) printProviders(cfgPath, adapters);
    return;
  }

  writeFileSync(runtimePath, lib.buildRuntimeScript(), "utf8");
  if (!patched || has("--force")) lib.patchHtml(indexPath);
  say(`usage-union: 已注入 @${lib.VERSION} → ${dist}（重启应用生效）`);
  if (has("--status")) printProviders(cfgPath, adapters);
}

try { main(); } catch (error) {
  if (!quiet) { console.error("usage-union 失败:", error?.message ?? error); process.exit(1); }
  // hook 模式：静默失败，不影响会话
}
