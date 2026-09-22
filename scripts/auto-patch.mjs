/**
 * usage-union 插件 —— 自动补丁脚本
 *
 * 由插件 hook（SessionStart）调用：node --input-type=module -e "await import(...)"
 * 引擎会注入 KIMI_PLUGIN_ROOT 环境变量指向插件根目录。
 *
 * 行为（默认 hook 模式）：静默检查 desktop-dist 的注入状态，缺失或版本变化时重新
 * 注入；任何错误都静默退出（exit 0），绝不阻塞会话启动。最后做一次限频（24h）
 * 的自更新检查（详见 self-update.mjs），更新在下一会话生效。
 *
 * 手动模式：
 *   node auto-patch.mjs --status        查看状态与识别到的 provider
 *   node auto-patch.mjs --force         强制重新注入
 *   node auto-patch.mjs --check-update  立即检查并应用自更新（无视 24h 限频）
 *   node auto-patch.mjs --uninstall     还原 desktop-dist
 *   其余参数：--dist <desktop-dist目录>  --config <config.toml>  --no-update
 *
 * 定位/解析/补丁逻辑与工作区 CLI 共用 scripts/patch-lib.mjs（单一实现，防漂移）。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as lib from "./patch-lib.mjs";
import * as su from "./self-update.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(HERE);
const REPO = "zaibuchihuoji/usage-union";
const startedAt = Date.now();

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const quiet = !has("--status") && !has("--uninstall") && !has("--force") && !has("--check-update") && !args.includes("--verbose");
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
async function main() {
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
  // 供应商清单每次都刷新（不依赖版本号），渠道增删在下次会话启动后自动生效；
  // 同时带上自更新状态，徽章弹窗可提示"已更新待生效"
  const st = su.updateState(PLUGIN_ROOT);
  const update = st?.version ? { running: lib.VERSION, applied: st.version } : null;
  lib.writeProviderConfig(dist, adapters, update);

  const html = readFileSync(indexPath, "utf8");
  const patched = html.includes(lib.SCRIPT_NAME);
  const current = existsSync(runtimePath) ? readFileSync(runtimePath, "utf8") : "";
  const stale = !current.includes(`usage-union@${lib.VERSION}`);

  if (patched && !stale && !has("--force")) {
    say(`usage-union: 已是最新 (@${lib.VERSION})`);
    // --status 的核心诉求之一就是看 provider 识别结果，"已是最新"时也要打印
    if (has("--status")) printProviders(cfgPath, adapters);
  } else {
    writeFileSync(runtimePath, lib.buildRuntimeScript(), "utf8");
    // 升级时也重写标签：?v= 随版本变化，绕过 app:// 的脚本缓存
    lib.patchHtml(indexPath);
    say(`usage-union: 已注入 @${lib.VERSION} → ${dist}（重启应用生效）`);
    if (has("--status")) printProviders(cfgPath, adapters);
  }

  // 自更新：放最后——本地职责已全部完成，失败静默、限时预算（self-update.mjs）
  if (!has("--no-update") && !process.env.USAGE_UNION_NO_UPDATE && Date.now() - startedAt < 9000) {
    try {
      const r = await su.selfUpdate({
        repo: REPO, pluginRoot: PLUGIN_ROOT, currentVersion: lib.VERSION,
        log: say, force: has("--check-update"),
      });
      if (r?.applied) {
        say(`usage-union: 已自动更新到 v${r.version}，下次会话生效`);
        // 立即回写供应商配置：正开着的窗口（旧脚本 + 15s 配置轮询）能马上
        // 在徽章弹窗里看到"已更新待生效"
        try {
          lib.writeProviderConfig(dist, adapters, { running: lib.VERSION, applied: r.version });
        } catch {}
      } else if (r?.reason && (has("--check-update") || has("--status"))) say(`usage-union: 更新检查：${r.latest ?? r.reason}`);
    } catch {}
  }
}

main().catch((e) => { if (!quiet) { console.error("usage-union 失败:", e?.message ?? e); process.exit(1); } });
