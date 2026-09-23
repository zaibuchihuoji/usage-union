/**
 * 版本化标签验证：usage-union / auto-memory 注入的 script 标签应带 ?v=。
 * 用法：node test/tag-check.mjs（临时脚本）
 */
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const ROOT = "D:/opencode-sessions/kimi插件";
for (const [dir, script, extra] of [
  ["usage-union", "usage-union.js", []],
  ["auto-memory", "auto-memory.js", ["--home", "TMP", "--no-spawn"]],
]) {
  const dist = mkdtempSync(join(tmpdir(), "tagcheck-"));
  writeFileSync(join(dist, "index.html"), "<html><body>x</body></html>\n");
  const args = ["--force", "--dist", dist];
  for (const a of extra) args.push(a === "TMP" ? dist : a);
  spawnSync(process.execPath, [join(ROOT, dir, "scripts", "auto-patch.mjs"), ...args], { encoding: "utf8" });
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const idx = html.indexOf(script);
  console.log(dir, "→", idx >= 0 ? html.slice(idx - 1, idx + script.length + 12) : "未注入");
}
