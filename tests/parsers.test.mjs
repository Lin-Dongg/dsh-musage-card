// tests/parsers.test.mjs — dsh-musage host 半边解析函数单测（node:test）
//
// 运行: node --test tests/parsers.test.mjs
// 覆盖: 2026-10 新增 5 家（siliconflow / tavily / zenmux / xiaomi / claude）
//       + 既有家（stepfun / zhipu / kimi）回归 sanity。
// 这些是纯函数测试——mock 掉网络层，只锁"上游响应 → display 结构"的映射。

import { test } from "node:test";
import assert from "node:assert/strict";
import { __parsers as P, __providers } from "../dsh/index.js";
import * as HOST from "../dsh/index.js";

// ───────────────────────── SiliconFlow ─────────────────────────

test("siliconflow: 正常响应 → 余额 + 细分", () => {
  const r = P.siliconflow(JSON.stringify({
    code: 20000, message: "OK", status: true,
    data: { balance: "0.88", chargeBalance: "88.00", totalBalance: "88.88" },
  }));
  assert.equal(r.ok, true);
  assert.equal(r.provider, "siliconflow");
  assert.equal(r.display.balanceText, "¥0.88");
  assert.equal(r.display.balanceDetail, "充值 ¥88.00 · 总额 ¥88.88");
});

test("siliconflow: 业务码非 20000 → server_error", () => {
  const r = P.siliconflow({ code: 30001, message: "无效的令牌" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "server_error");
  assert.ok(String(r.message).includes("30001"));
});

test("siliconflow: data.balance 缺失 → parse 错误", () => {
  const r = P.siliconflow({ code: 20000, data: { chargeBalance: "1" } });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "parse");
});

test("siliconflow: 非法 JSON → parse 错误", () => {
  const r = P.siliconflow("not json");
  assert.equal(r.ok, false);
});

// ───────────────────────── Tavily ─────────────────────────

