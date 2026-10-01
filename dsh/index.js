// dsh/index.js — DSH Host 半边 (bundle 形态)
//
// 责任: 多 provider 通用 quota fetch.
//       调 DSH 自己的 `credentials` Service 拿用户已配的 API Key;
//       用 `subprocess` 调 `curl` 拉各 provider 的用量 (DSH 部署没有
//       fetch provider, 且 DSH `web.fetch` 协议本身不允许加 Authorization
//       header —— 只能走 curl); 30s 内存缓存 + 指数退避.
//
// 本地 fork 变更 (v1.1.0):
//   - 新增 stepfun provider: GET /v1/accounts 按量余额 (CNY, 含现金/代金券
//     细分). Step Plan (Token Plan) Credit 用量没有 API-Key 认证的查询端点
//     (官网 account-overview 走 Connect RPC + 网页登录态), 故只做余额展示
//     并在 display.planNote 提示 Credit 需官网查看.
//     (实测记录 2026-09-22: step_plan/v1 下 usages/usage/quota/credits/
//      subscription/balance 全部 404; /v1/credits、/v1/subscription 404;
//      chat/completions 响应头无用量字段.)
//// 形态说明 (v0.1.0): 本文件是 npm/GitHub 可安装 bundle 的 host 入口,
// 通过仓库根 cordis.patch.yml 的 `musage` 行挂载 (package.json 的
// dsh.bundle manifest). 旧的 cordis_define 手动部署形态 (host.js 函数体)
// 已退役 —— 服务访问从 `ctx.get(name)` 改为 inject 声明后的属性访问
// `ctx.<name>`, client 调用入口从 `harness.handle('quota:fetch')` 改为
// webServer 路由 `GET /musage/quota?provider=<p>&force=1` (JSON 返回同
// 一个 result 对象, client 半边用同源 fetch 调).
//
// 关键决策 (继承自 host.js v0.0.21):
//   - DSH 在用户已配的 <provider> 路由都按 `<UPPER_PROVIDER>_API_KEY` 命名规范存储
//     (推导规则见 dsh-client-ui-settings-models/lib/client.js:476). 例如
//     `minimax-cn` → `MINIMAX_CN_API_KEY`, `deepseek` → `DEEPSEEK_API_KEY`.
//   - minimax API 2026-06-01 改了 schema, 兼容 percent-based + count-based 两种.
//   - 不模仿 Musage 自己存 keys.json, 全部走 DSH credentials.resolve() ——
//     密钥安全 + 用户配置零重复.
//   - `subprocess` 调 curl: DSH 部署里没有 fetch provider, 且 WebFetchProvider
//     协议只支持 GET + url, 不能加 headers.

const POLL_INTERVAL_MS = 60_000;
const CACHE_TTL_MS = 30_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export const name = "musage";
export const inject = ["credentials", "subprocess", "timer"];

// ============================================================
// Provider 注册表
// ============================================================
// 每个 provider:
//   - refs: 候选 credentials ref 列表, 按优先级尝试
//   - urls: { ref: endpoint } 端点
//   - parse: (body) => { ok, ...data | kind, message }
//
// minimax: percent-based / count-based 双 schema (来自 ccswitch 逆向)
// deepseek: user/balance 端点, 返回 CNY/USD 余额 (来自 Musage deepseek.rs)
// stepfun: /v1/accounts 端点, 返回 CNY 余额 (prepaid 型; 2026-09-22 实测).
//   注意: StepFun 的 Step Plan (Token Plan) Credit 用量没有 API-Key 认证的
//   查询端点 —— 官网 account-overview 的 subscriptionCreditLeftRate /
//   creditBuckets 字段走 Connect RPC + 网页登录态 (Oasis-* 头 + session
//   token), 插件无法复用. 因此本 provider 只显示按量余额, 并在 display 里
//   附带 planNote 提示 Credit 需官网查看.

