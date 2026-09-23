/**
 * usage-union 共享补丁库 —— CLI（usage-union.mjs）与插件 hook（auto-patch.mjs）
 * 的唯一实现来源。此前两处各持一份 classify/TOML 解析并已发生漂移
 * （CLI 把 moonshot.cn 误判为 kimi 托管、且缺少通用探测），故收敛到此。
 *
 * 版本号单一来源：kimi.plugin.json（本文件上一层目录）。此前 VERSION 在
 * 清单 / auto-patch / usage-union.mjs 三处人肉同步，漂移后 hook 的 stale
 * 判定会失效。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, copyFileSync, renameSync, unlinkSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRIPT_NAME = "usage-union.js";
export const BACKUP_NAME = "index.html.usage-union.bak";

// 版本号：读插件清单，缺失时回退 0.0.0（不应发生）
export const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, "..", "kimi.plugin.json"), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// --- 定位 ---------------------------------------------------------------------
export function findDistDir(forced) {
  if (forced) {
    const p = resolve(forced);
    if (existsSync(join(p, "index.html"))) return p;
    return null; // 显式指定的路径无效时明确报错，而不是静默回退
  }
  const candidates = [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "kimi-code", "Kimi Code", "resources", "desktop-dist"),
    join(process.env.LOCALAPPDATA ?? "", "Programs", "kimi-desktop", "resources", "desktop-dist"),
    "D:\\kimi-code\\Kimi Code\\resources\\desktop-dist",
  ];
  for (const c of candidates) if (c && existsSync(join(c, "index.html"))) return resolve(c);
  return null;
}

export function findConfig(forced) {
  if (forced) return resolve(forced);
  const home = process.env.KIMI_CODE_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".kimi-code");
  return join(home, "config.toml");
}

// --- 极简 TOML 解析（[providers."name"] 直属键） ---------------------------------
// 支持：双引号/单引号字符串、行内注释、名字带点的引号段、基本转义。
// 不支持：多行字符串/数组（config.toml 的 provider 段用不到）。
function splitHeaderPath(s) {
  const parts = [];
  let cur = "", q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === ".") { parts.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  parts.push(cur.trim());
  return parts.filter((p) => p !== "");
}

function parseTomlValue(raw) {
  raw = raw.trim();
  if (!raw) return "";
  const q = raw[0];
  if (q === '"' || q === "'") {
    let end = -1;
    if (q === "'") end = raw.indexOf("'", 1);
    else for (let i = 1; i < raw.length; i++) {
      if (raw[i] === "\\") { i++; continue; }
      if (raw[i] === '"') { end = i; break; }
    }
    if (end > 0) {
      const body = raw.slice(1, end);
      return q === "'" ? body
        : body.replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" }[c] ?? c));
    }
  }
  // 非引号值：去掉行内注释
  const h = raw.indexOf("#");
  return (h >= 0 ? raw.slice(0, h) : raw).trim();
}

export function parseProviders(cfgPath) {
  if (!existsSync(cfgPath)) return [];
  const text = readFileSync(cfgPath, "utf8");
  const providers = [];
  let current = null; // { name, fields }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = line.match(/^\[+([^\]]+)\]+$/);
    if (header) {
      const path = splitHeaderPath(header[1]);
      // providers."name" —— 两段；更深（.oauth 等）不算 provider 本体
      if (path.length === 2 && path[0] === "providers") {
        current = { name: path[1], fields: {} };
        providers.push(current);
      } else current = null;
      continue;
    }
    if (!current || line === "" || line.startsWith("#")) continue;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (kv) current.fields[kv[1]] = parseTomlValue(kv[2]);
  }
  return providers;
}

// --- provider 分类（与 runtime.js 的 classifyHost 同一套边界安全正则） -----------------
// host 匹配必须带 dot 边界（(^|.)x.y$）：endsWith("kimi.com") 会把 fakekimi.com
// 这类后缀重叠域误判进官方渠道（误判后 key 只会发往硬编码官方 apiBase，无实害，
// 但分类失真且与渲染层判定不一致）
export function classify(p) {
  const { name, fields } = p;
  const baseUrl = fields.base_url ?? "";
  let host = "", origin = baseUrl;
  try { const u = new URL(baseUrl); host = u.host; origin = `${u.protocol}//${u.host}`; } catch {}
  if (fields.type === "kimi" || /(^|\.)kimi\.com$/.test(host)) {
    return { id: name, label: "Kimi", kind: "kimi" };
  }
  if (/(^|\.)moonshot\.(cn|ai)$/.test(host)) {
    // Moonshot 开放平台（api.moonshot.cn / api.moonshot.ai，type 通常为 openai）只有按量余额接口
    const apiBase = /(^|\.)moonshot\.ai$/.test(host) ? "https://api.moonshot.ai" : "https://api.moonshot.cn";
    return { id: name, label: "Moonshot", kind: "moonshot", apiBase, apiKey: fields.api_key ?? "" };
  }
  if (/(^|\.)deepseek\.(com|org)$/.test(host)) {
    return { id: name, label: "DeepSeek", kind: "deepseek", apiBase: "https://api.deepseek.com", apiKey: fields.api_key ?? "" };
  }
  if (/(^|\.)bigmodel\.cn$/.test(host)) {
    return { id: name, label: "GLM智谱", kind: "zhipu", apiBase: "https://open.bigmodel.cn", apiKey: fields.api_key ?? "" };
  }
  if (/(^|\.)z\.ai$/.test(host)) {
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

// --- 写文件（原子替换：先写临时文件再 rename，避免读到截断内容） --------------------
export function writeAtomic(fp, data) {
  const tmp = `${fp}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, data, "utf8");
    renameSync(tmp, fp);
  } catch {
    try { unlinkSync(tmp); } catch {}
    writeFileSync(fp, data, "utf8");
  }
}

// --- 生成运行时脚本 / 供应商配置 -------------------------------------------------
export function buildRuntimeScript() {
  const template = readFileSync(join(HERE, "runtime.js"), "utf8");
  return `/* usage-union@${VERSION} */\n` + template;
}

// 供应商清单单独成文件：hook 每次运行都重写（不依赖版本号），渠道增删在下次
// 会话启动后自动生效。update 为自更新状态（{running, applied}），供徽章弹窗提示
export function writeProviderConfig(dist, adapters, update = null) {
  writeAtomic(join(dist, "assets", "usage-union.config.json"),
    JSON.stringify({ version: VERSION, providers: adapters, ...(update ? { update } : {}) }));
}

// --- 补丁 / 还原 ----------------------------------------------------------------
function statOf(fp) {
  try { const s = statSync(fp); return `${s.size}:${s.mtimeMs}`; } catch { return "missing"; }
}

/**
 * 备份语义：备份内容 = 当前 index.html 去掉本插件注入行。每次打补丁都跟随
 * 刷新——应用自动更新覆盖 index.html、或另一插件增删注入后，备份仍是"干净
 * 基线"，卸载时不会恢复出过期页面或指向已删除脚本的 ghost 标签。
 * script 标签带 ?v=版本号：app:// 协议对同 URL 资源有缓存，换内容不换 URL 会
 * 读到旧脚本（升级不生效），版本号变化 → URL 变化 → 强制绕过缓存。
 *
 * index.html 是多个插件（usage-union / auto-memory / turn-stats 等）的公共
 * 注入点，且 app:// 协议对每个请求实时读盘。这里用「读前后 stat 校验 +
 * 原子写 + 写后复验 + 有限重试」的乐观并发：撞上其他插件/应用自身的并发写时
 * 重读重算，收敛于包含所有人标签的最新内容；原子写保证渲染进程永远读不到
 * 半截文件。
 */
export function patchHtml(indexPath) {
  const backupPath = join(dirname(indexPath), BACKUP_NAME);
  for (let attempt = 0; attempt < 5; attempt++) {
    const s1 = statOf(indexPath);
    const html = readFileSync(indexPath, "utf8");
    if (statOf(indexPath) !== s1) continue;   // 读期间文件在变，重读
    const clean = html.split("\n").filter((l) => !l.includes(SCRIPT_NAME)).join("\n");
    if (!clean.includes("</body>")) throw new Error("index.html 结构异常（没有 </body>）");
    let cur = null;
    try { cur = readFileSync(backupPath, "utf8"); } catch {}
    if (cur !== clean) writeAtomic(backupPath, clean);
    const scriptTag = `    <script src="/assets/${SCRIPT_NAME}?v=${VERSION}"></script>\n`;
    writeAtomic(indexPath, clean.replace("</body>", `${scriptTag}</body>`));
    // 写后复验：若被并发写覆盖丢了我们的标签，下一轮重试会基于最新内容补回
    if (readFileSync(indexPath, "utf8").includes(SCRIPT_NAME)) return;
  }
  throw new Error("index.html 并发写入冲突，重试耗尽（下次会话自动重试）");
}

export function uninstallDist(dist) {
  const indexPath = join(dist, "index.html");
  const backupPath = join(dist, BACKUP_NAME);
  if (existsSync(backupPath)) {
    writeAtomic(indexPath, readFileSync(backupPath, "utf8"));
    rmSync(backupPath, { force: true });
  } else if (existsSync(indexPath)) {
    const html = readFileSync(indexPath, "utf8");
    writeAtomic(indexPath, html.split("\n").filter((l) => !l.includes(SCRIPT_NAME)).join("\n"));
  }
  rmSync(join(dist, "assets", SCRIPT_NAME), { force: true });
  rmSync(join(dist, "assets", "usage-union.config.json"), { force: true });
  rmSync(join(dist, SCRIPT_NAME), { force: true }); // 清理历史版本装在 dist 根目录的脚本
}