test("tavily: 正常响应 → 已用/总量 + 明细", () => {
  const r = P.tavily({
    account: { current_plan: "Researcher" },
    key: { usage: 150, limit: 1000, search_usage: 80, extract_usage: 20, crawl_usage: 0, map_usage: 0, research_usage: 50 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.display.balanceLabel, "用量");
  assert.equal(r.display.balanceText, "150 / 1000 credits");
  assert.equal(r.display.balanceDetail, "套餐 Researcher — 搜索 80 · 提取 20 · 研究 50");
});

test("tavily: limit=null → 只显示已用", () => {
  const r = P.tavily({ key: { usage: 7, limit: null } });
  assert.equal(r.ok, true);
  assert.equal(r.display.balanceText, "7 credits 已用");
  assert.equal(r.display.balanceDetail, null);
});

test("tavily: key 缺失 → parse 错误", () => {
  const r = P.tavily({ account: {} });
  assert.equal(r.ok, false);
});

// ───────────────────────── ZenMux ─────────────────────────

test("zenmux: 正常响应 → 余额 + 充值/奖励细分", () => {
  const r = P.zenmux({ success: true, data: { currency: "usd", total_credits: 482.74, top_up_credits: 35.0, bonus_credits: 447.74 } });
  assert.equal(r.ok, true);
  assert.equal(r.display.balanceText, "$483"); // ≥100 取整（formatBalance 既有行为）
  assert.equal(r.display.balanceDetail, "充值 $35.00 · 奖励 $448");
});

test("zenmux: success=false → server_error", () => {
  const r = P.zenmux({ success: false, message: "invalid key" });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "server_error");
});

test("zenmux: total_credits 缺失 → parse 错误", () => {
  const r = P.zenmux({ success: true, data: { top_up_credits: 1 } });
  assert.equal(r.ok, false);
});

// ───────────────────────── Xiaomi (MiMo) ─────────────────────────

test("xiaomi: 正常响应 → 月总额/补偿 两行（套餐行已合并进月总额）", () => {
  const r = P.xiaomi({
    data: {
      usage: { percent: 0.3483, items: [
        { name: "plan_total_token", percent: 0.3483 },
        { name: "compensation_total_token", percent: 0.02 },
      ] },
      monthUsage: { percent: 0.42 },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.display.pctRows.length, 2);
  assert.deepEqual(r.display.pctRows[0], { label: "月总额", pct: 42, tone: "rainbow" });
  assert.deepEqual(r.display.pctRows[1], { label: "补偿", pct: 2, tone: "plain" });
});

test("xiaomi: 仅套餐 percent（无月总额）→ 月总额单行（套餐值兜底）", () => {
  const r = P.xiaomi({ data: { usage: { percent: 0.5 } } });
  assert.equal(r.ok, true);
  assert.equal(r.display.pctRows.length, 1);
  assert.equal(r.display.pctRows[0].pct, 50);
  assert.equal(r.display.pctRows[0].label, "月总额");
  assert.equal(r.display.pctRows[0].tone, "rainbow");
});

test("xiaomi: 套餐过期（无可用 percent）→ parse 错误", () => {
  const r = P.xiaomi({ data: { usage: { items: [] }, monthUsage: {} } });
  assert.equal(r.ok, false);
  assert.equal(r.kind, "parse");
});

// ───────────────────────── Claude 官方 ─────────────────────────

test("claude: 正常响应 → 5h/7d 双行 + 重置倒计时", () => {
  const r = P.claude({
    five_hour: { utilization: 72.0, resets_at: "2027-01-01T18:30:00.000Z" },
    seven_day: { utilization: 45.0, resets_at: "2027-01-05T03:00:00.000Z" },
  });
  assert.equal(r.ok, true);
  assert.equal(r.display.fiveHrPct, 72);
  assert.equal(r.display.weeklyPct, 45);
  assert.ok(/重置/.test(r.display.fiveHrResetsIn));
  assert.ok(/重置/.test(r.display.weeklyResetsIn));
});

test("claude: overage (>100) 夹取到 100", () => {
  const r = P.claude({ five_hour: { utilization: 100.4 } });
  assert.equal(r.ok, true);
  assert.equal(r.display.fiveHrPct, 100);
  assert.equal(r.display.weeklyPct, null);
});

test("claude: 只回 seven_day → 单行", () => {
  const r = P.claude({ seven_day: { utilization: 10 } });
  assert.equal(r.ok, true);
  assert.equal(r.display.fiveHrPct, null);
  assert.equal(r.display.weeklyPct, 10);
});

test("claude: 空对象（sessionKey 无效）→ parse 错误", () => {
  const r = P.claude({});
  assert.equal(r.ok, false);
});

// ───────────────────────── 既有家回归 sanity ─────────────────────────

test("regression: stepfun 余额解析保持", () => {
  const r = P.stepfun({ object: "account", type: "prepaid", balance: 15.0, total_cash_balance: 0.0, total_voucher_balance: 15.0 });
  assert.equal(r.ok, true);
  assert.equal(r.display.balanceText, "¥15.00");
});

test("regression: zhipu 5h/7d 解析保持", () => {
  const r = P.zhipu({
    code: 200, success: true,
    data: { limits: [
      { type: "CREDIT_LIMIT", unit: 3, usage: 2000, remaining: 1200, percentage: 40, nextResetTime: 1796969101067 },
      { type: "CREDIT_LIMIT", unit: 6, usage: 30000, remaining: 15000, percentage: 50, nextResetTime: 1798000000000 },
    ] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.display.fiveHrPct, 40);
  assert.equal(r.display.weeklyPct, 50);
});

test("regression: kimi 5h/7d 解析保持", () => {
  const r = P.kimi({
    limits: [{ detail: { limit: 100, remaining: 72, resetTime: 1790000000000 } }],
    usage: { limit: 1000, remaining: 742, resetTime: 1790100000000 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.display.fiveHrPct, 28); // (100-72)/100
  assert.equal(r.display.weeklyHrPct ?? r.display.weeklyPct, 26); // (1000-742)/1000 → 25.8 → 26
});

test("regression: deepseek 余额解析保持", () => {
  const r = P.deepseek({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "43.97" }] });
  assert.equal(r.ok, true);
  assert.equal(r.display.balanceText, "¥43.97");
});

// ───────────────────────── Xiaomi refs / 鉴权分派（2026-10 修复） ─────────────────────────

test("xiaomi: refs 覆盖 DSH 内置三区 Token Plan key（Bearer）+ cookie 兜底", () => {
  const refs = __providers.xiaomi.refs;
  assert.ok(refs.includes("XIAOMI_TOKEN_PLAN_AMS_API_KEY"), "缺 AMS key ref");
  assert.ok(refs.includes("XIAOMI_TOKEN_PLAN_CN_API_KEY"), "缺 CN key ref");
  assert.ok(refs.includes("XIAOMI_TOKEN_PLAN_SGP_API_KEY"), "缺 SGP key ref");
  assert.ok(refs.includes("XIAOMI_MIMO_COOKIE"), "缺 cookie ref");
});

test("xiaomi: authStyleByRef 按 ref 分派——key 走 bearer, cookie 走 cookie", () => {
  const m = __providers.xiaomi.authStyleByRef || {};
  assert.equal(m["XIAOMI_MIMO_COOKIE"], "cookie");
  assert.equal(m["XIAOMI_TOKEN_PLAN_AMS_API_KEY"], "bearer");
});

// ───────────────────────── 401 → Cookie 兜底（2026-10 实机修复） ─────────────────────────
// 实机：AMS Token Plan key（Bearer）打 dashboard 端点返 401 + loginUrl；
// 对齐 Musage xiaomi.rs 的 BearerThenCookie：401 时自动退浏览器 Cookie 重试。

test("xiaomi: fallbackAuth 配置存在且指向 cookie refs", () => {
  const fb = __providers.xiaomi.fallbackAuth;
  assert.ok(fb, "缺 fallbackAuth 配置");
  assert.equal(fb.style, "cookie");
  assert.ok(fb.refs.includes("XIAOMI_MIMO_COOKIE"), "兜底 refs 应含 XIAOMI_MIMO_COOKIE");
});

test("pickFallbackAuth: 仅 401 且配了 fallbackAuth 时触发", () => {
  const fn = HOST.pickFallbackAuth;
  assert.equal(typeof fn, "function", "pickFallbackAuth 未导出");
  const cfg = __providers.xiaomi;
  // 401 且已配 → 触发
  const hit = fn(cfg, { ok: false, httpStatus: 401 });
  assert.ok(hit, "401 应触发兜底");
  assert.equal(hit.style, "cookie");
  // 其它失败 / 成功 / 未配 fallbackAuth → 不触发
  assert.equal(fn(cfg, { ok: false, httpStatus: 500 }), null, "非 401 不兜底");
  assert.equal(fn(cfg, { ok: false, httpStatus: 429 }), null, "429 不兜底");
  assert.equal(fn(cfg, { ok: true }), null, "成功不兜底");
  assert.equal(fn(__providers.deepseek, { ok: false, httpStatus: 401 }), null, "无 fallbackAuth 不兜底");
});