const PROVIDERS = {
  minimax: {
    refs: ["MINIMAX_CN_API_KEY", "MINIMAX_EN_API_KEY", "MINIMAX_API_KEY"],
    urls: {
      MINIMAX_CN_API_KEY: "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
      MINIMAX_EN_API_KEY: "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
      MINIMAX_API_KEY:   "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
    },
    parse: parseMinimaxResponse,
  },
  deepseek: {
    refs: ["DEEPSEEK_API_KEY"],
    urls: {
      DEEPSEEK_API_KEY: "https://api.deepseek.com/user/balance",
    },
    parse: parseDeepseekBalance,
  },
  kimi: {
    refs: ["KIMI_CODING_API_KEY", "KIMI_API_KEY"],
    urls: {
      KIMI_CODING_API_KEY: "https://api.kimi.com/coding/v1/usages",
      KIMI_API_KEY:         "https://api.kimi.com/coding/v1/usages",
    },
    parse: parseKimiResponse,
  },
  openrouter: {
    refs: ["OPENROUTER_API_KEY"],
    urls: {
      OPENROUTER_API_KEY: "https://openrouter.ai/api/v1/credits",
    },
    parse: parseOpenrouterResponse,
  },
  zhipu: {
    refs: ["ZAI_CODING_CN_API_KEY", "ZHIPU_API_KEY"],
    urls: {
      ZAI_CODING_CN_API_KEY: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
      ZHIPU_API_KEY:          "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    },
    parse: parseZhipuResponse,
    // 智谱特殊: Authorization header 不加 "Bearer " 前缀 (来自 Musage zhipu.rs 注释)
    authStyle: "raw",
  },
  stepfun: {
    refs: ["STEPFUN_API_KEY"],
    urls: {
      STEPFUN_API_KEY: "https://api.stepfun.com/v1/accounts",
    },
    parse: parseStepfunResponse,
  },
  // ── 以下为 2026-10 扩展的 5 家（对齐 Musage 对应用量源）──
  siliconflow: {
    refs: ["SILICONFLOW_API_KEY"],
    urls: {
      SILICONFLOW_API_KEY: "https://api.siliconflow.cn/v1/user/info",
    },
    parse: parseSiliconflowResponse,
  },
  tavily: {
    refs: ["TAVILY_API_KEY"],
    urls: {
      TAVILY_API_KEY: "https://api.tavily.com/usage",
    },
    parse: parseTavilyResponse,
  },
  zenmux: {
    refs: ["ZENMUX_MANAGEMENT_API_KEY", "ZENMUX_API_KEY"],
    urls: {
      ZENMUX_MANAGEMENT_API_KEY: "https://zenmux.ai/api/v1/management/payg/balance",
      ZENMUX_API_KEY:            "https://zenmux.ai/api/v1/management/payg/balance",
    },
    parse: parseZenmuxResponse,
  },
  xiaomi: {
    // MiMo 用量走 dashboard API (platform.xiaomimimo.com/api/v1/tokenPlan/usage)。
    // 鉴权双形态（对齐 Musage xiaomi.rs 的 ApiKeyOrCookie; Bearer 优先, Cookie 兜底）：
    //   - DSH pi-ai 内置三区 Token Plan API key（xiaomi-token-plan-{ams,cn,sgp}）
    //     → Authorization: Bearer <key>
    //   - 浏览器 dashboard 登录态 → Cookie: <整段 Cookie header 值>
    // refs 顺序 = 探测顺序（key 先、cookie 兜底）。
    refs: [
      "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
      "XIAOMI_TOKEN_PLAN_CN_API_KEY",
      "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
      "XIAOMI_API_KEY",
      "XIAOMI_MIMO_COOKIE",
      "XIAOMI_COOKIE",
      "MIMO_COOKIE",
    ],
    urls: {
      XIAOMI_TOKEN_PLAN_AMS_API_KEY: "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
      XIAOMI_TOKEN_PLAN_CN_API_KEY:  "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
      XIAOMI_TOKEN_PLAN_SGP_API_KEY: "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
      XIAOMI_API_KEY:                "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
      XIAOMI_MIMO_COOKIE:            "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
      XIAOMI_COOKIE:                 "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
      MIMO_COOKIE:                   "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage",
    },
    parse: parseXiaomiResponse,
    // 按命中的 ref 分派鉴权形态（curlFetch 的 authStyle）；未列出的 ref 用 authStyle 兜底。
    authStyleByRef: {
      XIAOMI_TOKEN_PLAN_AMS_API_KEY: "bearer",
      XIAOMI_TOKEN_PLAN_CN_API_KEY:  "bearer",
      XIAOMI_TOKEN_PLAN_SGP_API_KEY: "bearer",
      XIAOMI_API_KEY:                "bearer",
      XIAOMI_MIMO_COOKIE:            "cookie",
      XIAOMI_COOKIE:                 "cookie",
      MIMO_COOKIE:                   "cookie",
    },
    authStyle: "bearer",
  },
  claude: {
    // Claude 官方 OAuth 用量 (Claude Pro / Max 订阅): 凭据是 claude.ai 的 sessionKey cookie.
    refs: ["CLAUDE_SESSION_KEY", "ANTHROPIC_SESSION_KEY", "CLAUDE_CODE_SESSION_KEY"],
    urls: {
      CLAUDE_SESSION_KEY:      "https://api.anthropic.com/api/oauth/usage",
      ANTHROPIC_SESSION_KEY:   "https://api.anthropic.com/api/oauth/usage",
      CLAUDE_CODE_SESSION_KEY: "https://api.anthropic.com/api/oauth/usage",
    },
    parse: parseClaudeResponse,
    authStyle: "claude",
  },
};

function nowMs() {
  return Date.now();
}

function computeBackoffMs(streak) {
  if (streak <= 0) return 0;
  const ms = BACKOFF_BASE_MS * Math.pow(2, streak - 1);
  return Math.min(BACKOFF_MAX_MS, ms);
}

function parseEndTime(v) {
  if (typeof v !== "number") return null;
  if (v >= 1e12 && v <= 4e12) return v;
  return nowMs() + v * 1000;
}

// ----- minimax schema parser (2026-06-01 双 schema 兼容) -----

function parseMinimaxResponse(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  const baseResp = json && json.base_resp;
  if (!baseResp || baseResp.status_code !== 0) {
    return {
      ok: false,
      kind: "server_error",
      message: (baseResp && baseResp.status_msg) || "API 返回 base_resp.status_code != 0",
    };
  }
  const arr = json && json.model_remains;
  if (!Array.isArray(arr) || arr.length === 0) {
    return { ok: false, kind: "parse", message: "model_remains 为空" };
  }
  const entry = arr.find((r) => r && r.model_name === "general") || arr[0];
  if (!entry) return { ok: false, kind: "parse", message: "找不到可用 model_remains 条目" };

  const fiveHour = parseMinimaxWindow(entry, "current_interval_", "current_interval_usage_count", "current_interval_total_count", "end_time");
  const weekly = parseMinimaxWindow(entry, "current_weekly_", "current_weekly_usage_count", "current_weekly_total_count", "weekly_end_time");

  if (!fiveHour && !weekly) {
    return { ok: false, kind: "schema_unknown", message: "MiniMax 响应字段都不认识" };
  }
  return {
    ok: true,
    provider: "minimax",
    fiveHour, weekly,
    display: {
      fiveHrPct: fiveHour ? Math.max(0, Math.min(100, Math.round(fiveHour.usedPercent))) : null,
      weeklyPct: weekly ? Math.max(0, Math.min(100, Math.round(weekly.usedPercent))) : null,
      fiveHrResetsIn: fiveHour ? formatResetsIn(fiveHour.resetsAt) : null,
      weeklyResetsIn: weekly ? formatResetsIn(weekly.resetsAt) : null,
    },
  };
}

function parseMinimaxWindow(entry, prefix, legacyRemaining, legacyTotal, endTimeKey) {
  const newPercent = entry[prefix + "remaining_percent"];
  const newStatus = entry[prefix + "status"];
  if (typeof newPercent === "number" && newStatus === 1) {
    return {
      usedPercent: Math.max(0, 100 - newPercent),
      remainingPercent: newPercent,
      resetsAt: parseEndTime(entry[endTimeKey]),
      schema: "percent",
    };
  }
  const total = entry[prefix + "total_count"];
  const remaining = entry[legacyRemaining] || entry[prefix + "usage_count"];
  if (typeof total === "number" && total > 0 && typeof remaining === "number") {
    return {
      usedPercent: Math.max(0, ((total - remaining) / total) * 100),
      remainingPercent: Math.max(0, (remaining / total) * 100),
      resetsAt: parseEndTime(entry[endTimeKey]),
      schema: "count",
    };
  }
  return null;
}

// ----- deepseek balance parser (从 Musage deepseek.rs 抄, v0.0.19 验证) -----
// 真实 schema:
//   { "is_available": true,
//     "balance_infos": [ { "currency": "CNY", "total_balance": "43.97",
//                            "granted_balance": "0.00", "topped_up_balance": "43.97" } ] }

function parseDeepseekBalance(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, kind: "parse", message: "DeepSeek 响应不是对象" };
  }
  if (json.is_available === false) {
    return { ok: false, kind: "server_error", message: "DeepSeek 账号 is_available=false" };
  }
  const infos = json.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) {
    return { ok: false, kind: "parse", message: "balance_infos 字段为空" };
  }
  const first = infos[0];
  const totalStr = first && first.total_balance;
  if (typeof totalStr !== "string" && typeof totalStr !== "number") {
    return { ok: false, kind: "parse", message: "balance_infos[0].total_balance 不存在" };
  }
  const balance = parseFloat(totalStr);
  if (!isFinite(balance)) {
    return { ok: false, kind: "parse", message: "balance 解析成数字失败: " + totalStr };
  }
  const currency = (first && first.currency) || "USD";
  return {
    ok: true,
    provider: "deepseek",
    balance,
    currency,
    display: {
      balanceUsd: balance,
      balanceText: formatBalance(balance, currency),
    },
  };
}

