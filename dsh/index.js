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

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
    // Bearer 被 dashboard 拒（实机 401 + loginUrl）时自动退 Cookie 重试一次
    // （对齐 Musage xiaomi.rs 的 BearerThenCookie 语义）。
    fallbackAuth: {
      refs: ["XIAOMI_MIMO_COOKIE", "XIAOMI_COOKIE", "MIMO_COOKIE"],
      style: "cookie",
    },
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

// ============================================================
// 登录助手注册表 (login-assist)
// ============================================================
// 需要浏览器登录态 (cookie 型凭据) 的 provider 的自动登录支持:
//   点击卡片(失败态) → 宿主弹专用浏览器到官方登录页 → 用户在真实页面登录
//   → 宿主经 DevTools 协议读 cookie (含 HttpOnly) → 试调用量 API 自证
//   → credentials.set 写入 → 关窗。
// 仅这两家; 其余 9 家是 API key 型 (复用 DSH 模型设置), 无登录痛点。
//
// 字段:
//   - ref:           写入的 credentials ref (必须在 PROVIDERS[p].refs 内)
//   - loginUrl:      浏览器窗口打开的登录页
//   - siteUrl:       CDP Network.getCookies 的 urls 参数 (读该 URL 可见的 cookie)
//   - markerCookies: 登录成功的标志 cookie 名 (出现且值非空才进入 API 试调)
//   - extract:       "all" = 全量拼接为完整 Cookie header;
//                    "name:<cookie名>" = 只取该 cookie 的值
const LOGIN_ASSIST = {
  xiaomi: {
    ref: "XIAOMI_MIMO_COOKIE",
    // 直达控制台页: 未登录会自动跳转小米账号 SSO 登录页（2026-10-01 实机验证）。
    // 不要用根域 —— 根域是营销页, 用户找不到登录入口。
    loginUrl: "https://platform.xiaomimimo.com/console/balance",
    siteUrl: "https://platform.xiaomimimo.com/",
    markerCookies: ["api-platform_serviceToken"],
    extract: "all",
  },
  claude: {
    ref: "CLAUDE_SESSION_KEY",
    loginUrl: "https://claude.ai/login",
    siteUrl: "https://claude.ai/",
    markerCookies: ["sessionKey"],
    extract: "name:sessionKey",
  },
  stepfun: {
    ref: "STEPFUN_COOKIE",
    // StepFun 账号域登录页, redirect 带回 account-overview（登录后回跳）。2026-10-01 实机探测。
    loginUrl: "https://account.stepfun.com/login?redirect=%2F%3FreturnTo%3Dhttps%253A%252F%252Fplatform.stepfun.com%252Faccount-overview",
    siteUrl: "https://platform.stepfun.com/",
    markerCookies: ["Oasis-Token"],
    extract: "all",
    // 跨域换票（2026-10-01 联调实测）: 登录态先落在 account 域; 目标域出现凭证前,
    // 若经 via.urls 检测到账号域已有凭证, 导航 via.returnUrl 完成换票
    // （platform 域获得自己的 Oasis-Token 后, 原有轮询即可接手）。
    via: {
      urls: ["https://account.stepfun.com/"],
      returnUrl: "https://account.stepfun.com/?returnTo=" + encodeURIComponent("https://platform.stepfun.com/account-overview"),
    },
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
  // 套餐(plan_total)与月总额(month_total)为同一额度的两种口径, 观感重复 ——
  // 2026-10-01 用户指定合并为一行「月总额」（优先月总额值, 缺失时套餐值兜底）。
  // 无 5h 窗口的长周期额度统一走紫色流动条（tone: "rainbow"）。
  const mergedPct = monthPct !== null ? monthPct : planPct;
  if (mergedPct !== null) rows.push({ label: "月总额", pct: mergedPct, tone: "rainbow" });
  if (compPct !== null) rows.push({ label: "补偿", pct: compPct, tone: "plain" });
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

/**
 * 首次请求失败时选择兜底鉴权（纯函数；fetchProviderQuota 与测试共用）。
 * 仅当响应为 401（凭据被拒）且 provider 配置了 fallbackAuth 时触发。
 * @param cfg - PROVIDERS[provider] 条目
 * @param firstRaw - 首次 curlFetch 的结果
 * @returns fallbackAuth 配置对象（{refs, style}），或 null
 */
export function pickFallbackAuth(cfg, firstRaw) {
  if (!cfg || !cfg.fallbackAuth) return null;
  if (!firstRaw || firstRaw.ok) return null;
  if (firstRaw.httpStatus !== 401) return null;
  return cfg.fallbackAuth;
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

// ============================================================
// 登录助手: 纯函数层
// ============================================================
// 本层只做无 IO 的数据变换 (cookie 拼接/提取/标志判定/浏览器候选/状态快照),
// 供单测直测 (tests/login-assist.test.mjs); IO 与流程在 CDP 客户端与会话层。

/** 拼 CDP Network.getCookies 的 cookie 数组为完整 Cookie header 值。
 *  跳过 name 空/非字符串与 value 非字符串的条目; 空串值保留 (k=)。 */
function joinCookieHeader(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return null;
  const parts = [];
  for (const c of cookies) {
    if (!c || typeof c.name !== "string" || c.name.length === 0) continue;
    if (typeof c.value !== "string") continue;
    parts.push(c.name + "=" + c.value);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

/** 从 Cookie header 值里提取单个 cookie 值 (找不到 → null)。
 *  StepFun 的 Oasis 请求头需要从 cookie 里取 Oasis-Token / WebID 两个值。 */
function pickCookieValue(cookieHeader, name) {
  if (typeof cookieHeader !== "string" || cookieHeader.length === 0) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** 解析 StepFun QueryAccountBalance 的 Connect-JSON 响应 (camelCase)。
 *  实机（2026-10-01）响应值是**字符串分**: voucher "596" = ¥5.96；
 *  金额字段统一按分 → 元转换（保留 2 位）；credit 保留原值（数量语义）。
 *  无任何可用字段 → null。 */
/** 宽容数字解析: number 或数字字符串 → number; 其余 → null。 */
function toNum(v) {
  if (typeof v === "number" && isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (isFinite(n)) return n;
  }
  return null;
}

/** 分 → 元（StepFun 金额字段单位为分）。 */
function toMoney(v) {
  const n = toNum(v);
  return n === null ? null : Math.round(n) / 100;
}

function parseStepfunOasis(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const num = toNum;
  const money = toMoney;
  // 实机响应用 snake_case（cost_yesterday 等）; 兼容 Connect 默认 camelCase。
  const pick = (snake, camel) => (json[snake] !== undefined ? json[snake] : json[camel]);
  const out = {
    credit: num(json.credit),
    voucher: money(json.voucher),
    voucherApi: money(pick("voucher_api", "voucherApi")),
    voucherPlan: money(pick("voucher_plan", "voucherPlan")),
    payment: money(json.payment),
    balance: money(json.balance),
    costYesterday: money(pick("cost_yesterday", "costYesterday")),
    costMonth: money(pick("cost_month", "costMonth")),
    costTotal: money(pick("cost_total", "costTotal")),
    voucherExpireTime: num(pick("voucher_expire_time", "voucherExpireTime")),
  };
  if (out.credit === null && out.balance === null && out.voucherPlan === null && out.voucher === null) return null;
  return out;
}

/** 解析 StepFun QueryStepPlanRateLimit（coding plan 额度, snake_case）。
 *  实机（2026-10-01）: plan_credit_rate_limit.subscription_credit_left_rate = 剩余率（0-1）,
 *  credit_buckets[0] = { credit_total, credit_residual, next_reset_at, expire_at }（unix 秒）。 */
function parseStepfunPlanRateLimit(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const pcl = json.plan_credit_rate_limit;
  if (!pcl || typeof pcl !== "object" || Array.isArray(pcl)) return null;
  const buckets = Array.isArray(pcl.credit_buckets) ? pcl.credit_buckets : [];
  const b = (buckets[0] && typeof buckets[0] === "object") ? buckets[0] : {};
  const leftRate = toNum(pcl.subscription_credit_left_rate);
  const total = toNum(b.credit_total);
  if (leftRate === null && total === null) return null;
  return {
    creditLeftRate: leftRate,                                  // 0-1
    creditResetAt: toNum(pcl.subscription_credit_reset_time),  // unix 秒
    topupLeftRate: toNum(pcl.topup_credit_left_rate),
    creditTotal: total,
    creditResidual: toNum(b.credit_residual),
    creditExpireAt: toNum(b.expire_at),
    planFamily: toNum(json.plan_family),
  };
}

/** 解析 StepFun GetStepPlanStatus（订阅信息, snake_case）。 */
function parseStepfunPlanStatus(json) {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const sub = json.subscription;
  if (!sub || typeof sub !== "object" || Array.isArray(sub)) return null;
  return {
    name: (typeof sub.name === "string" && sub.name.length > 0) ? sub.name : null,
    active: toNum(sub.status) === 1,
    expiredAt: toNum(sub.expired_at),   // unix 秒
    autoRenew: sub.auto_renew === true,
  };
}

/** 按 LOGIN_ASSIST[provider].extract 规则提取要写入 ref 的值。 */
function extractLoginCookie(provider, cookies) {
  const cfg = LOGIN_ASSIST[provider];
  if (!cfg) return null;
  if (cfg.extract === "all") return joinCookieHeader(cookies);
  if (typeof cfg.extract === "string" && cfg.extract.indexOf("name:") === 0) {
    const want = cfg.extract.slice("name:".length);
    if (!Array.isArray(cookies)) return null;
    for (const c of cookies) {
      if (c && c.name === want && typeof c.value === "string" && c.value.length > 0) {
        return c.value;
      }
    }
    return null;
  }
  return null;
}

/** 登录标志 cookie 是否已出现 (值非空才算)。 */
function hasLoginMarker(provider, cookies) {
  const cfg = LOGIN_ASSIST[provider];
  if (!cfg || !Array.isArray(cookies)) return false;
  for (const c of cookies) {
    if (!c || typeof c.value !== "string" || c.value.length === 0) continue;
    if (cfg.markerCookies.indexOf(c.name) >= 0) return true;
  }
  return false;
}

/** Windows 浏览器可执行候选路径 (按优先级)。 */
function browserCandidates(env) {
  const list = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];
  const localAppData = env && env.LOCALAPPDATA;
  if (typeof localAppData === "string" && localAppData.length > 0) {
    list.push(localAppData + "\\Google\\Chrome\\Application\\chrome.exe");
  }
  return list;
}

/** 过滤出实际存在的浏览器可执行文件 (保优先级顺序)。非 win32 → 空。 */
function pickBrowserCandidates(platform, exists, env) {
  if (platform !== "win32") return [];
  const existsFn = typeof exists === "function"
    ? exists
    : function (p) { try { return existsSync(p); } catch (e) { return false; } };
  return browserCandidates(env || {}).filter(function (p) {
    try { return !!existsFn(p); } catch (e) { return false; }
  });
}

/** 进行中 (active) 的会话状态; 其余为终结态。 */
const LOGIN_ACTIVE_STATES = ["starting", "waiting"];

/** 把内部登录会话对象映射为对外状态快照 (不泄露 ws/pid/profileDir 等内部字段)。 */
function loginStatusSnapshot(session) {
  if (!session) return { active: false, state: "idle" };
  return {
    active: LOGIN_ACTIVE_STATES.indexOf(session.state) >= 0,
    state: session.state,
    provider: session.provider || null,
    message: session.message || null,
    startedAt: session.startedAt || null,
  };
}

// ============================================================
// 登录助手: CDP 客户端 (DevTools 协议最小封装)
// ============================================================
// 只做四件事: 等浏览器写出的 DevToolsActivePort、列 targets、一问一答式
// ws 调用 (Network.getCookies)、Browser.close。不订阅 CDP 事件。
// 依赖运行时的全局 WebSocket 与 fetch (Electron 44 / Node >= 22 内置);
// 缺失时由 startLoginSession 自检拒绝, 不在这里兜底。

function sleepMs(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/** 轮询 DevToolsActivePort 文件 (浏览器写入 "<port>\n<browser-ws-path>"), 返回端口。 */
async function readDevToolsPort(profileDir, timeoutMs) {
  const file = join(profileDir, "DevToolsActivePort");
  const deadline = nowMs() + timeoutMs;
  for (;;) {
    try {
      const text = readFileSync(file, "utf8");
      const port = parseInt(String(text).split(/\r?\n/)[0], 10);
      if (port > 0) return port;
    } catch (e) { /* 文件还没出现 */ }
    if (nowMs() > deadline) throw new Error("等待 DevToolsActivePort 超时（浏览器未就绪）");
    await sleepMs(250);
  }
}

/** 连接一个 CDP WebSocket, 等 open。 */
function cdpOpenWs(url, timeoutMs) {
  return new Promise(function (resolve, reject) {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
    const timer = setTimeout(function () {
      try { ws.close(); } catch (e) {}
      reject(new Error("CDP ws 连接超时"));
    }, timeoutMs);
    ws.onopen = function () { clearTimeout(timer); resolve(ws); };
    ws.onerror = function () { clearTimeout(timer); reject(new Error("CDP ws 连接失败")); };
  });
}

/** 把已 open 的 ws 包成一问一答会话 (id 匹配; 不处理 CDP 事件)。 */
function cdpSession(ws) {
  let seq = 0;
  const pending = new Map();
  ws.onmessage = function (ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg && msg.id && pending.has(msg.id)) {
      const slot = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(slot.timer);
      if (msg.error) reject2(slot.reject, new Error("CDP " + (msg.error.message || JSON.stringify(msg.error))));
      else slot.resolve(msg.result);
    }
  };
  function reject2(rej, err) { rej(err); }
  return {
    call: function (method, params, timeoutMs) {
      return new Promise(function (resolve, reject) {
        const id = ++seq;
        const timer = setTimeout(function () {
          pending.delete(id);
          reject(new Error("CDP 调用超时: " + method));
        }, timeoutMs || 10000);
        pending.set(id, { resolve: resolve, reject: reject, timer: timer });
        ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
      });
    },
    close: function () { try { ws.close(); } catch (e) {} },
  };
}

/** HTTP /json/list: 列出 targets。 */
async function cdpListTargets(port) {
  const res = await fetch("http://127.0.0.1:" + port + "/json/list");
  if (!res.ok) throw new Error("CDP /json/list HTTP " + res.status);
  return res.json();
}

/** HTTP /json/version: 取 browser 级 ws url (Browser.close 用)。 */
async function cdpBrowserWsUrl(port) {
  const res = await fetch("http://127.0.0.1:" + port + "/json/version");
  if (!res.ok) throw new Error("CDP /json/version HTTP " + res.status);
  const json = await res.json();
  return (json && json.webSocketDebuggerUrl) || null;
}

/** 从 target 列表挑第一个 page 的 ws url。 */
function pickPageWsUrl(targets) {
  if (!Array.isArray(targets)) return null;
  for (const t of targets) {
    if (t && t.type === "page" && t.webSocketDebuggerUrl) return t.webSocketDebuggerUrl;
  }
  return null;
}

/** CDP 读 cookie (含 HttpOnly —— 普通页面脚本拿不到的那部分)。 */
async function cdpGetCookies(sess, urls) {
  const result = await sess.call("Network.getCookies", { urls: urls });
  return (result && Array.isArray(result.cookies)) ? result.cookies : [];
}

/** CDP 导航页面并按短延时等待提交（StepFun 跨域换票等场景用）。 */
async function cdpNavigate(sess, url, waitMs) {
  try { await sess.call("Page.navigate", { url: url }, 8000); } catch (e) { /* 导航断连在预期内 */ }
  await sleepMs(waitMs || 2500);
}

/** 解析登录路由输入 (method/action/provider 归一), 返回 { ok, op }。 */
function parseLoginRequest(input) {
  const method = String((input && input.method) || "GET").toUpperCase();
  if (method === "GET") return { ok: true, op: "status" };
  if (method !== "POST") return { ok: false, message: "method not allowed" };
  const action = String((input && input.action) || "start").toLowerCase();
  if (action === "cancel") return { ok: true, op: "cancel" };
  if (action === "start") {
    const provider = String((input && input.provider) || "");
    if (!provider) return { ok: false, message: "缺少 provider 参数" };
    if (!LOGIN_ASSIST[provider]) return { ok: false, message: "该 provider 不支持自动登录: " + provider };
    return { ok: true, op: "start", provider: provider };
  }
  return { ok: false, message: "未知 action: " + action };
}

/** 读取请求 body 并 JSON.parse (限长; 空 body → null)。 */
function readJsonBody(req, maxBytes) {
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on("data", function (c) {
      size += c.length;
      if (size > (maxBytes || 64 * 1024)) {
        reject(new Error("body too large"));
        try { req.destroy(); } catch (e) {}
        return;
      }
      chunks.push(c);
    });
    req.on("end", function () {
      if (chunks.length === 0) { resolve(null); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(e); }
    });
    req.on("error", function (e) { reject(e); });
  });
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

/** 登录助手纯函数测试出口（node:test 直接调用；不参与 cordis 装配）。 */
export const __login = {
  LOGIN_ASSIST,
  joinCookieHeader,
  extractLoginCookie,
  hasLoginMarker,
  pickBrowserCandidates,
  browserCandidates,
  pickCookieValue,
  parseStepfunOasis,
  parseStepfunPlanRateLimit,
  parseStepfunPlanStatus,
  loginStatusSnapshot,
  parseLoginRequest,
  readJsonBody,
  // CDP 客户端（cdp-integration.test.mjs 用真实 headless 浏览器直测；
  // 生产编排在 apply() 内的登录会话里）。
  cdp: {
    readDevToolsPort,
    cdpOpenWs,
    cdpSession,
    cdpListTargets,
    cdpBrowserWsUrl,
    pickPageWsUrl,
    cdpGetCookies,
  },
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

  async function curlFetch(url, key, authStyle, opts) {
    const subprocess = ctx.subprocess;
    if (!subprocess) throw new Error("subprocess service 不可用");
    const c = await resolveCurl();
    // authStyle 分派 (2026-10 扩展):
    //   raw    (zhipu)  → Authorization: <key>（不加 Bearer 前缀, 来自 Musage zhipu.rs 注释）
    //   cookie (xiaomi) → Cookie: <整段 Cookie header 值>
    //   claude (claude) → Cookie: sessionKey=<key> + Anthropic-Beta + claude-code UA
    //   oasis  (stepfun)→ Cookie: <整段 Cookie header 值> + 从 cookie 提取并转发的
    //                      Oasis-Token / Oasis-Webid 请求头（对齐官网前端做法）
    //   其它            → Authorization: Bearer <key>
    // opts (可选, 2026-10): { method?: "POST", headers?: ["K: V", ...], body?: "<JSON>" }
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
    } else if (authStyle === "oasis") {
      // StepFun 网页登录态（2026-10-01 实机配方, 401→200 探针全实证）:
      //   Cookie（含 Oasis-Token, 服务端从 cookie 取）
      //   + Oasis-Webid: <cookie "Oasis-Webid" 同值>
      //   + Oasis-AppID: 10300 + Oasis-Platform: web（缺 → 401 oasis-token is embezzled）
      const oasisWebid = pickCookieValue(key, "Oasis-Webid");
      authArgs = ["-H", "Cookie: " + key];
      if (oasisWebid) authArgs.push("-H", "Oasis-Webid: " + oasisWebid);
      authArgs.push("-H", "Oasis-AppID: 10300");
      authArgs.push("-H", "Oasis-Platform: web");
    } else {
      authArgs = ["-H", "Authorization: Bearer " + key];
    }
    const optArgs = [];
    if (opts && opts.method) optArgs.push("-X", String(opts.method));
    if (opts && Array.isArray(opts.headers)) {
      for (const h of opts.headers) optArgs.push("-H", h);
    }
    if (opts && typeof opts.body === "string") optArgs.push("-d", opts.body);
    let handle;
    try {
      handle = subprocess.spawn({
        argv: [
          c, "-sS",
          "--max-time", String(Math.floor(REQUEST_TIMEOUT_MS / 1000)),
          "-w", "\n%{http_code}",
          ...authArgs,
          ...optArgs,
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
      if (!raw.ok) {
        // 401（凭据被拒）→ 按 fallbackAuth 退用 Cookie 重试一次
        // （对齐 Musage xiaomi.rs 的 BearerThenCookie：Token Plan key 会被
        //  dashboard 端点 401 拒绝，浏览器登录态 Cookie 才是正路）。
        const fb = pickFallbackAuth(cfg, raw);
        if (fb && Array.isArray(fb.refs)) {
          const credentials = ctx.credentials;
          for (const fbRef of fb.refs) {
            let hit = null;
            try { hit = credentials ? await credentials.resolve(fbRef) : null; } catch (e) {}
            if (hit && hit.value) {
              raw = await curlFetch(cfg.urls[fbRef] || url, hit.value, fb.style || "cookie");
              if (raw.ok) break;
            }
          }
        }
        if (!raw.ok) {
          // 401 且兜底也无凭据：返回可操作指引（卡片 note 会显示）。
          if (raw.httpStatus === 401 && cfg.fallbackAuth) {
            return {
              ok: false,
              kind: "auth_failed",
              httpStatus: 401,
              message: "HTTP 401：需要浏览器登录态 Cookie —— 请将 platform.xiaomimimo.com 的完整 Cookie header 值存入 ref XIAOMI_MIMO_COOKIE（见 README「凭据」一节）",
            };
          }
          return raw;
        }
      }
    } catch (e) {
      return { ok: false, kind: "network", message: "fetch 异常: " + ((e && e.message) || String(e)) };
    }
    const parsed = cfg.parse(raw.body);
    console.log("[musage] [" + provider + "] parsed.ok=" + parsed.ok + " display=" + (parsed.ok ? JSON.stringify(parsed.display) : "") + " err=" + (parsed.ok ? "" : parsed.message));
    if (parsed.ok) {
      parsed.url = url;
      parsed.ref = ref;
      // stepfun: 若已存网页登录态（登录助手写入 STEPFUN_COOKIE）, 附加账户
      // 总览（Step Plan / Credit 等）——account-overview 同源接口。
      // 失败静默（不阻塞余额显示）; 是否给「点击登录」入口由 withLoginAssist 决定。
      if (provider === "stepfun") {
        try {
          const hit = await ctx.credentials.resolve("STEPFUN_COOKIE");
          if (hit && hit.value) {
            // 并行: 账户总览 + coding plan（Step Plan 额度/订阅, 两条 RPC）
            const [oasis, plan] = await Promise.all([
              probeStepfunOasis(hit.value),
              fetchStepfunPlan(hit.value),
            ]);
            if (oasis.ok && oasis.data) parsed.display.oasis = oasis.data;
            if (plan) {
              const p = {};
              if (plan.status) {
                p.name = plan.status.name;
                p.active = plan.status.active;
                p.autoRenew = plan.status.autoRenew;
                if (plan.status.expiredAt) p.expiredIn = formatResetsIn(plan.status.expiredAt * 1000);
              }
              if (plan.rate) {
                p.creditLeftRate = plan.rate.creditLeftRate;
                p.creditTotal = plan.rate.creditTotal;
                p.creditResidual = plan.rate.creditResidual;
                if (plan.rate.creditResetAt) p.creditResetIn = formatResetsIn(plan.rate.creditResetAt * 1000);
              }
              parsed.display.stepfunPlan = p;
            }
          }
        } catch (e) { /* stepfun 附加数据失败不影响主结果 */ }
      }
    }
    return parsed;
  }

  async function getQuota(provider) {
    const c = cache[provider];
    if (c && c.expiresAt > nowMs()) return c.value;
    const result = withLoginAssist(provider, await fetchProviderQuota(provider));
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

  // ============================================================
  // 登录助手: 会话编排 (单例)
  // ============================================================
  // 流程: 点卡片(失败态) → start → spawn 专用浏览器(CDP 随机端口 + 专用
  //   profile) → 用户在真实登录页登录 → 轮询 Network.getCookies（含 HttpOnly）
  //   → 试调用量 API 自证 → credentials.set 写入 → 优雅关窗。
  // 状态机: starting → waiting → success | failed | cancelled | timeout。
  // 同一时刻至多一个会话; 终结态快照保留到下一次 start 覆盖。

  const LOGIN_POLL_MS = 2_000;           // cookie 轮询间隔
  const LOGIN_PROBE_MIN_MS = 3_000;      // API 试调最小间隔 (marker 出现后)
  const LOGIN_READY_TIMEOUT_MS = 30_000; // 等 DevToolsActivePort 的上限
  const LOGIN_MAX_MS = 30 * 60 * 1000;   // 单次会话硬上限

  let loginSession = null;

  function loginAssistInfo(provider) {
    const cfg = LOGIN_ASSIST[provider];
    if (!cfg) return { supported: false };
    return { supported: true, ref: cfg.ref };
  }

  /** 登录助手附着（client 据此在卡片上给出「点击登录」入口）。
   *  - 失败态: 所有支持登录的 provider 都附着;
   *  - stepfun 成功态: 有余额但缺网页登录态数据（oasis 缺）时也附着
   *    （引导「点击卡片登录读取 Step Plan Credit」）。 */
  function withLoginAssist(provider, result) {
    if (!result) return result;
    const info = loginAssistInfo(provider);
    if (!info.supported) return result;
    if (!result.ok) {
      result.loginAssist = { supported: true, ref: info.ref };
      return result;
    }
    if (provider === "stepfun" && result.display && !result.display.oasis) {
      result.loginAssist = { supported: true, ref: info.ref };
    }
    return result;
  }

  function finishLoginSession(sess, state, message) {
    if (sess !== loginSession) return;
    sess.state = state;
    sess.message = message || null;
    sess.finishedAt = nowMs();
    // 释放重引用（ws/handle 已关闭或即将关闭；快照继续可供 status 查询）
    sess.sess = null;
    sess.handle = null;
  }

  /** 尽量优雅地关闭会话的浏览器: CDP Browser.close → terminate 兜底。 */
  async function closeBrowserForSession(sess) {
    const handle = sess && sess.handle;
    const browserWsUrl = sess && sess.browserWsUrl;
    if (sess && sess.sess) { try { sess.sess.close(); } catch (e) {} sess.sess = null; }
    if (browserWsUrl && typeof WebSocket === "function") {
      try {
        const ws = await cdpOpenWs(browserWsUrl, 3000);
        ws.send(JSON.stringify({ id: 1, method: "Browser.close", params: {} }));
        await sleepMs(800);
        try { ws.close(); } catch (e) { /* 浏览器已在退出 */ }
      } catch (e) { /* 落回 terminate */ }
    }
    if (handle) {
      try {
        const p = handle.terminate();
        if (p && typeof p.catch === "function") p.catch(function () {});
      } catch (e) {}
      try { await Promise.race([handle.waitForExit(), sleepMs(5000)]); } catch (e) {}
    }
  }

  /** StepFun 账户总览（官网 account-overview 同源接口）:
   *  POST Connect-JSON QueryAccountBalance, 认证 = 整段 cookie + Oasis 头。
   *  用途: 登录试调自证 + 卡片附加 Step Plan/Credit 数据。
   *  2026-10-01 实测: 未认证返回 401 {"code":"unauthenticated"}（协议形状为此固化）。 */
  const STEPFUN_OASIS_URL = "https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryAccountBalance";
  async function probeStepfunOasis(cookieHeader) {
    let raw;
    try {
      raw = await curlFetch(STEPFUN_OASIS_URL, cookieHeader, "oasis", {
        method: "POST",
        headers: ["Content-Type: application/json", "Connect-Protocol-Version: 1"],
        body: '{"bizType":1}',
      });
    } catch (e) {
      return { ok: false, message: "试调异常: " + ((e && e.message) || String(e)) };
    }
    if (!raw.ok) return { ok: false, message: raw.message, httpStatus: raw.httpStatus || 0 };
    let json = null;
    try { json = JSON.parse(raw.body); } catch (e) {}
    const data = parseStepfunOasis(json);
    if (!data) return { ok: false, message: "账户总览响应无可用字段: " + String(raw.body).slice(0, 120) };
    return { ok: true, data: data };
  }

  /** StepFun coding plan（Step Plan）额度 + 订阅 —— account-overview 同源两条 RPC
   *  （2026-10-01 实机实证; 同一 oasis 认证配方）。任一失败给部分/ null, 静默。 */
  const STEPFUN_PLAN_URL = "https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit";
  const STEPFUN_STATUS_URL = "https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus";
  async function fetchStepfunPlan(cookieHeader) {
    const opts = {
      method: "POST",
      headers: ["Content-Type: application/json", "Connect-Protocol-Version: 1"],
      body: "{}",
    };
    const [rateRaw, statusRaw] = await Promise.all([
      curlFetch(STEPFUN_PLAN_URL, cookieHeader, "oasis", opts).catch(function () { return { ok: false }; }),
      curlFetch(STEPFUN_STATUS_URL, cookieHeader, "oasis", opts).catch(function () { return { ok: false }; }),
    ]);
    let rate = null;
    let status = null;
    if (rateRaw && rateRaw.ok) { try { rate = parseStepfunPlanRateLimit(JSON.parse(rateRaw.body)); } catch (e) {} }
    if (statusRaw && statusRaw.ok) { try { status = parseStepfunPlanStatus(JSON.parse(statusRaw.body)); } catch (e) {} }
    if (!rate && !status) return null;
    return { rate: rate, status: status };
  }

  /** 用临时 cookie 值试调用量 API（复用 curlFetch + parser；不写任何缓存）。 */
  async function probeLoginValue(provider, value) {
    // StepFun 的登录凭证是网页 Oasis 登录态, 试调走 Connect-JSON 的
    // QueryAccountBalance（与 GET 型 curlFetch 试调不同, 走专用分支）。
    if (provider === "stepfun") return probeStepfunOasis(value);
    const cfg = PROVIDERS[provider];
    const la = LOGIN_ASSIST[provider];
    if (!cfg || !la) return { ok: false, message: "未知 provider" };
    const url = cfg.urls[la.ref] || cfg.urls[cfg.refs[0]];
    const style = (cfg.authStyleByRef && cfg.authStyleByRef[la.ref]) || cfg.authStyle;
    let raw;
    try {
      raw = await curlFetch(url, value, style);
    } catch (e) {
      return { ok: false, message: "试调异常: " + ((e && e.message) || String(e)) };
    }
    if (!raw.ok) return { ok: false, message: raw.message, httpStatus: raw.httpStatus || 0 };
    const parsed = cfg.parse(raw.body);
    if (!parsed.ok) return { ok: false, message: parsed.message || "解析失败" };
    return { ok: true };
  }

  /** 登录会话主流程（异步推进；错误收敛到 failed 终态）。 */
  async function runLoginSession(sess, cfg) {
    try {
      const subprocess = ctx.subprocess;
      if (!subprocess) throw new Error("subprocess service 不可用");
      // 1) 启动专用浏览器 (CDP 随机端口 + 专用持久 profile)
      // 先清掉上一次会话残留的 DevToolsActivePort —— 同一 profile 二次会话时,
      // readDevToolsPort 会读到旧端口（已无监听）导致 CDP fetch 直接失败
      // （实机复现于 login-assist 编排演练: 第二会话 "fetch failed"）。
      try { unlinkSync(join(sess.profileDir, "DevToolsActivePort")); } catch (e) { /* 不存在即成功 */ }
      let handle;
      try {
        handle = subprocess.spawn({
          argv: [
            sess.exe,
            "--remote-debugging-port=0",
            "--user-data-dir=" + sess.profileDir,
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=520,760",
            cfg.loginUrl,
          ],
          cwd: sess.profileDir,
          stdio: { stdin: "ignore", stdout: "ignore", stderr: { maxBytes: 64 * 1024 } },
          graceMs: 5000,
        });
      } catch (e) {
        throw new Error("浏览器启动失败: " + ((e && e.message) || String(e)));
      }
      sess.handle = handle;
      handle.done.then(
        function () { sess.exited = true; },
        function () { sess.exited = true; }
      );
      // 2) 等调试端口 → 找页面 target 的 ws
      const port = await readDevToolsPort(sess.profileDir, LOGIN_READY_TIMEOUT_MS);
      sess.port = port;
      const targets = await cdpListTargets(port);
      const pageWsUrl = pickPageWsUrl(targets);
      if (!pageWsUrl) throw new Error("未找到页面调试目标（远程调试可能被策略禁用）");
      sess.browserWsUrl = await cdpBrowserWsUrl(port).catch(function () { return null; });
      if (sess.state !== "starting") return; // 期间被取消
      // 3) 连接 + 进入等待
      const ws = await cdpOpenWs(pageWsUrl, 10000);
      sess.sess = cdpSession(ws);
      if (sess.state !== "starting") return;
      sess.state = "waiting";
      sess.message = "已打开浏览器，请在页面中完成登录…";
      // 4) 轮询: marker → 试调 API → 写凭据 → 关窗
      while (sess.state === "waiting") {
        if (sess.exited) {
          finishLoginSession(sess, "cancelled", "浏览器已关闭（登录未完成）");
          return;
        }
        if (nowMs() - sess.startedAt > LOGIN_MAX_MS) {
          await closeBrowserForSession(sess);
          finishLoginSession(sess, "timeout", "登录超时（30 分钟），已关闭浏览器窗口");
          return;
        }
        let cookies = [];
        try {
          cookies = await cdpGetCookies(sess.sess, [cfg.siteUrl]);
        } catch (e) {
          if (sess.state !== "waiting") continue; // 被取消: 回顶部收敛
          // ws 可能随页面导航断开: 尝试重连一次, 否则等下一轮
          try {
            const list = await cdpListTargets(sess.port);
            const u = pickPageWsUrl(list);
            if (u) {
              const w2 = await cdpOpenWs(u, 5000);
              if (sess.sess) { try { sess.sess.close(); } catch (e2) {} }
              sess.sess = cdpSession(w2);
            }
          } catch (e2) { /* 浏览器退出过渡态: 下一轮 exited 收敛 */ }
          await sleepMs(LOGIN_POLL_MS);
          continue;
        }
        // 跨域换票（StepFun, 2026-10-01 实机）: 目标域无凭证但账号域已有 → 导航
        // via.returnUrl 触发换票, 下一轮轮询读目标域。只做一次（viaNavigated 防环）。
        if (!hasLoginMarker(sess.provider, cookies) && cfg.via && !sess.viaNavigated) {
          let viaCookies = [];
          try { viaCookies = await cdpGetCookies(sess.sess, cfg.via.urls); } catch (e) { /* 保持等待 */ }
          if (hasLoginMarker(sess.provider, viaCookies)) {
            sess.viaNavigated = true;
            sess.message = "已登录，正在完成跨域跳转…";
            await cdpNavigate(sess.sess, cfg.via.returnUrl, 3000);
            continue;   // 下一轮轮询读目标域 cookie
          }
        }
        if (hasLoginMarker(sess.provider, cookies) && nowMs() - sess.lastProbeAt >= LOGIN_PROBE_MIN_MS) {
          sess.lastProbeAt = nowMs();
          sess.message = "已检测到登录凭证，正在验证…";
          const value = extractLoginCookie(sess.provider, cookies);
          if (value) {
            const probe = await probeLoginValue(sess.provider, value);
            if (probe.ok) {
              if (sess.state !== "waiting") return; // 试调期间被取消: 不写入
              try {
                await ctx.credentials.set(cfg.ref, value);
              } catch (e) {
                await closeBrowserForSession(sess);
                finishLoginSession(sess, "failed", "写入凭据失败: " + ((e && e.message) || String(e)));
                return;
              }
              cache[sess.provider] = null; // 卡片下次拉取立刻取到真实用量
              await closeBrowserForSession(sess);
              finishLoginSession(sess, "success", "已登录，凭据已保存");
              return;
            }
            sess.lastError = probe.message || null;
            sess.message = "已检测到凭证但尚未生效，继续等待…";
          }
        }
        await sleepMs(LOGIN_POLL_MS);
      }
    } catch (e) {
      // 启动/连接阶段失败: 附浏览器 stderr 片段做诊断, 然后收敛
      let diag = "";
      try {
        const h = sess.handle;
        const stderr = h && h.collected && h.collected.stderr ? h.collected.stderr.readFrom(0) : null;
        if (stderr && stderr.text) diag = "（浏览器输出: " + stderr.text.slice(0, 200).replace(/\s+/g, " ") + "）";
      } catch (e2) {}
      try { await closeBrowserForSession(sess); } catch (e2) {}
      finishLoginSession(sess, "failed", ((e && e.message) || String(e)) + diag);
    }
  }

  /** 启动登录会话（幂等: 已有进行中会话时原样返回其状态）。 */
  function startLoginSession(provider) {
    const cfg = LOGIN_ASSIST[provider];
    if (!cfg) return { ok: false, message: "该 provider 不支持自动登录" };
    if (loginSession && LOGIN_ACTIVE_STATES.indexOf(loginSession.state) >= 0) {
      return { ok: true, message: "已有登录进行中", status: loginStatusSnapshot(loginSession) };
    }
    if (typeof WebSocket !== "function") {
      return { ok: false, message: "当前环境不支持 WebSocket，无法自动登录（请按 README 手动配置 cookie）" };
    }
    if (typeof fetch !== "function") {
      return { ok: false, message: "当前环境不支持 fetch，无法自动登录（请按 README 手动配置 cookie）" };
    }
    const candidates = pickBrowserCandidates(process.platform, undefined, process.env);
    if (candidates.length === 0) {
      return { ok: false, message: "未找到 Edge / Chrome（自动登录需要其中一个浏览器）" };
    }
    const exe = candidates[0];
    const kind = /chrome\.exe$/i.test(exe) ? "chrome" : "edge";
    const dshHome = (typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.length > 0)
      ? process.env.DSH_HOME
      : join(homedir(), ".dsh");
    const profileDir = join(dshHome, "musage-login", kind);
    try { mkdirSync(profileDir, { recursive: true }); } catch (e) {}
    loginSession = {
      provider: provider,
      state: "starting",
      message: "正在启动浏览器…",
      startedAt: nowMs(),
      finishedAt: null,
      exe: exe,
      profileDir: profileDir,
      port: 0,
      handle: null,
      sess: null,
      browserWsUrl: null,
      lastProbeAt: 0,
      lastError: null,
      exited: false,
    };
    const sess = loginSession;
    runLoginSession(sess, cfg).catch(function (e) {
      // runLoginSession 内部已收敛错误; 这里兜底 promise 泄漏
      try { finishLoginSession(sess, "failed", (e && e.message) || String(e)); } catch (e2) {}
    });
    return { ok: true, message: "已启动登录助手", status: loginStatusSnapshot(loginSession) };
  }

  /** 取消进行中的登录（关窗）。 */
  async function cancelLoginSession() {
    const sess = loginSession;
    if (!sess || LOGIN_ACTIVE_STATES.indexOf(sess.state) < 0) {
      return { ok: false, message: "没有进行中的登录" };
    }
    sess.state = "cancelled"; // 让轮询循环退出
    await closeBrowserForSession(sess);
    finishLoginSession(sess, "cancelled", "已取消登录");
    return { ok: true, message: "已取消登录" };
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
        // ---- 登录助手路由 ----
        // GET  /musage/login/status → 当前登录会话快照（client 轮询）
        // POST /musage/login        → action=start|cancel（query 或 JSON body）
        scope.webServer.register({
          name: "musage-login-status",
          kind: "exact",
          path: "/musage/login/status",
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
                send(405, { ok: false, message: "method not allowed" });
                return;
              }
              send(200, { ok: true, login: loginStatusSnapshot(loginSession) });
            } catch (e) {
              send(200, { ok: false, message: String((e && e.message) || e) });
            }
          },
        });
        scope.webServer.register({
          name: "musage-login",
          kind: "exact",
          path: "/musage/login",
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
              if (req.method !== "POST") {
                send(405, { ok: false, message: "method not allowed" });
                return;
              }
              const params = new URL(req.url, "http://localhost").searchParams;
              let body = null;
              try { body = await readJsonBody(req); } catch (e) { body = null; }
              const parsed = parseLoginRequest({
                method: "POST",
                action: (body && body.action) || params.get("action") || "start",
                provider: (body && body.provider) || params.get("provider") || "",
              });
              if (!parsed.ok) {
                send(400, { ok: false, message: parsed.message });
                return;
              }
              if (parsed.op === "cancel") {
                send(200, await cancelLoginSession());
                return;
              }
              send(200, startLoginSession(parsed.provider));
            } catch (e) {
              send(200, { ok: false, message: String((e && e.message) || e) });
            }
          },
        });
        console.log("[musage] routes /musage/login + /musage/login/status registered");
      } catch (e) {
        console.error("[musage] quota 路由注册失败: " + ((e && e.stack) || e));
      }
    });
  }

  ctx.effect(() => {
    return () => {
      try { disposeTimer(); } catch (e) {}
      for (const k of Object.keys(cache)) cache[k] = null;
      // 插件卸载/重载: 终止仍在进行的登录会话（关窗）
      if (loginSession && LOGIN_ACTIVE_STATES.indexOf(loginSession.state) >= 0) {
        loginSession.state = "cancelled";
        closeBrowserForSession(loginSession).catch(function () {});
        finishLoginSession(loginSession, "cancelled", "会话已终止（插件重载）");
      }
    };
  });
}
