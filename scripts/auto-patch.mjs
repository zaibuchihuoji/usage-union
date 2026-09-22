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
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const VERSION = "1.7.0";
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_NAME = "usage-union.js";
const BACKUP_NAME = "index.html.usage-union.bak";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const quiet = !has("--status") && !has("--uninstall") && !has("--force") && !args.includes("--verbose");
const say = (m) => { if (!quiet) console.log(m); };

// --- 定位 -----------------------------------------------------------------
function opt(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function findDistDir() {
  const forced = opt("--dist") || process.env.USAGE_UNION_DIST;
  if (forced && existsSync(join(resolve(forced), "index.html"))) return resolve(forced);
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "kimi-code", "Kimi Code", "resources", "desktop-dist"),
    join(process.env.LOCALAPPDATA ?? "", "Programs", "kimi-desktop", "resources", "desktop-dist"),
    "D:\\kimi-code\\Kimi Code\\resources\\desktop-dist",
  ];
  for (const c of candidates) if (c && existsSync(join(c, "index.html"))) return c;
  return null;
}

function findConfig() {
  const forced = opt("--config");
  if (forced) return resolve(forced);
  const home = process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
  return join(home, "config.toml");
}

// --- 解析 config.toml 的 [providers."name"] 直属键 --------------------------
function parseProviders(cfgPath) {
  if (!existsSync(cfgPath)) return [];
  const text = readFileSync(cfgPath, "utf8");
  const providers = [];
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = line.match(/^\[+([^\]]+)\]+$/);
    if (header) {
      const path = header[1].split(".").map((s) => s.trim().replace(/^"|"$/g, ""));
      if (path.length === 2 && path[0] === "providers") {
        current = { name: path[1], fields: {} };
        providers.push(current);
      } else current = null;
      continue;
    }
    if (!current || line === "" || line.startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (kv) current.fields[kv[1]] = kv[2].trim().replace(/^"|"$/g, "");
  }
  return providers;
}

// --- provider 分类（与运行时适配器一一对应） ---------------------------------
function classify(p) {
  const { name, fields } = p;
  const baseUrl = fields.base_url ?? "";
  let host = "", origin = baseUrl;
  try { const u = new URL(baseUrl); host = u.host; origin = `${u.protocol}//${u.host}`; } catch {}
  if (fields.type === "kimi" || host.endsWith("kimi.com")) {
    return { id: name, label: "Kimi", kind: "kimi" };
  }
  if (host.endsWith("moonshot.cn") || host.endsWith("moonshot.ai")) {
    // Moonshot 开放平台（api.moonshot.cn / api.moonshot.ai，type 通常为 openai）只有按量余额接口
    const apiBase = host.endsWith("moonshot.ai") ? "https://api.moonshot.ai" : "https://api.moonshot.cn";
    return { id: name, label: "Moonshot", kind: "moonshot", apiBase, apiKey: fields.api_key ?? "" };
  }
  if (host.endsWith("deepseek.com") || host.endsWith("deepseek.org")) {
    return { id: name, label: "DeepSeek", kind: "deepseek", apiBase: "https://api.deepseek.com", apiKey: fields.api_key ?? "" };
  }
  if (host === "open.bigmodel.cn" || host.endsWith("bigmodel.cn")) {
    return { id: name, label: "GLM智谱", kind: "zhipu", apiBase: "https://open.bigmodel.cn", apiKey: fields.api_key ?? "" };
  }
  if (host === "api.z.ai" || host.endsWith("z.ai")) {
    return { id: name, label: "GLM国际", kind: "zhipu", apiBase: "https://api.z.ai", apiKey: fields.api_key ?? "" };
  }
  if (/(^|\.)openrouter\.ai$/.test(host)) {
    return { id: name, label: "OpenRouter", kind: "openrouter", apiBase: "https://openrouter.ai/api/v1", apiKey: fields.api_key ?? "" };
  }
  if (/(^|\.)siliconflow\.cn$/.test(host)) {
    return { id: name, label: "硅基流动", kind: "siliconflow", apiBase: "https://api.siliconflow.cn", apiKey: fields.api_key ?? "" };
  }
  // 未知渠道：烘焙进去做通用额度探测（one-api/new-api 系 billing 约定），
  // 探不到也会显示连接状态——保证任何配置都有内容可看
  return { id: name, label: name, kind: "generic", apiBase: origin, host, apiKey: fields.api_key ?? "" };
}