// ----- kimi parser (Musage kimi.rs schema: 5h 窗口 + 7d 窗口) -----
//   { "limits": [ { "detail": { "limit": 100, "remaining": 72, "resetTime": "..." } } ],
//     "usage": { "limit": 1000, "remaining": 742, "resetTime": 1749840000 } }

function parseKimiResponse(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, kind: "parse", message: "Kimi 响应不是对象" };
  }
  // 错误响应: {"code": "permission_denied", ...}
  if (json.code && json.code !== 200 && json.code !== "200") {
    return { ok: false, kind: "server_error", message: "Kimi 返错: " + (json.code || "?") + " · " + (json.msg || "") };
  }
  // 5h 窗口: limits[0].detail
  const firstLimit = Array.isArray(json.limits) && json.limits[0] && json.limits[0].detail;
  const five = firstLimit || {};
  const fiveHrLimit = Number(five.limit) || 0;
  const fiveHrRemaining = Number(five.remaining) || 0;
  const fiveHrResetsAt = parseKimiResetTime(five.resetTime);
  // 7d 窗口: usage
  const week = json.usage || {};
  const weeklyLimit = Number(week.limit) || 0;
  const weeklyRemaining = Number(week.remaining) || 0;
  const weeklyResetsAt = parseKimiResetTime(week.resetTime);
  if (!fiveHrLimit && !weeklyLimit) {
    return { ok: false, kind: "parse", message: "Kimi 响应没有 5h/7d 限额" };
  }
  return {
    ok: true,
    provider: "kimi",
    fiveHour: { limit: fiveHrLimit, remaining: fiveHrRemaining, resetsAt: fiveHrResetsAt },
    weekly:   { limit: weeklyLimit,   remaining: weeklyRemaining,   resetsAt: weeklyResetsAt },
    display: {
      fiveHrPct:     fiveHrLimit     > 0 ? Math.round((fiveHrLimit - fiveHrRemaining) / fiveHrLimit * 100) : null,
      weeklyPct:     weeklyLimit     > 0 ? Math.round((weeklyLimit - weeklyRemaining) / weeklyLimit * 100) : null,
      fiveHrResetsIn: fiveHrResetsAt ? formatResetsIn(fiveHrResetsAt) : null,
      weeklyResetsIn: weeklyResetsAt ? formatResetsIn(weeklyResetsAt) : null,
    },
  };
}

