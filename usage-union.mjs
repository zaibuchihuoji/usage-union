#!/usr/bin/env node
/**
 * usage-union — Kimi Code Desktop 套餐额度聚合显示
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
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKER = "usage-union";
const SCRIPT_NAME = "usage-union.js";
const BACKUP_NAME = "index.html.usage-union.bak";
// 与 plugin/scripts/auto-patch.mjs 的 VERSION 保持一致：注入文件带版本头，
// 插件 hook 靠它判断新旧，避免工作区安装后被 hook 立刻重写
const VERSION = "1.7.0";

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
// 定位 desktop-dist
// ---------------------------------------------------------------------------
function findDistDir() {
  const forced = opt("dist");
  if (forced) return resolve(forced);
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "kimi-code", "Kimi Code", "resources", "desktop-dist"),
    join(process.env.LOCALAPPDATA ?? "", "Programs", "kimi-desktop", "resources", "desktop-dist"),
    "D:\\kimi-code\\Kimi Code\\resources\\desktop-dist",
  ];
  for (const c of candidates) {
    if (c && existsSync(join(c, "index.html"))) return c;
  }
  return null;
}

function findConfig() {
  const forced = opt("config");
  if (forced) return resolve(forced);
  const home = process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
  return join(home, "config.toml");
}

// ---------------------------------------------------------------------------
// 极简 TOML section 解析：只关心 [providers."name"] 直属键
// ---------------------------------------------------------------------------
function parseProviders(cfgPath) {
  if (!existsSync(cfgPath)) return [];
  const text = readFileSync(cfgPath, "utf8");
  const providers = [];
  let current = null; // { name, depth, fields }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = line.match(/^\[+([^\]]+)\]+$/);
    if (header) {
      const path = header[1].split(".").map((s) => s.trim().replace(/^"|"$/g, ""));
      // providers."name" —— 两段；更深（.oauth 等）不算 provider 本体
      if (path.length === 2 && path[0] === "providers") {
        current = { name: path[1], fields: {} };
        providers.push(current);
      } else {
        current = null;
      }
      continue;
    }
    if (!current || line === "" || line.startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (kv) current.fields[kv[1]] = kv[2].trim().replace(/^"|"$/g, "");
  }
  return providers;
}

// ---------------------------------------------------------------------------
// provider 分类 → 运行时额度适配器配置
// ---------------------------------------------------------------------------
function classify(p) {
  const { name, fields } = p;
  const baseUrl = fields.base_url ?? "";
  let host = "";
  try { host = new URL(baseUrl).host; } catch {}
  if (fields.type === "kimi" || host.endsWith("kimi.com") || host.endsWith("moonshot.cn")) {
    return {
      id: name, label: "Kimi", kind: "kimi",
    };
  }
  if (host === "open.bigmodel.cn" || host.endsWith("bigmodel.cn")) {
    return { id: name, label: "GLM智谱", kind: "zhipu", apiBase: "https://open.bigmodel.cn", apiKey: fields.api_key ?? "" };
  }
  if (host === "api.z.ai" || host.endsWith("z.ai")) {
    return { id: name, label: "GLM国际", kind: "zhipu", apiBase: "https://api.z.ai", apiKey: fields.api_key ?? "" };
  }
  return { id: name, label: name, kind: "unsupported" };
}

// ---------------------------------------------------------------------------
// 渲染进程运行时：模板 + 注入配置
// ---------------------------------------------------------------------------
function buildRuntimeScript() {
  const template = readFileSync(join(HERE, "scripts", "runtime.js"), "utf8");
  return `/* usage-union@${VERSION} */\n` + template;
}

// 供应商清单单独成文件：hook 每次运行都重写（不依赖版本号），渠道增删在下次
// 会话启动后自动生效
function writeProviderConfig(dist, adapters) {
  const config = JSON.stringify({ version: VERSION, providers: adapters });
  writeFileSync(join(dist, "assets", "usage-union.config.json"), config, "utf8");
}

// ---------------------------------------------------------------------------
// install / uninstall / status
// ---------------------------------------------------------------------------
function install() {
  const dist = findDistDir();
  if (!dist) {
    console.error("✗ 未找到 Kimi Code Desktop 的 desktop-dist 目录，请用 --dist 指定。");
    process.exit(1);
  }
  const cfgPath = findConfig();
  const providers = parseProviders(cfgPath);
  const adapters = providers.map(classify).filter((a) => a.kind !== "unsupported");
  const skipped = providers.map(classify).filter((a) => a.kind === "unsupported");

  const indexPath = join(dist, "index.html");
  const html = readFileSync(indexPath, "utf8");
  const backupPath = join(dist, BACKUP_NAME);
  if (!existsSync(backupPath)) copyFileSync(indexPath, backupPath);

  // 写运行时脚本 + 供应商配置（与前端其它资源同放 assets/）
  if (!adapters.length) {
    console.error("✗ config.toml 未配置任何 provider。");
    process.exit(1);
  }
  const assetsDir = join(dist, "assets");
  mkdirSync(assetsDir, { recursive: true });
  // 供应商清单每次都刷新（不依赖版本号），渠道增删在下次会话启动后自动生效
  writeProviderConfig(dist, adapters);
  writeFileSync(join(assetsDir, SCRIPT_NAME), buildRuntimeScript(), "utf8");

  // 补丁 index.html（幂等：先移除旧标记行再插入）
  const scriptTag = `    <script src="/assets/${SCRIPT_NAME}"></script>\n`;
  let next = html
    .split("\n")
    .filter((l) => !l.includes(SCRIPT_NAME))
    .join("\n");
  if (!next.includes(`</body>`)) {
    console.error("✗ index.html 结构异常（没有 </body>）。");
    process.exit(1);
  }
  next = next.replace("</body>", `${scriptTag}</body>`);

  // 清理历史版本装在 dist 根目录的运行时脚本
  rmSync(join(dist, SCRIPT_NAME), { force: true });

  writeFileSync(indexPath, next, "utf8");

  console.log(`✓ 已安装到 ${dist}`);
  console.log(`  provider 适配器:`);
  for (const a of adapters) console.log(`    - ${a.label} (${a.kind})${a.kind === "unsupported" ? " [跳过]" : ""}`);
  for (const s of skipped) console.log(`    - ${s.label} [不支持额度查询，已跳过]`);
  console.log(`  重启 Kimi Code Desktop（或重开窗口）后生效。应用更新后需重新运行 install。`);
}

function uninstall() {
  const dist = findDistDir();
  if (!dist) {
    console.error("✗ 未找到 desktop-dist 目录。");
    process.exit(1);
  }
  const indexPath = join(dist, "index.html");
  const backupPath = join(dist, BACKUP_NAME);
  if (existsSync(backupPath)) {
    copyFileSync(backupPath, indexPath);
    rmSync(backupPath, { force: true });
  } else {
    const html = readFileSync(indexPath, "utf8");
    writeFileSync(
      indexPath,
      html.split("\n").filter((l) => !l.includes(SCRIPT_NAME)).join("\n"),
      "utf8"
    );
  }
  rmSync(join(dist, SCRIPT_NAME), { force: true });
  rmSync(join(dist, "assets", SCRIPT_NAME), { force: true });
  rmSync(join(dist, "assets", "usage-union.config.json"), { force: true });
  console.log(`✓ 已还原 ${indexPath}`);
}

function status() {
  const dist = findDistDir();
  console.log(`desktop-dist: ${dist ?? "未找到"}`);
  if (!dist) process.exit(1);
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const patched = html.includes(SCRIPT_NAME);
  console.log(`注入状态:   ${patched ? "已注入" : "未注入"}`);
  console.log(`运行时脚本: ${existsSync(join(dist, "assets", SCRIPT_NAME)) ? "存在" : "不存在"}`);
  const cfgPath = findConfig();
  console.log(`config:     ${cfgPath}`);
  for (const a of parseProviders(cfgPath).map(classify)) {
    console.log(`  provider: ${a.name ?? a.id}  kind=${a.kind}${a.apiKey ? "  (有 key)" : ""}`);
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
