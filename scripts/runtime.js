/*!
 * usage-union renderer runtime
 * 由 auto-patch.mjs（或工作区的 usage-union.mjs）生成并注入到
 * Kimi Code Desktop 的 desktop-dist/index.html。
 *
 * 功能：
 *  - 跟随应用当前使用的模型（活跃会话 > 最近会话 > 全局默认），徽章显示该
 *    provider 的套餐名与 5小时/每周窗口；同一 provider 内切模型不影响显示
 *  - 每 10 秒检测当前模型 + 每 15 秒重读供应商配置（增删渠道自动跟上）；
 *    检测到一轮对话结束（busy→空闲）立即刷新额度
 *  - 点击徽章展开所有 provider 的完整明细（含每月窗口、已用/总量、无限制）
 *
 * 供应商清单来自 /assets/usage-union.config.json —— 由 hook 每次会话启动时
 * 从 config.toml 重新生成，注入脚本本身不再包含任何密钥或渠道信息。
 *
 * "无限制"判定（严格）：仅当 provider 查询成功、且响应确认存在活跃套餐
 * （智谱返回 level；Kimi 存在任一用量窗口/月度字段）时，缺失的窗口才显示
 * 无限制；查询失败、无套餐数据一律不标无限制。
 */
(() => {
  if (window.__usageUnionInstalled) return;
  window.__usageUnionInstalled = true;

  const CONFIG_URL = "/assets/usage-union.config.json";
  const POLL_MS = 3 * 60 * 1000;        // 额度全量刷新间隔
  const MODEL_POLL_MS = 10 * 1000;      // 当前模型检测间隔
  const CONFIG_POLL_MS = 15 * 1000;     // 供应商配置重读间隔
  const ATTACH_CHECK_MS = 1500;         // 徽章脱落检查
  const FIRST_FETCH_DELAY = 2000;       // 等宿主 SPA 写入最新 server 地址
  // 页面正在运行的脚本版本（注入标签 ?v=）：与 config.json 的 version（hook
  // 每次重写 = 磁盘上的最新版本）不一致 = 新版已注入而页面未重载 → 挂"待生效"
  // 提示。本地比对，不依赖任何服务端状态文件（v1.9.3 曾用 .update-state.json
  // 的版本记录构造该提示，语义错位导致刷新页面后横幅也消不掉）
  const RUNNING_VERSION = (() => {
    try { return /v=([^&"]+)/.exec(document.currentScript?.src ?? "")?.[1] ?? ""; }
    catch { return ""; }
  })();

  // 带超时的 fetch：本地 server 或外网接口挂起时不让刷新 Promise 悬死
  // （否则徽章会永远停留在旧数据且无任何"超时"提示）
  async function fetchT(url, opts = {}, ms = 10000) {
    return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
  }

  // -------------------------------------------------------------------------
  // 供应商配置：hook 每次会话启动重写 config.json，这里定期重读
  // 条目：{ id, label, kind, apiBase, apiKey, host }
  // -------------------------------------------------------------------------
  let CONFIG = { providers: [] };

  async function loadConfig() {
    try {
      const res = await fetchT(`${CONFIG_URL}?t=${Date.now()}`);
      if (!res.ok) return;
      const j = await res.json();
      if (Array.isArray(j?.providers)) CONFIG = j;
      render();
    } catch {}
  }

  // -------------------------------------------------------------------------
  // 宿主会话凭据：server 地址 + Bearer token
  // -------------------------------------------------------------------------
  function kimiRuntime() {
    let origin = null, token = null;
    try {
      origin = sessionStorage.getItem("kimi-desktop-server-origin");
      const raw = sessionStorage.getItem("kimi-web.server-credential");
      if (raw) token = JSON.parse(raw)?.credential ?? null;
    } catch {}
    return { origin, token };
  }

  function authHeaders() {
    const { token } = kimiRuntime();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  // -------------------------------------------------------------------------
  // 数据源：统一产出 snapshot
  //   { title, plan, planActive,
  //     five: {pct, resetAt}|null, long: {label, pct, resetAt, used, total}|null,
  //     unlimitedFive, unlimitedLong,
  //     others: [{label, pct, resetAt, used, total}],
  //     balanceText?, statusText? }
  // -------------------------------------------------------------------------
  function kimiRow(e) {
    // usedRatio 缺失时保持 null（UI 显示 "--"），不折叠成 0%
    if (!e) return null;
    return { pct: typeof e.usedRatio === "number" ? Math.round(e.usedRatio * 100) : null, resetAt: e.resetAt ?? null };
  }

  async function fetchKimi() {
    const { origin } = kimiRuntime();
    if (!origin) throw new Error("server origin 未知");
    const headers = authHeaders();
    const res = await fetchT(`${origin}/api/v1/oauth/usage`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const data = body?.data ?? body;
    const usages = data?.quota?.usages ?? {};

    // 套餐名：userinfo 的平台等级（Free/Pro…）；无 userinfo 时不猜
    let plan = null;
    try {
      const r2 = await fetchT(`${origin}/api/v1/oauth/userinfo`, { headers });
      if (r2.ok) {
        const b2 = await r2.json();
        const level = (b2?.data?.userInfo ?? b2?.userInfo)?.userLevelName;
        if (level) plan = `Kimi ${level}`;
      }
    } catch {}

    const five = kimiRow(usages.limit5h);
    // 长窗口：旧套餐有周限额（limit7d），新套餐只有月限额（monthTotal）
    let long = null;
    if (usages.limit7d && typeof usages.limit7d.usedRatio === "number") {
      long = { label: "每周", ...kimiRow(usages.limit7d) };
    } else if (usages.monthTotal && typeof usages.monthTotal.usedRatio === "number") {
      long = { label: "每月", ...kimiRow(usages.monthTotal) };
    }
    const planActive = !!(five || long || usages.monthCode);
    const others = [];
    // 周与月同时存在时，长窗口取周，月进详情
    if (long?.label === "每周" && usages.monthTotal && typeof usages.monthTotal.usedRatio === "number") {
      others.push({ label: "每月", ...kimiRow(usages.monthTotal) });
    }
    // 按量余额（无套餐/超出套餐部分按量计费时是有效信息）
    const extra = data?.quota?.extraUsage ?? null;
    const balanceText = extra && typeof extra.balanceCents === "number" ? `¥${(extra.balanceCents / 100).toFixed(2)}` : null;
    return {
      title: "Kimi", plan, planActive,
      five, long,
      unlimitedFive: planActive && !five,
      unlimitedLong: planActive && !long,
      others,
      balanceText,
    };
  }

  const UNIT_LABEL = { 2: "分钟", 3: "小时", 4: "天", 5: "周", 6: "周", 7: "月" };
  function creditLabel(l) {
    const u = UNIT_LABEL[l.unit];
    if (!u) return `窗口${l.unit}x${l.number}`;
    if (u === "小时" && l.number === 5) return "5小时";
    if (u === "周") return "每周";
    if (u === "月") return "每月";
    if (u === "天") return "每日";
    return `${l.number}${u}`;
  }
  function creditRow(l) {
    const pct = typeof l.percentage === "number" ? l.percentage
      : l.usage ? Math.round((l.currentValue / l.usage) * 100) : null;
    return {
      pct,
      used: l.currentValue,
      total: l.usage,
      resetAt: normalizeEpoch(l.nextResetTime),
    };
  }

  // 重置时间兼容秒/毫秒时间戳
  function normalizeEpoch(ts) {
    if (typeof ts !== "number" || ts <= 0) return null;
    return new Date(ts < 1e12 ? ts * 1000 : ts).toISOString();
  }

  async function fetchZhipu(p) {
    if (!p.apiKey) throw new Error("未配置密钥");
    const res = await fetchT(`${p.apiBase}/api/monitor/usage/quota/limit`, {
      headers: { Authorization: p.apiKey, "Content-Type": "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const d = body?.data;
    if (!d || !Array.isArray(d.limits)) throw new Error(body?.msg || "无数据");
    const credits = d.limits.filter((l) => l.type === "CREDIT_LIMIT");
    const tokens = d.limits.filter((l) => l.type === "TOKENS_LIMIT")
      .slice().sort((a, b) => (a.nextResetTime ?? 0) - (b.nextResetTime ?? 0));

    // 5小时：unit=3,number=5 的信用窗口；长窗口：优先周（unit=5/6），其次月
    // （unit=7），再退而求其次取剩余窗口里周期最长的（如日限额）——窗口组合由
    // 套餐类型决定，不能假设；信用窗口缺失时按 nextResetTime 顺序回退到
    // TOKENS_LIMIT（第1条=5小时，第2条=长窗口）
    let five = null, long = null;
    const fiveCredit = credits.find((l) => l.unit === 3 && l.number === 5);
    if (fiveCredit) five = creditRow(fiveCredit);
    const weekCredit = credits.find((l) => (l.unit === 5 || l.unit === 6) && l.number === 1);
    const monthCredit = credits.find((l) => l.unit === 7);
    if (weekCredit) long = { label: "每周", ...creditRow(weekCredit) };
    else if (monthCredit) long = { label: "每月", ...creditRow(monthCredit) };
    if (!five && tokens[0]) five = creditRow(tokens[0]);
    if (!long && tokens[1]) long = { label: "每周", ...creditRow(tokens[1]) };
    // 没有周/月窗口：取剩余信用窗口里周期最长的作为长窗口（如日限额），
    // 只有确实一个别的窗口都没有，才允许显示"长期 无限制"
    let longCredit = weekCredit ?? monthCredit ?? null;
    if (!long) {
      const rest = credits.filter((l) => l !== fiveCredit && l !== weekCredit && l !== monthCredit);
      if (rest.length) {
        longCredit = rest.reduce((a, b) => ((b.unit ?? 0) > (a.unit ?? 0) ? b : a));
        long = { label: creditLabel(longCredit), ...creditRow(longCredit) };
      }
    }

    const planActive = typeof d.level === "string" && d.level.length > 0;
    const others = [];
    for (const l of credits) {
      if (l === fiveCredit || l === longCredit) continue;
      others.push({ label: creditLabel(l), ...creditRow(l) });
    }
    tokens.forEach((l, i) => {
      const usedAs = (l === tokens[0] && five) || (l === tokens[1] && long);
      if (!usedAs) others.push({ label: `令牌窗口${i + 1}`, ...creditRow(l) });
    });
    // TIME_LIMIT：MCP 等按次数计的窗口，不进徽章但要在详情里可见
    for (const l of d.limits) {
      if (l.type !== "TIME_LIMIT") continue;
      others.push({
        label: l.unit != null ? `MCP ${creditLabel(l)}` : "MCP 次数",
        pct: typeof l.percentage === "number" ? l.percentage
          : l.usage ? Math.round((l.currentValue / l.usage) * 100) : 0,
        used: l.currentValue,
        total: l.usage,
        resetAt: normalizeEpoch(l.nextResetTime),
      });
    }
    return {
      title: p.label, plan: d.level ? `${p.label} ${String(d.level).toUpperCase()}` : null, planActive,
      five, long,
      // "无限制"要求整层窗口确实缺失：TOKENS_LIMIT 存在时五个/长窗口由回退逻辑
      // 吃掉，剩一层拿不到数据只能说明"未知"，不能宣称无限制
      unlimitedFive: planActive && !five && !tokens.length,
      unlimitedLong: planActive && !long && !tokens.length,
      others,
    };
  }

  // 余额型渠道：只查得到余额，没有套餐窗口（DeepSeek / Moonshot 开放平台）
  async function fetchDeepSeek(p) {
    if (!p.apiKey) throw new Error("未配置密钥");
    const res = await fetchT(`${p.apiBase}/user/balance`, { headers: { Authorization: `Bearer ${p.apiKey}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const info = j?.balance_infos?.[0];
    const amt = info?.total_balance;
    if (amt == null) throw new Error(j?.error?.message || "无余额数据");
    const cur = info.currency === "CNY" ? "¥" : `${info.currency} `;
    return {
      title: p.label, plan: j.is_available === false ? "不可用" : "按量余额", planActive: true,
      five: null, long: null, unlimitedFive: false, unlimitedLong: false,
      others: [], balanceText: `${cur}${amt}`,
    };
  }

  async function fetchMoonshot(p) {
    if (!p.apiKey) throw new Error("未配置密钥");
    const res = await fetchT(`${p.apiBase}/v1/users/me/balance`, { headers: { Authorization: `Bearer ${p.apiKey}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const d = j?.data ?? j;
    const amt = d?.available_balance ?? d?.total_balance ?? null;
    if (amt == null) throw new Error("无余额数据");
    return {
      title: p.label, plan: "按量余额", planActive: true,
      five: null, long: null, unlimitedFive: false, unlimitedLong: false,
      others: [], balanceText: `¥${amt}`,
    };
  }

  async function fetchOpenRouter(p) {
    if (!p.apiKey) throw new Error("未配置密钥");
    const res = await fetchT(`${p.apiBase}/credits`, { headers: { Authorization: `Bearer ${p.apiKey}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = (await res.json())?.data ?? {};
    const total = Number(d.total_credits), used = Number(d.total_usage);
    if (!Number.isFinite(total)) throw new Error("无额度数据");
    const remain = Math.max(0, total - used);
    return {
      title: p.label, plan: "按量余额", planActive: true,
      five: null, long: null, unlimitedFive: false, unlimitedLong: false,
      others: [],
      balanceText: Number.isFinite(used) ? `剩 $${remain.toFixed(2)} · 已用 $${used.toFixed(2)}` : `$${remain.toFixed(2)}`,
    };
  }

  async function fetchSiliconFlow(p) {
    if (!p.apiKey) throw new Error("未配置密钥");
    const res = await fetchT(`${p.apiBase}/v1/user/info`, { headers: { Authorization: `Bearer ${p.apiKey}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const bal = j?.data?.balance ?? j?.data?.totalBalance ?? null;
    if (bal == null) throw new Error("无余额数据");
    return {
      title: p.label, plan: "按量余额", planActive: true,
      five: null, long: null, unlimitedFive: false, unlimitedLong: false,
      others: [], balanceText: `¥${bal}`,
    };
  }

  // 未知渠道的通用探测：one-api/new-api 系中转站实现了 OpenAI 兼容的 billing
  // 端点；探不到额度就退而验证连通性，保证徽章永远有内容
  async function fetchGeneric(p) {
    const base = String(p.apiBase ?? "").replace(/\/+$/, "");
    if (!base) throw new Error("无 base_url");
    // 仅允许 http/https。借鉴 Pane 的严格规则：明文 http 只放行 IP 字面量的
    // 回环/私网/链路本地地址（http 主机名一律拒绝，防 DNS 指向公网）
    if (!/^https?:\/\//i.test(base)) throw new Error("不支持的协议（仅 http/https）");
    const hostPart = /^http:\/\/([^/]+)/i.exec(base)?.[1];
    if (hostPart && !/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[::1\]|\[[fF][cCdD]|\[[fF][eE]80)/.test(hostPart)) {
      throw new Error("不安全的连接（http 明文，仅允许内网 IP）");
    }
    const H = p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};
    // 无密钥的渠道只做连通性检查
    if (!p.apiKey) {
      try {
        const res = await fetchT(`${base}/v1/models`);
        if (res.ok) {
          return {
            title: p.label, plan: null, planActive: true,
            five: null, long: null, unlimitedFive: false, unlimitedLong: false,
            others: [], statusText: "已连接 · 未配置密钥",
          };
        }
      } catch {}
      throw new Error("未配置密钥，且连通性检查未通过");
    }
    // MiniMax 存在未文档化的余额端点（社区在用），仅对其域名尝试；失败则继续走
    // 下面的通用探测链
    if (/(^|\.)minimax(i?)\.(com|io|chat)$/.test(p.host ?? "")) {
      try {
        const j = await (await fetchT(`${base}/v1/get_balance`, { headers: H })).json();
        const raw = j?.balance ?? j?.total_balance ?? j?.data?.balance ?? null;
        if (raw != null && Number.isFinite(Number(raw))) {
          return {
            title: p.label, plan: "按量余额", planActive: true,
            five: null, long: null, unlimitedFive: false, unlimitedLong: false,
            others: [], balanceText: `¥${Number(raw)}`,
          };
        }
      } catch {}
    }
    try {
      const sub = await (await fetchT(`${base}/v1/dashboard/billing/subscription`, { headers: H })).json();
      const limit = Number(sub?.hard_limit_usd);
      if (Number.isFinite(limit)) {
        // New API 哨兵值：hard_limit_usd >= 1 亿代表无上限，只显示已用
        const unlimited = limit >= 1e8;
        let used = null;
        try {
          const u = await (await fetchT(`${base}/v1/dashboard/billing/usage`, { headers: H })).json();
          const cents = Number(u?.total_usage);
          if (Number.isFinite(cents)) used = cents / 100;
        } catch {}
        return {
          title: p.label, plan: "订阅额度", planActive: true,
          five: null, long: null, unlimitedFive: false, unlimitedLong: false,
          others: [],
          statusText: unlimited
            ? (used != null ? `已用 $${used.toFixed(2)} · 无上限` : "无上限")
            : (used != null ? `已用 $${used.toFixed(2)} / $${limit.toFixed(2)}` : `额度 $${limit.toFixed(2)}`),
        };
      }
    } catch {}
    // DeepSeek 形状的余额约定（StepFun/Novita 等不少平台兼容同一形状）：
    // GET {base}/user/balance → balance_infos[0].total_balance
    try {
      const b = await (await fetchT(`${base}/user/balance`, { headers: H })).json();
      const info = b?.balance_infos?.[0];
      const amt = info?.total_balance ?? b?.balance ?? null;
      if (amt != null && Number.isFinite(Number(amt))) {
        const cur = info?.currency === "CNY" || !info?.currency ? "¥" : `${info.currency} `;
        return {
          title: p.label, plan: "按量余额", planActive: true,
          five: null, long: null, unlimitedFive: false, unlimitedLong: false,
          others: [], balanceText: `${cur}${amt}`,
        };
      }
    } catch {}
    try {
      const res = await fetchT(`${base}/v1/models`, { headers: H });
      if (res.ok) {
        return {
          title: p.label, plan: null, planActive: true,
          five: null, long: null, unlimitedFive: false, unlimitedLong: false,
          others: [], statusText: "已连接 · 无额度接口",
        };
      }
    } catch {}
    throw new Error("连接失败");
  }

  // -------------------------------------------------------------------------
  // 当前模型检测：优先正在运行的会话，其次最近更新的会话，最后全局默认
  // 模型串（如 "kimi-code/k3"）到 provider 的映射以服务端 /providers 为权威
  // （托管 provider 的 id 带 "managed:" 前缀，但模型串用的是短别名）
  // -------------------------------------------------------------------------
  let active = { model: null, providerId: null, unsupported: null, busy: false };
  let providersMeta = { at: 0, map: new Map(), ids: [], baseUrlById: new Map() };   // modelId -> providerId；全部渠道 id

  async function loadProvidersMeta() {
    const { origin } = kimiRuntime();
    if (!origin) return;
    try {
      const res = await fetchT(`${origin}/api/v1/providers`, { headers: authHeaders() });
      if (!res.ok) return;
      const body = await res.json();
      const items = body?.data?.items ?? [];
      const map = new Map(), baseUrlById = new Map();
      for (const it of items) {
        for (const m of it.models ?? []) map.set(m, it.id);
        baseUrlById.set(it.id, it.base_url ?? "");
      }
      if (map.size) providersMeta = { at: Date.now(), map, ids: items.map((it) => it.id), baseUrlById };
    } catch {}
  }

  function resolveModelProvider(model) {
    if (!model) return { providerId: null, knownId: null };
    const knownId = providersMeta.map.get(model) ?? null;
    if (knownId) {
      const adapter = currentProviders().find((p) => p.id === knownId);
      if (adapter) return { providerId: adapter.id, knownId };
      return { providerId: null, knownId };   // 已知渠道但无额度适配器
    }
    // meta 缺失时的兜底：前缀匹配（兼容 managed: 前缀差异；托管 Kimi 的模型串
    // 是 "kimi-code/..." 短别名，与去前缀后的 id "kimi" 不一致，需一并匹配）
    const hit = currentProviders().find((p) => {
      const alias = p.id.replace(/^managed:/, "");
      const aliases = alias === "kimi" ? ["kimi", "kimi-code"] : [alias];
      return aliases.some((a) => model === a || model.startsWith(a + "/"));
    });
    return hit ? { providerId: hit.id, knownId: hit.id } : { providerId: null, knownId: null };
  }

  let detecting = false;
  async function detectActiveModel() {
    // 并发守卫：检测链最多三个串行 fetch（最坏 30s），而定时器 10s 一发，
    // 本地 server 卡顿时会并发叠起多份检测/触发多次 refreshAll
    if (detecting) return;
    detecting = true;
    try {
      const { origin } = kimiRuntime();
      if (!origin) return;
      if (Date.now() - providersMeta.at > 60 * 1000) await loadProvidersMeta();
      const headers = authHeaders();
      let model = null, busy = false;
      try {
        const res = await fetchT(`${origin}/api/v1/sessions?limit=20`, { headers });
        if (res.ok) {
          const body = await res.json();
          const items = (body?.data?.items ?? []).filter((s) => !s.archived && s.agent_config?.model);
          const running = items.find((s) => s.busy || s.main_turn_active);
          if (running) { model = running.agent_config.model; busy = true; }
          else {
            const latest = items.slice().sort((a, b) => Date.parse(b.updated_at ?? 0) - Date.parse(a.updated_at ?? 0))[0];
            if (latest) model = latest.agent_config.model;
          }
        }
      } catch {}
      if (!model) {
        try {
          const res = await fetchT(`${origin}/api/v1/config`, { headers });
          if (res.ok) {
            const body = await res.json();
            model = body?.data?.default_model ?? null;
          }
        } catch {}
      }
      // 一轮对话结束 → 立刻刷新额度
      const wasBusy = active.busy;
      if (wasBusy && !busy) refreshAll();
      active.busy = busy;

      const { providerId: pid, knownId } = resolveModelProvider(model);
      const changed = pid !== active.providerId;
      active = { model, providerId: pid, unsupported: model && !pid ? (knownId ?? model) : null, busy };
      if (changed) {
        render();
        // 切到某个 provider 时若其数据是旧的，立即补一次
        const p = currentProviders().find((x) => x.id === pid);
        const s = pid ? state.get(pid) : null;
        if (p && (!s || !s.fetchedAt || Date.now() - s.fetchedAt > POLL_MS)) refreshProvider(p);
      } else {
        render();
      }
    } finally {
      detecting = false;
    }
  }

  // -------------------------------------------------------------------------
  // 额度状态与轮询
  // -------------------------------------------------------------------------
  // state: Map<id, {ok, error?, snapshot?, fetchedAt, stale?}>
  const state = new Map();
  const inFlight = new Set();   // 正在刷新的 provider id

  function currentProviders() {
    // 以 config.json 为主；服务端有、配置文件还没跟上的渠道（刚添加、hook 未
    // 跑）按 base_url 合成占位条目，保证增删渠道 10 秒内可见
    const out = (CONFIG.providers ?? []).map((p) => ({ ...p }));
    for (const id of providersMeta.ids ?? []) {
      if (out.some((p) => p.id === id)) continue;
      const base = providersMeta.baseUrlById?.get(id) ?? "";
      let host = "";
      try { host = new URL(base).host; } catch {}
      // 无 base_url 的内置托管渠道按 id 识别（fetchKimi 走本地 server，不需要 base_url）
      let kind = classifyHost(host);
      if (kind === "generic" && !base && /kimi/i.test(id)) kind = "kimi";
      out.push({ id, label: id, kind, apiBase: base, apiKey: "", host });
    }
    return out;
  }

  function classifyHost(host) {
    host = String(host ?? "").toLowerCase();
    if (/(^|\.)kimi\.com$/.test(host)) return "kimi";
    if (/(^|\.)moonshot\.(cn|ai)$/.test(host)) return "moonshot";
    if (/(^|\.)deepseek\.(com|org)$/.test(host)) return "deepseek";
    if (/(^|\.)bigmodel\.cn$/.test(host)) return "zhipu";
    if (/(^|\.)z\.ai$/.test(host)) return "zhipu";
    if (/(^|\.)openrouter\.ai$/.test(host)) return "openrouter";
    if (/(^|\.)siliconflow\.cn$/.test(host)) return "siliconflow";
    return "generic";
  }

  function adapterFor(p) {
    if (p.kind === "kimi") return fetchKimi;
    if (p.kind === "zhipu") return () => fetchZhipu(p);
    if (p.kind === "deepseek") return () => fetchDeepSeek(p);
    if (p.kind === "moonshot") return () => fetchMoonshot(p);
    if (p.kind === "openrouter") return () => fetchOpenRouter(p);
    if (p.kind === "siliconflow") return () => fetchSiliconFlow(p);
    if (p.kind === "generic") return () => fetchGeneric(p);
    return null;
  }

  async function refreshProvider(p) {
    const fetcher = adapterFor(p);
    if (!fetcher) return;
    if (inFlight.has(p.id)) return;   // 同一 provider 去重：全量轮询与 busy 检测并发触发时不重复打接口
    inFlight.add(p.id);
    try {
      const snapshot = await fetcher();
      state.set(p.id, { ok: true, snapshot, fetchedAt: Date.now(), stale: false });
    } catch (err) {
      const raw = String(err?.message ?? err);
      // 浏览器直连被 CORS/网络挡下时，"Failed to fetch" 对用户毫无信息量
      const error = /failed to fetch|networkerror|load failed/i.test(raw)
        ? "网络失败或该接口不允许浏览器直连（CORS）" : raw;
      const prev = state.get(p.id);
      // 刷新失败但有过有效读数：保留旧数据（标记 stale），绝不空白也不归零
      state.set(p.id, {
        ok: false,
        error,
        snapshot: prev?.snapshot ?? null,
        fetchedAt: prev?.fetchedAt ?? 0,
        stale: !!prev?.snapshot,
      });
    } finally {
      inFlight.delete(p.id);
      render();
    }
  }

  async function refreshAll(staggerMs = 250) {
    for (const p of currentProviders()) {
      refreshProvider(p); // 并行发起
      await new Promise((r) => setTimeout(r, staggerMs));
    }
  }

  function schedulePoll() {
    setInterval(() => refreshAll(0), POLL_MS);
    setInterval(() => detectActiveModel(), MODEL_POLL_MS);
    setInterval(() => loadConfig(), CONFIG_POLL_MS);
    window.addEventListener("focus", () => {
      const stale = [...state.values()].every((s) => !s.fetchedAt || Date.now() - s.fetchedAt > POLL_MS);
      if (stale) refreshAll();
      detectActiveModel();
      loadConfig();
    });
    // 断网恢复后立即刷新（借鉴 QuotaBar）
    window.addEventListener("online", () => { refreshAll(); detectActiveModel(); });
    // 窗口被遮挡时 Chromium 把定时器节流到 ~1 次/分钟：用户"看回来"的时机
    // 立即补检测/刷新，切回应用马上跟上，而不是等下一轮
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      detectActiveModel();
      loadConfig();
      const stale = [...state.values()].every((s) => !s.fetchedAt || Date.now() - s.fetchedAt > POLL_MS);
      if (stale) refreshAll();
    });
    let lastWake = 0;
    document.addEventListener("mousemove", () => {
      if (Date.now() - lastWake < 10_000) return;
      lastWake = Date.now();
      detectActiveModel();
    });
  }

  // -------------------------------------------------------------------------
  // 徽章内容：当前 provider 的 套餐名 + 5小时/长窗口 两行
  // -------------------------------------------------------------------------
  function badgeRows(snapshot) {
    const rows = [];
    if (!snapshot?.planActive) return rows;
    const ok = (v) => (Number.isFinite(v) ? v : null);
    if (snapshot.five) rows.push({ label: "5小时", pct: ok(snapshot.five.pct), resetAt: snapshot.five.resetAt });
    else if (snapshot.unlimitedFive) rows.push({ label: "5小时", unlimited: true });
    if (snapshot.long) rows.push({ label: snapshot.long.label, pct: ok(snapshot.long.pct), resetAt: snapshot.long.resetAt });
    else if (snapshot.unlimitedLong) rows.push({ label: "长期", unlimited: true });
    return rows;
  }

  // 检测不可用时的兜底：显示用量最高的 provider
  function fallbackPick() {
    let best = null, bestScore = -1;
    for (const p of currentProviders()) {
      const s = state.get(p.id);
      const rows = badgeRows(s?.snapshot);
      if (!rows.length) continue;
      const pcts = rows.filter((r) => typeof r.pct === "number").map((r) => r.pct);
      const score = pcts.length ? Math.max(...pcts) : 0;
      if (score > bestScore) { best = { p, s, rows }; bestScore = score; }
    }
    return best;
  }

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------
  const UI = {};
  const CSS = `
.uu-badge{display:flex;align-items:center;gap:6px;flex:none;margin-left:2px;padding:3px 8px;border-radius:10px;
  cursor:pointer;user-select:none;color:var(--uu-fg);background:var(--uu-bg);border:1px solid var(--uu-border);
  transition:background .15s;line-height:1.3;}
.uu-badge:hover{background:var(--uu-bg-hover)}
.uu-dot{width:6px;height:6px;border-radius:50%;background:var(--uu-ok);flex:none}
.uu-dot.warn{background:var(--uu-warn)} .uu-dot.bad{background:var(--uu-bad)} .uu-dot.idle{background:var(--uu-track)}
.uu-rows{display:flex;flex-direction:column;gap:1px}
.uu-line{font-size:10.5px;white-space:nowrap}
.uu-line .uu-l{opacity:.65;margin-right:4px}
.uu-plan{font-size:10.5px;font-weight:600;white-space:nowrap}
.uu-plan .uu-sub{font-weight:400;opacity:.6}
.uu-p{font-weight:600;font-variant-numeric:tabular-nums}
.uu-p.warn{color:var(--uu-warn)} .uu-p.bad{color:var(--uu-bad)}
.uu-pop{position:fixed;z-index:2147483000;min-width:250px;max-width:340px;max-height:calc(100vh - 16px);overflow-y:auto;
  padding:10px 12px;border-radius:10px;
  font-size:12px;line-height:1.5;color:var(--uu-fg);background:var(--uu-pop-bg);border:1px solid var(--uu-border);
  box-shadow:0 8px 28px rgba(0,0,0,.35);backdrop-filter:blur(14px);}
.uu-pop h4{margin:0 0 2px;font-size:12px;font-weight:600;display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.uu-pop h4 span{font-weight:400;opacity:.65;font-size:11px}
.uu-tag{font-size:10px;font-weight:600;color:var(--uu-ok);opacity:1!important}
.uu-row{display:flex;align-items:center;gap:8px;margin-top:6px}
.uu-row .uu-lab{width:44px;flex:none;opacity:.75}
.uu-bar{flex:1;height:4px;border-radius:2px;background:var(--uu-track);overflow:hidden}
.uu-bar i{display:block;height:100%;border-radius:2px;background:var(--uu-ok)}
.uu-bar.warn i{background:var(--uu-warn)} .uu-bar.bad i{background:var(--uu-bad)}
.uu-pct{width:44px;text-align:right;font-variant-numeric:tabular-nums;flex:none}
.uu-used{margin-left:52px;font-size:10px;opacity:.55;margin-top:1px}
.uu-reset{margin-left:52px;font-size:10px;opacity:.55;margin-top:1px}
.uu-err{margin-top:6px;opacity:.6;font-size:11px}
.uu-foot{margin-top:8px;padding-top:6px;border-top:1px solid var(--uu-border);display:flex;justify-content:space-between;align-items:center}
.uu-foot button{all:unset;cursor:pointer;font-size:11px;opacity:.7;padding:2px 6px;border-radius:6px}
.uu-foot button:hover{opacity:1;background:var(--uu-bg-hover)}
.uu-foot time{font-size:10px;opacity:.45}
@media (prefers-color-scheme: light){ .uu-scope{
  --uu-fg:#3d3d46;--uu-bg:rgba(0,0,0,.05);--uu-bg-hover:rgba(0,0,0,.09);--uu-border:rgba(0,0,0,.1);
  --uu-pop-bg:rgba(255,255,255,.96);--uu-track:rgba(0,0,0,.1);
  --uu-ok:#16a34a;--uu-warn:#d97706;--uu-bad:#dc2626;}}
@media (prefers-color-scheme: dark){ .uu-scope{
  --uu-fg:#c9c9d1;--uu-bg:rgba(255,255,255,.07);--uu-bg-hover:rgba(255,255,255,.12);--uu-border:rgba(255,255,255,.12);
  --uu-pop-bg:rgba(30,30,34,.96);--uu-track:rgba(255,255,255,.12);
  --uu-ok:#4ade80;--uu-warn:#fbbf24;--uu-bad:#f87171;}}
.uu-scope.light{
  --uu-fg:#3d3d46;--uu-bg:rgba(0,0,0,.05);--uu-bg-hover:rgba(0,0,0,.09);--uu-border:rgba(0,0,0,.1);
  --uu-pop-bg:rgba(255,255,255,.96);--uu-track:rgba(0,0,0,.1);
  --uu-ok:#16a34a;--uu-warn:#d97706;--uu-bad:#dc2626;}
.uu-scope.dark{
  --uu-fg:#c9c9d1;--uu-bg:rgba(255,255,255,.07);--uu-bg-hover:rgba(255,255,255,.12);--uu-border:rgba(255,255,255,.12);
  --uu-pop-bg:rgba(30,30,34,.96);--uu-track:rgba(255,255,255,.12);
  --uu-ok:#4ade80;--uu-warn:#fbbf24;--uu-bad:#f87171;}
`;

  function themeClass() {
    const ds = document.documentElement.dataset.colorScheme;
    if (ds === "light" || ds === "dark") return `uu-scope ${ds}`;
    return `uu-scope ${matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"}`;
  }

  function pctClass(pct) { return pct >= 90 ? "bad" : pct >= 70 ? "warn" : ""; }

  function fmtReset(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return "";
    const s = Math.floor((t - Date.now()) / 1000);
    if (s <= 0) return "已重置";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}天${h}小时后重置`;
    if (h > 0) return `${h}小时${m}分后重置`;
    return `${m}分钟后重置`;
  }

  function fmtUsed(used, total) {
    if (typeof used !== "number" || typeof total !== "number" || total <= 0) return "";
    return `已用 ${used.toLocaleString()} / ${total.toLocaleString()}`;
  }

  function buildBadge() {
    const badge = document.createElement("div");
    badge.className = themeClass();
    const pill = document.createElement("div");
    pill.className = "uu-badge";
    pill.id = "uu-pill";
    badge.appendChild(pill);
    badge.addEventListener("click", (e) => { e.stopPropagation(); togglePop(); });
    return badge;
  }

  function renderBadgeContent(pill) {
    const pid = active.providerId;
    let p = pid ? currentProviders().find((x) => x.id === pid) : null;
    let s = p ? state.get(p.id) : null;

    // 当前模型不属于已配置适配的渠道（自定义渠道等）
    if (!p && active.unsupported) {
      pill.style.display = "";
      pill.textContent = "";
      const dot = document.createElement("span"); dot.className = "uu-dot idle";
      const wrap = document.createElement("span"); wrap.className = "uu-rows";
      const l1 = document.createElement("span"); l1.className = "uu-plan"; l1.textContent = active.unsupported.replace(/^managed:/, "").split("/")[0] || active.unsupported;
      const l2 = document.createElement("span"); l2.className = "uu-line"; l2.textContent = "该渠道暂无额度接口";
      wrap.append(l1, l2);
      pill.append(dot, wrap);
      pill.title = `当前模型 ${active.model}（点击查看其他套餐）`;
      return;
    }

    // 检测失败（拿不到当前模型）→ 兜底显示用量最高的 provider
    let rows = p ? badgeRows(s?.snapshot) : [];
    let fallback = false;
    if (!p || (!rows.length && !s?.ok)) {
      const fb = fallbackPick();
      if (fb) { p = fb.p; s = fb.s; rows = fb.rows; fallback = true; }
    }
    if (!p) { pill.style.display = "none"; return; }
    pill.style.display = "";

    pill.textContent = "";
    const snap = s?.snapshot;
    const dot = document.createElement("span");
    if (!s?.ok) dot.className = `uu-dot ${snap ? "idle" : "bad"}`;
    else {
      const pcts = rows.filter((r) => typeof r.pct === "number").map((r) => r.pct);
      const worst = pcts.length ? Math.max(...pcts) : 0;
      dot.className = `uu-dot ${worst >= 90 ? "bad" : worst >= 70 ? "warn" : snap?.planActive ? "" : "idle"}`;
    }
    const wrap = document.createElement("span");
    wrap.className = "uu-rows";

    const planLine = document.createElement("span");
    planLine.className = "uu-plan";
    planLine.textContent = snap?.plan ?? p.label;
    if (fallback) {
      const sub = document.createElement("span"); sub.className = "uu-sub"; sub.textContent = "（兜底显示）";
      planLine.appendChild(sub);
    } else if (!s?.ok && snap) {
      const sub = document.createElement("span"); sub.className = "uu-sub"; sub.textContent = " ·数据可能过期";
      planLine.appendChild(sub);
    }
    wrap.appendChild(planLine);

    if (!s?.ok && !snap) {
      const l = document.createElement("span"); l.className = "uu-line"; l.textContent = "查询失败";
      wrap.appendChild(l);
    } else if (!rows.length) {
      // 无套餐窗口：按量余额 / 通用渠道状态 / 无套餐数据
      const l = document.createElement("span"); l.className = "uu-line";
      l.textContent = snap?.statusText ?? snap?.balanceText ?? "无套餐数据";
      wrap.appendChild(l);
    } else {
      for (const r of rows) {
        const line = document.createElement("span");
        line.className = "uu-line";
        const lab = document.createElement("span"); lab.className = "uu-l"; lab.textContent = r.label;
        const val = document.createElement("span"); val.className = `uu-p ${r.unlimited ? "" : pctClass(r.pct)}`;
        val.textContent = r.unlimited ? "无限制" : Number.isFinite(r.pct) ? `${r.pct}%` : "--";
        line.append(lab, val);
        wrap.appendChild(line);
      }
    }
    pill.append(dot, wrap);
    pill.title = `${snap?.plan ?? p.label}（点击查看全部）`;
  }

  function popWindowRows(pop, s) {
    const renderRow = (label, w) => {
      const row = document.createElement("div");
      row.className = "uu-row";
      const lab = document.createElement("span"); lab.className = "uu-lab"; lab.textContent = label;
      row.appendChild(lab);
      if (w.unlimited) {
        const pctEl = document.createElement("span"); pctEl.className = "uu-pct"; pctEl.textContent = "无限制";
        row.appendChild(pctEl);
      } else {
        const pct = Number.isFinite(w.pct) ? w.pct : null;
        const bar = document.createElement("span"); bar.className = `uu-bar ${pctClass(pct ?? 0)}`;
        const fill = document.createElement("i"); fill.style.width = `${Math.min(100, Math.max(2, pct ?? 0))}%`;
        bar.appendChild(fill);
        const pctEl = document.createElement("span"); pctEl.className = "uu-pct"; pctEl.textContent = pct == null ? "--" : `${pct}%`;
        row.append(bar, pctEl);
      }
      pop.appendChild(row);
      if (!w.unlimited && w.resetAt) {
        const rs = document.createElement("div"); rs.className = "uu-reset"; rs.textContent = fmtReset(w.resetAt);
        pop.appendChild(rs);
      }
      const usedTxt = fmtUsed(w.used, w.total);
      if (usedTxt) {
        const us = document.createElement("div"); us.className = "uu-used"; us.textContent = usedTxt;
        pop.appendChild(us);
      }
    };
    if (s.five) renderRow("5小时", s.five); else if (s.unlimitedFive) renderRow("5小时", { unlimited: true });
    if (s.long) renderRow(s.long.label, s.long); else if (s.unlimitedLong) renderRow("长期", { unlimited: true });
    for (const o of s.others ?? []) renderRow(o.label, o);
  }

  function buildPop() {
    const pop = document.createElement("div");
    pop.className = `uu-pop ${themeClass()}`;
    pop.id = "uu-pop";
    pop.addEventListener("click", (e) => e.stopPropagation());
    return pop;
  }

  function renderPopContent(pop) {
    pop.textContent = "";
    for (const p of currentProviders()) {
      const s = state.get(p.id);
      const h = document.createElement("h4");
      h.textContent = p.label;
      const isActive = active.providerId === p.id;
      const right = document.createElement("span");
      if (isActive) { right.className = "uu-tag"; right.textContent = "当前"; }
      else if (s?.snapshot?.plan) right.textContent = s.snapshot.plan;
      h.appendChild(right);
      pop.appendChild(h);
      if (!s) { const e = document.createElement("div"); e.className = "uu-err"; e.textContent = "尚未获取"; pop.appendChild(e); continue; }
      if (!s.ok) { const e = document.createElement("div"); e.className = "uu-err"; e.textContent = `查询失败：${s.error ?? ""}`; pop.appendChild(e); continue; }
      if (!s.snapshot.planActive) {
        const e = document.createElement("div"); e.className = "uu-err";
        e.textContent = s.snapshot.statusText ?? s.snapshot.balanceText ?? "无套餐数据";
        pop.appendChild(e); continue;
      }
      popWindowRows(pop, s.snapshot);
      const hasWindows = s.snapshot.five || s.snapshot.long || (s.snapshot.others?.length ?? 0) > 0;
      if (!hasWindows) {
        const e = document.createElement("div"); e.className = "uu-err";
        e.textContent = s.snapshot.statusText ?? s.snapshot.balanceText ?? "无窗口数据";
        pop.appendChild(e);
      }
    }
    // 新版待生效：磁盘注入版本（config.version，hook 每次会话重写）领先于本页
    // 正在运行的版本（注入标签 ?v=）→ 点击重载页面立即切换。版本一致的瞬间
    // 横幅自动消失（15s 配置轮询），不会出现"刷新后横幅还在"的情况
    const diskV = CONFIG.version ?? CONFIG.update?.running;
    if (RUNNING_VERSION && diskV && diskV !== RUNNING_VERSION) {
      const note = document.createElement("button");
      note.className = "uu-err";
      note.style.cssText = "display:block;width:100%;text-align:left;color:var(--uu-ok);cursor:pointer;padding:0";
      note.title = "点击刷新页面，立即切换到新版本";
      note.textContent = `🆕 新版 v${diskV} 待生效（本页还在跑 v${RUNNING_VERSION}）· 点击立即刷新`;
      note.addEventListener("click", () => location.reload());
      pop.appendChild(note);
    }
    const foot = document.createElement("div");
    foot.className = "uu-foot";
    const btn = document.createElement("button");
    btn.textContent = "刷新";
    btn.addEventListener("click", () => { refreshAll(); });
    const ts = document.createElement("time");
    const times = [...state.values()].map((s) => s.fetchedAt).filter(Boolean);
    ts.textContent = times.length ? new Date(Math.max(...times)).toLocaleTimeString() : "";
    foot.append(btn, ts);
    pop.appendChild(foot);
  }

  let popOpen = false;
  function togglePop(force) {
    popOpen = force ?? !popOpen;
    if (!popOpen) { UI.pop?.remove(); UI.pop = null; return; }
    const pill = document.getElementById("uu-pill");
    if (!pill) return;
    const pop = UI.pop ?? (UI.pop = buildPop());
    renderPopContent(pop);
    document.body.appendChild(pop);
    const r = pill.getBoundingClientRect();
    const pr = pop.getBoundingClientRect();
    pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pr.width - 8))}px`;
    pop.style.top = `${Math.max(8, r.top - pr.height - 8)}px`;
  }
  document.addEventListener("click", () => { if (popOpen) togglePop(false); });
  addEventListener("resize", () => { if (popOpen) togglePop(true); });

  // -------------------------------------------------------------------------
  // 挂载：徽章插到 .side-footer 里，用户名区域之后、设置齿轮之前
  // SPA 会重渲染侧边栏，用轮询保证徽章一直存在；侧边栏折叠时隐藏
  // -------------------------------------------------------------------------
  function ensureBadge() {
    const footer = document.querySelector(".side-footer");
    if (!footer) { if (UI.badge) { UI.badge.remove(); UI.badge = null; } return; }
    const account = footer.querySelector(".side-footer-account");
    const collapsed = !account || account.offsetWidth === 0;
    if (collapsed) {
      if (UI.badge) { UI.badge.style.display = "none"; UI.badge.dataset.collapsed = "1"; }
      return;
    }
    if (!UI.badge || !UI.badge.isConnected || !footer.contains(UI.badge)) {
      if (!UI.badge) UI.badge = buildBadge();
      if (account.nextElementSibling) footer.insertBefore(UI.badge, account.nextElementSibling);
      else footer.appendChild(UI.badge);
    }
    UI.badge.style.display = "";
    delete UI.badge.dataset.collapsed;
    renderBadgeContent(UI.badge.firstChild);
  }

  function render() {
    if (UI.badge?.isConnected) renderBadgeContent(UI.badge.firstChild);
    if (popOpen && UI.pop?.isConnected) renderPopContent(UI.pop);
  }

  function boot() {
    try {
      const style = document.createElement("style");
      style.textContent = CSS;
      document.head.appendChild(style);
    } catch {}
    // 主题切换跟随：应用内切明暗主题（改根元素 class/data-color-scheme）或
    // 系统主题变化时，已挂载的徽章/弹窗同步换肤，而不是等重建
    const applyTheme = () => {
      const cls = themeClass();
      if (UI.badge) UI.badge.className = cls;
      if (UI.pop) UI.pop.className = `uu-pop ${cls}`;
    };
    try {
      new MutationObserver(applyTheme).observe(document.documentElement, {
        attributes: true, attributeFilter: ["class", "data-color-scheme"],
      });
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
    } catch {}
    ensureBadge();
    setInterval(ensureBadge, ATTACH_CHECK_MS);
    // 延迟首轮拉取：等宿主 SPA 把最新的本地 server 地址写进 sessionStorage（应用重启后端口会变）
    setTimeout(async () => { await loadConfig(); refreshAll(); detectActiveModel(); }, FIRST_FETCH_DELAY);
    schedulePoll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