function parseKimiResetTime(v) {
  if (typeof v === "number") {
    if (v >= 1e12 && v <= 4e12) return v;
    if (v > 1e9) return v * 1000;
    return null;
  }
  if (typeof v === "string" && v.length > 0) {
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  return null;
}

// ----- openrouter parser (Musage openrouter.rs: total_credits - total_usage) -----

function parseOpenrouterResponse(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, kind: "parse", message: "OpenRouter 响应不是对象" };
  }
  const data = json.data;
  if (!data || typeof data !== "object") {
    return { ok: false, kind: "parse", message: "data 字段缺失" };
  }
  const total = Number(data.total_credits);
  const used = Number(data.total_usage);
  if (!isFinite(total) || !isFinite(used)) {
    return { ok: false, kind: "parse", message: "total_credits / total_usage 不是数字" };
  }
  const remaining = total - used;
  return {
    ok: true,
    provider: "openrouter",
    balance: remaining,
    totalCredits: total,
    usedCredits: used,
    currency: "USD",
    display: {
      balanceUsd: remaining,
      balanceText: formatBalance(remaining, "USD"),
    },
  };
}

// ----- zhipu (智谱 GLM Coding Plan) parser (Musage zhipu.rs) -----
//   { "code": 200, "success": true,
//     "data": { "limits": [ { "type": "CREDIT_LIMIT", "unit": 3, "usage": 2000,
//                "remaining": 0, "percentage": 100, "nextResetTime": 1786969101067 }, ... ] } }
// unit=3 是 5h 窗口, unit=6 是周窗口. percentage 直接是已用 0-100 (服务器算好).

function parseZhipuResponse(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, kind: "parse", message: "智谱响应不是对象" };
  }
  if (json.success === false) {
    return { ok: false, kind: "server_error", message: "智谱 success=false · " + (json.msg || "") };
  }
  const data = json.data;
  if (!data || !Array.isArray(data.limits)) {
    return { ok: false, kind: "parse", message: "data.limits 缺失" };
  }
  // unit=3 = 5h, unit=6 = 周. 找 limit
  const fiveHr = data.limits.find((l) => l && (l.unit === 3 || l.unit === "3"));
  const weekly = data.limits.find((l) => l && (l.unit === 6 || l.unit === "6"));
  if (!fiveHr && !weekly) {
    return { ok: false, kind: "parse", message: "找不到 unit=3 (5h) 或 unit=6 (周) 的 limit" };
  }
  function pickWindow(w) {
    if (!w) return null;
    const limit = Number(w.usage) || 0;
    const remaining = Number(w.remaining) || 0;
    const pct = (typeof w.percentage === "number") ? w.percentage : (limit > 0 ? Math.round((limit - remaining) / limit * 100) : null);
    const resetsAt = parseEndTime(w.nextResetTime);
    return { limit, remaining, usedPercent: pct, resetsAt };
  }
  const f = pickWindow(fiveHr);
  const w = pickWindow(weekly);
  return {
    ok: true,
    provider: "zhipu",
    fiveHour: f,
    weekly: w,
    display: {
      fiveHrPct:     f ? f.usedPercent : null,
      weeklyPct:     w ? w.usedPercent : null,
      fiveHrResetsIn: f && f.resetsAt ? formatResetsIn(f.resetsAt) : null,
      weeklyResetsIn: w && w.resetsAt ? formatResetsIn(w.resetsAt) : null,
    },
  };
}

// ----- stepfun accounts parser (按量余额; 2026-09-22 实测 schema) -----
//   { "object": "account", "type": "prepaid", "balance": 15.00,
//     "total_cash_balance": 0.00, "total_voucher_balance": 15.00 }
// balance = total_cash_balance + total_voucher_balance (现金 + 代金券).
// Step Plan Credit 用量无 API-Key 端点, 通过 planNote 提示用户去官网看.

function parseStepfunResponse(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, kind: "parse", message: "StepFun 响应不是对象" };
  }
  // 错误响应: { "error": { "message": "...", "code": "..." } }
  if (json.error) {
    return {
      ok: false,
      kind: "server_error",
      message: "StepFun 返错: " + (json.error.message || json.error.code || "unknown"),
    };
  }
  const balance = Number(json.balance);
  if (!isFinite(balance)) {
    return { ok: false, kind: "parse", message: "balance 字段缺失或不是数字" };
  }
  const cash = Number(json.total_cash_balance);
  const voucher = Number(json.total_voucher_balance);
  return {
    ok: true,
    provider: "stepfun",
    balance,
    currency: "CNY",
    cashBalance: isFinite(cash) ? cash : null,
    voucherBalance: isFinite(voucher) ? voucher : null,
    planType: typeof json.type === "string" ? json.type : null,
    display: {
      balanceUsd: balance,          // client 余额型分支复用该字段; 单位实际是 CNY
      balanceText: formatBalance(balance, "CNY"),
      // 细分: 现金 / 代金券 (有值才显示)
      balanceDetail: (isFinite(cash) && isFinite(voucher))
        ? "现金 " + formatBalance(cash, "CNY") + " · 券 " + formatBalance(voucher, "CNY")
        : null,
      // Step Plan Credit 无法经 API 查询, 卡片上明确提示, 避免误读余额=Credit
      planNote: "Step Plan Credit 用量仅官网可查",
    },
  };
}