// --- 生成运行时脚本 / 供应商配置 --------------------------------------------
function buildRuntimeScript() {
  const template = readFileSync(join(HERE, "runtime.js"), "utf8");
  return `/* usage-union@${VERSION} */\n` + template;
}

// 供应商清单单独成文件：hook 每次运行都重写（不依赖版本号），渠道增删在下次
// 会话启动后自动生效
function writeProviderConfig(dist, adapters) {
  const config = JSON.stringify({ version: VERSION, providers: adapters });
  writeFileSync(join(dist, "assets", "usage-union.config.json"), config, "utf8");
}

// --- 补丁 / 还原 --------------------------------------------------------------
function patchHtml(indexPath) {
  const html = readFileSync(indexPath, "utf8");
  const backupPath = join(dirname(indexPath), BACKUP_NAME);
  if (!existsSync(backupPath)) copyFileSync(indexPath, backupPath);
  const scriptTag = `    <script src="/assets/${SCRIPT_NAME}"></script>\n`;
  let next = html.split("\n").filter((l) => !l.includes(SCRIPT_NAME)).join("\n");
  if (!next.includes("</body>")) throw new Error("index.html 结构异常");
  next = next.replace("</body>", `${scriptTag}</body>`);
  writeFileSync(indexPath, next, "utf8");
}

function uninstallDist(dist) {
  const indexPath = join(dist, "index.html");
  const backupPath = join(dist, BACKUP_NAME);
  if (existsSync(backupPath)) {
    copyFileSync(backupPath, indexPath);
    rmSync(backupPath, { force: true });
  } else if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, "utf8");
    writeFileSync(indexPath, html.split("\n").filter((l) => !l.includes(SCRIPT_NAME)).join("\n"), "utf8");
  }
  rmSync(join(dist, "assets", SCRIPT_NAME), { force: true });
  rmSync(join(dist, "assets", "usage-union.config.json"), { force: true });
  rmSync(join(dist, SCRIPT_NAME), { force: true });
}

// --- 主流程 -------------------------------------------------------------------
function main() {
  if (has("--uninstall")) {
    const dist = findDistDir();
    if (!dist) { console.error("未找到 desktop-dist"); process.exit(1); }
    uninstallDist(dist);
    console.log(`✓ 已还原 ${dist}`);
    return;
  }

  const dist = findDistDir();
  if (!dist) { say("usage-union: desktop-dist 未找到，跳过"); return; }
  const indexPath = join(dist, "index.html");
  const runtimePath = join(dist, "assets", SCRIPT_NAME);

  const cfgPath = findConfig();
  const adapters = parseProviders(cfgPath).map(classify);
  if (!adapters.length) { say("usage-union: config.toml 未配置任何 provider，跳过"); return; }

  mkdirSync(join(dist, "assets"), { recursive: true });
  // 供应商清单每次都刷新（不依赖版本号），渠道增删在下次会话启动后自动生效
  writeProviderConfig(dist, adapters);

  const html = readFileSync(indexPath, "utf8");
  const patched = html.includes(SCRIPT_NAME);
  const current = existsSync(runtimePath) ? readFileSync(runtimePath, "utf8") : "";
  const stale = !current.includes(`usage-union@${VERSION}`);

  if (patched && !stale && !has("--force")) { say(`usage-union: 已是最新 (@${VERSION})`); return; }

  writeFileSync(runtimePath, buildRuntimeScript(), "utf8");
  if (!patched || has("--force")) patchHtml(indexPath);
  say(`usage-union: 已注入 @${VERSION} → ${dist}（重启应用生效）`);
  if (has("--status")) {
    console.log(`  config: ${cfgPath}`);
    for (const a of adapters) console.log(`  provider: ${a.label} (${a.kind})`);
  }
}

try { main(); } catch (error) {
  if (!quiet) { console.error("usage-union 失败:", error?.message ?? error); process.exit(1); }
  // hook 模式：静默失败，不影响会话
}