// ----- siliconflow parser (Musage siliconflow.rs; schema 2026-06 官方 API ref 实测) -----
//   { "code": 20000, "message": "OK", "status": true,
//     "data": { "balance": "0.88", "chargeBalance": "88.00", "totalBalance": "88.88" } }
// balance = 剩余可用余额（字符串数字）；chargeBalance = 充值余额；totalBalance = 总余额。

function parseSiliconflowResponse(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, kind: "parse", message: "SiliconFlow 响应不是对象" };
  }
  // HTTP 200 但业务码非 20000：典型为鉴权失败 / key 无效。
  const code = json.code;
  if (code !== undefined && code !== null && Number(code) !== 20000) {
    return { ok: false, kind: "server_error", message: "SiliconFlow 业务码 " + code + " · " + (json.message || "") };
  }
  const data = json.data;
  if (!data || typeof data !== "object") {
    return { ok: false, kind: "parse", message: "data 字段缺失" };
  }
  const balance = parseFloat(data.balance);
  if (!isFinite(balance)) {
    return { ok: false, kind: "parse", message: "data.balance 缺失或不是数字: " + data.balance };
  }
  const charge = parseFloat(data.chargeBalance);
  const total = parseFloat(data.totalBalance);
  const detailParts = [];
  if (isFinite(charge)) detailParts.push("充值 " + formatBalance(charge, "CNY"));
  if (isFinite(total)) detailParts.push("总额 " + formatBalance(total, "CNY"));
  return {
    ok: true,
    provider: "siliconflow",
    balance,
    currency: "CNY",
    display: {
      balanceUsd: balance,          // client 余额型分支复用该字段；单位实际是 CNY
      balanceText: formatBalance(balance, "CNY"),
      balanceDetail: detailParts.length ? detailParts.join(" · ") : null,
    },
  };
}

// ----- tavily parser (Musage tavily.rs; docs /usage endpoint) -----
//   { "account": { "current_plan": "Researcher", ... },
//     "key": { "usage": 150, "limit": 1000, "search_usage": 80, "extract_usage": 20,
//              "crawl_usage": 0, "map_usage": 0, "research_usage": 50 } }
// Tavily 是 search API（非 LLM）：展示「已用 / 总量 credits」；部分套餐 limit 为 null。

function parseTavilyResponse(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, kind: "parse", message: "Tavily 响应不是对象" };
  }
  const key = json.key;
  if (!key || typeof key !== "object") {
    return { ok: false, kind: "parse", message: "key 字段缺失" };
  }
  const used = Number(key.usage);
  if (!isFinite(used)) {
    return { ok: false, kind: "parse", message: "key.usage 缺失或不是数字" };
  }
  // Researcher 等套餐 limit=null（表示按量上限不固定）——此时只显示已用。
  const limit = key.limit === null || !isFinite(Number(key.limit)) ? null : Number(key.limit);
  const plan = json.account && typeof json.account.current_plan === "string" ? json.account.current_plan : null;
  const text = limit === null ? (used + " credits 已用") : (used + " / " + limit + " credits");
  const detailDefs = [
    ["search_usage", "搜索"],
    ["extract_usage", "提取"],
    ["crawl_usage", "抓取"],
    ["map_usage", "地图"],
    ["research_usage", "研究"],
  ];
  const detailParts = [];
  for (const [field, label] of detailDefs) {
    const v = Number(key[field]);
    if (isFinite(v) && v > 0) detailParts.push(label + " " + v);
  }
  const notes = [];
  if (plan) notes.push("套餐 " + plan);
  if (detailParts.length) notes.push(detailParts.join(" · "));
  return {
    ok: true,
    provider: "tavily",
    display: {
      balanceLabel: "用量",
      balanceText: text,
      balanceDetail: notes.length ? notes.join(" — ") : null,
    },
  };
}

// ----- zenmux parser (Musage zenmux.rs; PAYG 余额端点, docs zenmux.ai/docs/zh/api/platform/payg-balance.html) -----
//   { "success": true, "data": { "currency": "usd", "total_credits": 482.74,
//                                "top_up_credits": 35.0, "bonus_credits": 447.74 } }
// total_credits = top_up_credits + bonus_credits。凭据须为 Management API Key（sk-mg-v1- 前缀）。

function parseZenmuxResponse(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, kind: "parse", message: "ZenMux 响应不是对象" };
  }
  if (json.success !== true) {
    return { ok: false, kind: "server_error", message: "ZenMux success != true" + (json.message ? " · " + json.message : "") };
  }
  const data = json.data;
  if (!data || typeof data !== "object") {
    return { ok: false, kind: "parse", message: "data 字段缺失" };
  }
  const total = Number(data.total_credits);
  if (!isFinite(total)) {
    return { ok: false, kind: "parse", message: "data.total_credits 缺失或不是数字" };
  }
  const topUp = Number(data.top_up_credits);
  const bonus = Number(data.bonus_credits);
  const detailParts = [];
  if (isFinite(topUp)) detailParts.push("充值 " + formatBalance(topUp, "USD"));
  if (isFinite(bonus)) detailParts.push("奖励 " + formatBalance(bonus, "USD"));
  return {
    ok: true,
    provider: "zenmux",
    balance: total,
    currency: "USD",
    display: {
      balanceUsd: total,
      balanceText: formatBalance(total, "USD"),
      balanceDetail: detailParts.length ? detailParts.join(" · ") : null,
    },
  };
}

// ----- xiaomi (MiMo) parser (Musage xiaomi.rs; dashboard admin API, 凭据=整段 Cookie header) -----
//   data.usage.percent      = 套餐用量（plan_total_token，0-1 小数）
//   data.usage.items[]      = 逐项（含 compensation_total_token 补偿积分）
//   data.monthUsage.percent = 本月总额度（month_total_token，0-1 小数）
// 一律换算成 0-100 百分比；映射为 pctRows（套餐 / 补偿 / 月总额），只输出存在的行。

/** 0-1 小数（或容错 0-100）→ 0-100 百分比数值（保留 1 位小数）。 */
function toPct01(v) {
  const n = Number(v);
  if (!isFinite(n) || n < 0) return null;
  if (n <= 1) return Math.round(n * 1000) / 10;
  if (n <= 100) return Math.round(n * 10) / 10;
  return null;
}

/** 在 items[] 里按 name 找某项的 percent。 */
function pickXiaomiItemPercent(items, itemName) {
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (item && item.name === itemName) return toPct01(item.percent);
  }
  return null;
}

function parseXiaomiResponse(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, kind: "parse", message: "MiMo 响应不是对象" };
  }
  const data = json.data;
  if (!data || typeof data !== "object") {
    return { ok: false, kind: "parse", message: "data 字段缺失（Cookie 可能已过期）" };
  }
  const usage = data.usage && typeof data.usage === "object" ? data.usage : {};
  const month = data.monthUsage && typeof data.monthUsage === "object" ? data.monthUsage : {};
  const planPct = toPct01(usage.percent);
  const compPct = pickXiaomiItemPercent(usage.items, "compensation_total_token");
  const monthPct = toPct01(month.percent);
  const rows = [];
  if (planPct !== null) rows.push({ label: "套餐", pct: planPct, tone: "green" });
  if (compPct !== null) rows.push({ label: "补偿", pct: compPct, tone: "plain" });
  if (monthPct !== null) rows.push({ label: "月总额", pct: monthPct, tone: "rainbow" });
  if (rows.length === 0) {
    return { ok: false, kind: "parse", message: "usage/monthUsage 没有可用的 percent（套餐可能已过期）" };
  }
  return {
    ok: true,
    provider: "xiaomi",
    display: { pctRows: rows },
  };
}

// ----- claude official parser (Musage claude_official.rs; api.anthropic.com/api/oauth/usage) -----
//   { "five_hour": { "utilization": 72.0, "resets_at": "2026-06-16T18:30:00.000Z" },
//     "seven_day": { "utilization": 45.0, "resets_at": "2026-06-19T03:00:00.000Z" } }
// utilization = 已用百分比 0-100（overage 可能超 100 → 夹取）。映射为 5h + 7d 双行。

/** ISO 8601 字符串或 epoch（秒/毫秒）→ 毫秒时间戳。 */
function parseIsoOrEpochMs(v) {
  if (typeof v === "number") {
    if (v >= 1e12 && v <= 4e12) return v;
    if (v > 1e9) return v * 1000;
    return null;
  }
  if (typeof v === "string" && v.length > 0) {
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  return null;
}

function parseClaudeResponse(body) {
  let json;
  try {
    json = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return { ok: false, kind: "parse", message: "JSON 解析失败" };
  }
  if (!json || typeof json !== "object") {
    return { ok: false, kind: "parse", message: "Claude 响应不是对象" };
  }
  const five = json.five_hour && typeof json.five_hour === "object" ? json.five_hour : null;
  const week = json.seven_day && typeof json.seven_day === "object" ? json.seven_day : null;
  if (!five && !week) {
    return { ok: false, kind: "parse", message: "five_hour / seven_day 都缺失（sessionKey 可能无效）" };
  }
  const utilOf = (w) => {
    if (!w) return null;
    const u = Number(w.utilization);
    if (!isFinite(u)) return null;
    return Math.max(0, Math.min(100, Math.round(u * 10) / 10));
  };
  const fivePct = utilOf(five);
  const weekPct = utilOf(week);
  if (fivePct === null && weekPct === null) {
    return { ok: false, kind: "parse", message: "utilization 字段缺失" };
  }
  return {
    ok: true,
    provider: "claude",
    display: {
      fiveHrPct: fivePct,
      weeklyPct: weekPct,
      fiveHrResetsIn: five && five.resets_at ? formatResetsIn(parseIsoOrEpochMs(five.resets_at)) : null,
      weeklyResetsIn: week && week.resets_at ? formatResetsIn(parseIsoOrEpochMs(week.resets_at)) : null,
    },
  };
}

function formatBalance(n, currency) {
  // 简洁显示: 数字 + currency 符号. 大数取整, 小数 2 位.
  const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : "";
  const text = (n >= 100) ? n.toFixed(0) : (n >= 10 ? n.toFixed(2) : n.toFixed(2));
  return symbol + text;
}

function formatResetsIn(resetsAtMs) {
  if (typeof resetsAtMs !== "number" || !resetsAtMs) return "";
  const ms = resetsAtMs - Date.now();
  if (ms <= 0) return " 即将重置";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return h + "h" + m + "m 重置";
  return m + "m 重置";
}

function classifyHttpStatus(status) {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth_failed";
  if (status >= 500) return "server_error";
  return "server_error";
}

function parseCurlOutput(rawText) {
  if (typeof rawText !== "string") return { body: "", statusCode: 0 };
  const lastNl = rawText.lastIndexOf("\n");
  if (lastNl < 0) return { body: rawText, statusCode: 0 };
  const body = rawText.slice(0, lastNl);
  const statusText = rawText.slice(lastNl + 1).trim();
  const statusCode = parseInt(statusText, 10);
  if (isNaN(statusCode)) return { body: rawText, statusCode: 0 };
  return { body, statusCode };
}

// ----- 路由信任检查 (同源 loopback 才放行, 形态抄自 modlens) -----

function isLoopbackHost(hostname) {
  if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname);
  return !!m && Number(m[1]) === 127;
}

function isTrustedRequest(req) {
  const host = req.headers && req.headers.host;
  if (typeof host !== "string" || host === "") return false;
  let hostUrl;
  try {
    hostUrl = new URL("http://" + host);
  } catch {
    return false;
  }
  if (!isLoopbackHost(hostUrl.hostname)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

/** PROVIDERS 表测试出口（node:test 断言 refs / 鉴权分派；不参与 cordis 装配）。 */
export const __providers = PROVIDERS;

/** 纯解析函数测试出口（node:test 直接调用；不参与 cordis 装配）。 */
export const __parsers = {
  minimax: parseMinimaxResponse,
  deepseek: parseDeepseekBalance,
  kimi: parseKimiResponse,
  openrouter: parseOpenrouterResponse,
  zhipu: parseZhipuResponse,
  stepfun: parseStepfunResponse,
  siliconflow: parseSiliconflowResponse,
  tavily: parseTavilyResponse,
  zenmux: parseZenmuxResponse,
  xiaomi: parseXiaomiResponse,
  claude: parseClaudeResponse,
};

export function apply(ctx) {
  // 每个 provider 一份 cache. key: provider 名.
  const cache = Object.create(null);
  const activeRef = Object.create(null);
  let curlPath = null;

  async function loadApiKey(provider) {
    const cfg = PROVIDERS[provider];
    if (!cfg) return { ref: null, key: null };
    const credentials = ctx.credentials;
    if (!credentials) return { ref: null, key: null };
    if (activeRef[provider]) {
      const hit = await credentials.resolve(activeRef[provider]);
      if (hit && hit.value) return { ref: activeRef[provider], key: hit.value };
    }
    for (const ref of cfg.refs) {
      try {
        const hit = await credentials.resolve(ref);
        if (hit && hit.value) {
          activeRef[provider] = ref;
          return { ref, key: hit.value };
        }
      } catch (e) {}
    }
    return { ref: null, key: null };
  }

  async function resolveCurl() {
    if (curlPath) return curlPath;
    const subprocess = ctx.subprocess;
    if (!subprocess) {
      console.error("[musage] subprocess service 不可用 (inject 未生效)");
      throw new Error("subprocess service 不可用");
    }
    try {
      curlPath = await subprocess.resolveExecutable("curl");
      console.log("[musage] resolveExecutable('curl') -> " + curlPath);
    } catch (e) {
      console.error("[musage] resolveExecutable('curl') 失败: " + ((e && e.stack) || e));
      throw new Error("找不到 curl: " + ((e && e.message) || String(e)));
    }
    return curlPath;
  }

  async function curlFetch(url, key, authStyle) {
    const subprocess = ctx.subprocess;
    if (!subprocess) throw new Error("subprocess service 不可用");
    const c = await resolveCurl();
    // authStyle 分派 (2026-10 扩展):
    //   raw    (zhipu)  → Authorization: <key>（不加 Bearer 前缀, 来自 Musage zhipu.rs 注释）
    //   cookie (xiaomi) → Cookie: <整段 Cookie header 值>
    //   claude (claude) → Cookie: sessionKey=<key> + Anthropic-Beta + claude-code UA
    //   其它            → Authorization: Bearer <key>
    let authArgs;
    if (authStyle === "raw") {
      authArgs = ["-H", "Authorization: " + key];
    } else if (authStyle === "cookie") {
      authArgs = ["-H", "Cookie: " + key];
    } else if (authStyle === "claude") {
      authArgs = [
        "-H", "Cookie: sessionKey=" + key,
        "-H", "Anthropic-Beta: oauth-2025-04-20",
        "-H", "User-Agent: claude-code/2.1.0",
      ];
    } else {
      authArgs = ["-H", "Authorization: Bearer " + key];
    }
    let handle;
    try {
      handle = subprocess.spawn({
        argv: [
          c, "-sS",
          "--max-time", String(Math.floor(REQUEST_TIMEOUT_MS / 1000)),
          "-w", "\n%{http_code}",
          ...authArgs,
          "-H", "Accept: application/json",
          url,
        ],
        cwd: "/",
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: 8 * 1024 * 1024 },
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: REQUEST_TIMEOUT_MS,
      });
      console.log("[musage] [" + url + "] spawn OK pid=" + handle.pid);
    } catch (e) {
      console.error("[musage] spawn 抛异常: " + ((e && e.stack) || e));
      throw e;
    }
    let outcome;
    try {
      outcome = await handle.done;
      console.log("[musage] [" + url + "] done exitCode=" + outcome.exitCode + " signal=" + outcome.signal);
    } catch (e) {
      console.error("[musage] await done 抛异常: " + ((e && e.stack) || e));
      throw e;
    }
    const stdout = handle.collected && handle.collected.stdout
      ? handle.collected.stdout.readFrom(0)
      : { text: "", nextOffset: 0, lossy: false };
    const stderr = handle.collected && handle.collected.stderr
      ? handle.collected.stderr.readFrom(0)
      : { text: "", nextOffset: 0, lossy: false };
    console.log("[musage] [" + url + "] stdout.len=" + stdout.text.length + " stderr.len=" + stderr.text.length);
    if (outcome.exitCode !== 0) {
      return {
        ok: false,
        kind: "network",
        message: "curl 退出 " + outcome.exitCode + " · " + stderr.text.slice(0, 200),
      };
    }
    const { body, statusCode } = parseCurlOutput(stdout.text);
    console.log("[musage] [" + url + "] statusCode=" + statusCode + " body.len=" + body.length);
    if (statusCode === 0) {
      return { ok: false, kind: "network", message: "curl 输出没拿到 HTTP 状态: " + stdout.text.slice(0, 200) };
    }
    if (statusCode !== 200) {
      return {
        ok: false,
        kind: classifyHttpStatus(statusCode),
        httpStatus: statusCode,
        message: "HTTP " + statusCode + " · " + body.slice(0, 200),
      };
    }
    return { ok: true, body };
  }

  async function fetchProviderQuota(provider) {
    const cfg = PROVIDERS[provider];
    if (!cfg) {
      return { ok: false, kind: "other", message: "未知 provider: " + provider };
    }
    const { ref, key } = await loadApiKey(provider);
    if (!key) {
      return {
        ok: false,
        kind: "unconfigured",
        message: "未配置 " + provider + " API Key (在 DSH 模型设置里配置对应 provider)",
      };
    }
    const url = cfg.urls[ref] || cfg.urls[cfg.refs[0]];
    // 鉴权形态按命中的 ref 分派（authStyleByRef）；未列出时用 authStyle 兜底。
    const style = (cfg.authStyleByRef && cfg.authStyleByRef[ref]) || cfg.authStyle;
    let raw;
    try {
      raw = await curlFetch(url, key, style);
      if (!raw.ok) return raw;
    } catch (e) {
      return { ok: false, kind: "network", message: "fetch 异常: " + ((e && e.message) || String(e)) };
    }
    const parsed = cfg.parse(raw.body);
    console.log("[musage] [" + provider + "] parsed.ok=" + parsed.ok + " display=" + (parsed.ok ? JSON.stringify(parsed.display) : "") + " err=" + (parsed.ok ? "" : parsed.message));
    if (parsed.ok) {
      parsed.url = url;
      parsed.ref = ref;
    }
    return parsed;
  }

  async function getQuota(provider) {
    const c = cache[provider];
    if (c && c.expiresAt > nowMs()) return c.value;
    const result = await fetchProviderQuota(provider);
    if (result.ok) {
      cache[provider] = { value: result, expiresAt: nowMs() + CACHE_TTL_MS, streak: 0 };
    } else {
      const prev = c ? c.streak : 0;
      const nextStreak = prev + 1;
      const backoffMs = computeBackoffMs(nextStreak);
      cache[provider] = { value: result, expiresAt: nowMs() + backoffMs, streak: nextStreak };
    }
    return result;
  }

  // 后台轮询: 60s 拉一次每个已知 provider (预热缓存)
  const disposeTimer = ctx.timer.interval(async () => {
    for (const provider of Object.keys(PROVIDERS)) {
      try {
        await getQuota(provider);
      } catch (e) {}
    }
  }, POLL_INTERVAL_MS);
  // 立即尝一次
  ctx.timer.timeout(() => {
    for (const provider of Object.keys(PROVIDERS)) {
      getQuota(provider);
    }
  }, 100);

  // Client 入口: webServer 路由 (web profile 下存在; headless 部署没有该
  // service, scoped ctx.inject 保证只在它出现时挂载, 其余环境零副作用).
  // GET /musage/quota?provider=<p>&force=1 → 200 + result JSON
  // (result 与旧 harness.handle('quota:fetch') 返回的同一个对象).
  if (typeof ctx.inject === "function") {
    ctx.inject(["webServer"], (scope) => {
      try {
        scope.webServer.register({
          name: "musage-quota",
          kind: "exact",
          path: "/musage/quota",
          handler: async (req, res) => {
            const send = (status, body) => {
              res.writeHead(status, { "content-type": "application/json" });
              res.end(JSON.stringify(body));
            };
            try {
              if (!isTrustedRequest(req)) {
                send(403, { ok: false, kind: "forbidden", message: "request refused: same-origin loopback only" });
                return;
              }
              if (req.method !== "GET") {
                send(405, { ok: false, kind: "other", message: "method not allowed" });
                return;
              }
              const params = new URL(req.url, "http://localhost").searchParams;
              const provider = params.get("provider") || "minimax";
              const forceRefresh = params.get("force") === "1";
              if (!PROVIDERS[provider]) {
                send(404, { ok: false, kind: "other", message: "未知 provider: " + provider });
                return;
              }
              if (forceRefresh) cache[provider] = null;
              send(200, await getQuota(provider));
            } catch (e) {
              send(200, { ok: false, kind: "other", message: String((e && e.message) || e) });
            }
          },
        });
        console.log("[musage] route GET /musage/quota registered");
      } catch (e) {
        console.error("[musage] quota 路由注册失败: " + ((e && e.stack) || e));
      }
    });
  }

  ctx.effect(() => {
    return () => {
      try { disposeTimer(); } catch (e) {}
      for (const k of Object.keys(cache)) cache[k] = null;
    };
  });
}
