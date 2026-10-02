// tests/login-assist.test.mjs — 登录助手纯函数单测（node:test）
//
// 运行: node --test tests/login-assist.test.mjs
// 覆盖: CDP cookie 提取/拼接、登录标志判定、浏览器探测、会话状态快照、
//       LOGIN_ASSIST 表与 PROVIDERS 的配置一致性。
// 这些是纯函数测试——不触碰网络与浏览器；CDP 全链路在 cdp-integration.test.mjs。

import { test } from "node:test";
import assert from "node:assert/strict";
import { __login as L, __providers } from "../dsh/index.js";

// ───────────────────────── joinCookieHeader ─────────────────────────

test("joinCookieHeader: 正常拼接为 name=value; 形态", () => {
  assert.equal(
    L.joinCookieHeader([
      { name: "api-platform_serviceToken", value: "tok123" },
      { name: "userId", value: "u-9" },
    ]),
    "api-platform_serviceToken=tok123; userId=u-9"
  );
});

test("joinCookieHeader: 空输入 → null", () => {
  assert.equal(L.joinCookieHeader([]), null);
  assert.equal(L.joinCookieHeader(null), null);
  assert.equal(L.joinCookieHeader(undefined), null);
});

test("joinCookieHeader: 跳过无效条目（name 空 / value 非字符串），保留空串值", () => {
  assert.equal(
    L.joinCookieHeader([
      { name: "a", value: "1" },
      { name: "", value: "x" },        // name 空 → 跳过
      { name: "b" },                   // 无 value → 跳过
      { value: "y" },                  // 无 name → 跳过
      { name: "c", value: "" },        // 空串值 → 保留（忠实浏览器行为）
      { name: "d", value: 42 },        // value 非字符串 → 跳过
      { name: "e", value: "5" },
    ]),
    "a=1; c=; e=5"
  );
});

// ───────────────────────── extractLoginCookie ─────────────────────────

test("extractLoginCookie: xiaomi → 全量拼接（完整 Cookie header）", () => {
  const cookies = [
    { name: "api-platform_serviceToken", value: "tok" },
    { name: "userId", value: "u1" },
    { name: "api-platform_slh", value: "slh-v" },
  ];
  assert.equal(
    L.extractLoginCookie("xiaomi", cookies),
    "api-platform_serviceToken=tok; userId=u1; api-platform_slh=slh-v"
  );
});

test("extractLoginCookie: claude → 只取 sessionKey 的值", () => {
  const cookies = [
    { name: "__cf_bm", value: "cf" },
    { name: "sessionKey", value: "sk-ant-sid01-abc" },
    { name: "activitySessionId", value: "as" },
  ];
  assert.equal(L.extractLoginCookie("claude", cookies), "sk-ant-sid01-abc");
});

test("extractLoginCookie: claude 无 sessionKey → null", () => {
  assert.equal(L.extractLoginCookie("claude", [{ name: "other", value: "x" }]), null);
  assert.equal(L.extractLoginCookie("claude", []), null);
});

test("extractLoginCookie: 未知 provider / 空输入 → null", () => {
  assert.equal(L.extractLoginCookie("nope", [{ name: "a", value: "1" }]), null);
  assert.equal(L.extractLoginCookie("xiaomi", []), null);
});

// ───────────────────────── hasLoginMarker ─────────────────────────

test("hasLoginMarker: xiaomi 以 api-platform_serviceToken（非空值）为标志", () => {
  assert.equal(
    L.hasLoginMarker("xiaomi", [{ name: "api-platform_serviceToken", value: "t" }]),
    true
  );
  assert.equal(L.hasLoginMarker("xiaomi", [{ name: "userId", value: "u" }]), false);
  // 空值不算有效登录凭证
  assert.equal(
    L.hasLoginMarker("xiaomi", [{ name: "api-platform_serviceToken", value: "" }]),
    false
  );
});

test("hasLoginMarker: claude 以 sessionKey 为标志", () => {
  assert.equal(L.hasLoginMarker("claude", [{ name: "sessionKey", value: "sk" }]), true);
  assert.equal(L.hasLoginMarker("claude", [{ name: "other", value: "x" }]), false);
});

test("hasLoginMarker: 未知 provider → false", () => {
  assert.equal(L.hasLoginMarker("nope", [{ name: "a", value: "1" }]), false);
});

// ───────────────────────── pickBrowserCandidates ─────────────────────────

test("pickBrowserCandidates: win32 全命中 → 保序全返回（含 LOCALAPPDATA Chrome）", () => {
  const r = L.pickBrowserCandidates("win32", () => true, {
    LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
  });
  assert.equal(r.length, 5);
  assert.ok(r[0].includes("Program Files (x86)"));           // Edge x86 优先
  assert.ok(r[0].includes("Microsoft\\Edge"));
  assert.ok(r[r.length - 1].includes("AppData\\Local"));     // 用户级 Chrome 最后
});

test("pickBrowserCandidates: 只命中 Edge → 只返回 Edge（优先级顺序保持）", () => {
  const r = L.pickBrowserCandidates(
    "win32",
    (p) => p.includes("Microsoft\\Edge"),
    {}
  );
  assert.equal(r.length, 2);
  assert.ok(r[0].includes("Program Files (x86)"));
  assert.ok(r[1].includes("Program Files\\Microsoft"));
});

test("pickBrowserCandidates: 全部不存在 → []", () => {
  assert.deepEqual(L.pickBrowserCandidates("win32", () => false, {}), []);
});

test("pickBrowserCandidates: 非 win32 → []（本期仅支持 Windows 探测）", () => {
  assert.deepEqual(L.pickBrowserCandidates("darwin", () => true, {}), []);
});

// ───────────────────────── LOGIN_ASSIST 配置一致性 ─────────────────────────

test("LOGIN_ASSIST: xiaomi / claude 有条目，ref 落在 PROVIDERS.refs 内", () => {
  assert.ok(L.LOGIN_ASSIST.xiaomi, "xiaomi 缺登录助手配置");
  assert.ok(L.LOGIN_ASSIST.claude, "claude 缺登录助手配置");
  assert.equal(L.LOGIN_ASSIST.xiaomi.ref, "XIAOMI_MIMO_COOKIE");
  assert.equal(L.LOGIN_ASSIST.claude.ref, "CLAUDE_SESSION_KEY");
  // ref 必须在对应 provider 的 refs 列表里，否则写库后解析链路根本读不到
  assert.ok(__providers.xiaomi.refs.includes(L.LOGIN_ASSIST.xiaomi.ref), "xiaomi ref 不在 refs");
  assert.ok(__providers.claude.refs.includes(L.LOGIN_ASSIST.claude.ref), "claude ref 不在 refs");
  // 登录页/站点 URL 必须是 https
  assert.ok(String(L.LOGIN_ASSIST.xiaomi.loginUrl).startsWith("https://"));
  assert.ok(String(L.LOGIN_ASSIST.claude.loginUrl).startsWith("https://"));
});

test("LOGIN_ASSIST: markerCookies 非空且均为非空字符串", () => {
  for (const [p, cfg] of Object.entries(L.LOGIN_ASSIST)) {
    assert.ok(Array.isArray(cfg.markerCookies) && cfg.markerCookies.length > 0, p + " markerCookies 缺失");
    for (const m of cfg.markerCookies) {
      assert.equal(typeof m, "string");
      assert.ok(m.length > 0);
    }
  }
});

// ───────────────────────── loginStatusSnapshot ─────────────────────────

test("loginStatusSnapshot: 无会话 → idle", () => {
  assert.deepEqual(L.loginStatusSnapshot(null), { active: false, state: "idle" });
  assert.deepEqual(L.loginStatusSnapshot(undefined), { active: false, state: "idle" });
});

test("loginStatusSnapshot: 进行中会话 active=true，且不泄露内部字段", () => {
  const snap = L.loginStatusSnapshot({
    provider: "xiaomi",
    state: "waiting",
    message: "等待登录",
    startedAt: 123,
    ws: { fake: true },
    browserPid: 42,
    profileDir: "C:\\x",
    handle: { secret: 1 },
  });
  assert.equal(snap.active, true);
  assert.equal(snap.provider, "xiaomi");
  assert.equal(snap.state, "waiting");
  assert.equal(snap.message, "等待登录");
  // 内部实现字段一律不外泄
  assert.equal(snap.ws, undefined);
  assert.equal(snap.browserPid, undefined);
  assert.equal(snap.profileDir, undefined);
  assert.equal(snap.handle, undefined);
});

test("loginStatusSnapshot: 终结态 active=false 但保留结果快照", () => {
  const snap = L.loginStatusSnapshot({
    provider: "claude",
    state: "success",
    message: "已登录",
    startedAt: 1,
  });
  assert.equal(snap.active, false);
  assert.equal(snap.state, "success");
  assert.equal(snap.provider, "claude");
});

// ───────────────────────── parseLoginRequest ─────────────────────────

test("parseLoginRequest: GET → status 操作", () => {
  assert.deepEqual(L.parseLoginRequest({ method: "GET" }), { ok: true, op: "status" });
});

test("parseLoginRequest: POST start + 受支持 provider", () => {
  assert.deepEqual(
    L.parseLoginRequest({ method: "POST", action: "start", provider: "xiaomi" }),
    { ok: true, op: "start", provider: "xiaomi" }
  );
});

test("parseLoginRequest: POST 无 action 默认 start（需 provider）", () => {
  assert.deepEqual(
    L.parseLoginRequest({ method: "POST", provider: "claude" }),
    { ok: true, op: "start", provider: "claude" }
  );
});

test("parseLoginRequest: POST start 缺 provider → 拒绝", () => {
  const r = L.parseLoginRequest({ method: "POST", action: "start" });
  assert.equal(r.ok, false);
  assert.ok(String(r.message).includes("provider"));
});

test("parseLoginRequest: POST start + 不支持 provider → 拒绝并存证", () => {
  const r = L.parseLoginRequest({ method: "POST", action: "start", provider: "deepseek" });
  assert.equal(r.ok, false);
  assert.ok(String(r.message).includes("deepseek"));
});

test("parseLoginRequest: POST cancel → cancel 操作", () => {
  assert.deepEqual(
    L.parseLoginRequest({ method: "POST", action: "cancel" }),
    { ok: true, op: "cancel" }
  );
});

test("parseLoginRequest: POST logout + 受支持 provider → logout 操作（2026-10-02 登出按钮）", () => {
  assert.deepEqual(
    L.parseLoginRequest({ method: "POST", action: "logout", provider: "stepfun" }),
    { ok: true, op: "logout", provider: "stepfun" }
  );
});

test("parseLoginRequest: POST logout 缺 provider / 非登录 provider → 拒绝", () => {
  assert.equal(L.parseLoginRequest({ method: "POST", action: "logout" }).ok, false);
  assert.equal(L.parseLoginRequest({ method: "POST", action: "logout", provider: "deepseek" }).ok, false);
});

test("parseLoginRequest: 未知 action / 不支持 method → 拒绝", () => {
  assert.equal(L.parseLoginRequest({ method: "POST", action: "nope" }).ok, false);
  assert.equal(L.parseLoginRequest({ method: "DELETE" }).ok, false);
});

// ───────────────────────── readJsonBody ─────────────────────────

test("readJsonBody: 分片收集并解析 JSON body", async () => {
  const { EventEmitter } = await import("node:events");
  const req = new EventEmitter();
  const p = L.readJsonBody(req);
  req.emit("data", Buffer.from('{"action":"start"'));
  req.emit("data", Buffer.from(',"provider":"xiaomi"}'));
  req.emit("end");
  const body = await p;
  assert.equal(body.action, "start");
  assert.equal(body.provider, "xiaomi");
});

test("readJsonBody: 空 body → null", async () => {
  const { EventEmitter } = await import("node:events");
  const req = new EventEmitter();
  const p = L.readJsonBody(req);
  req.emit("end");
  assert.equal(await p, null);
});

test("readJsonBody: 超过限长 → reject", async () => {
  const { EventEmitter } = await import("node:events");
  const req = new EventEmitter();
  const p = L.readJsonBody(req, 8);
  req.emit("data", Buffer.from("123456789"));
  await assert.rejects(p);
});

test("readJsonBody: 非法 JSON → reject", async () => {
  const { EventEmitter } = await import("node:events");
  const req = new EventEmitter();
  const p = L.readJsonBody(req);
  req.emit("data", Buffer.from("not-json"));
  req.emit("end");
  await assert.rejects(p);
});

// ───────────────────────── pickCookieValue ─────────────────────────

test("pickCookieValue: 从 Cookie header 提取指定 cookie", () => {
  const h = "a=1; Oasis-Token=tk-123; WebID=wid-9; b=2";
  assert.equal(L.pickCookieValue(h, "Oasis-Token"), "tk-123");
  assert.equal(L.pickCookieValue(h, "WebID"), "wid-9");
});

test("pickCookieValue: 精确匹配键名（不做前后缀模糊）", () => {
  const h = "X-Oasis-Token=x; Oasis-Token-2=y; WebIDExtra=z";
  assert.equal(L.pickCookieValue(h, "Oasis-Token"), null);
  assert.equal(L.pickCookieValue(h, "WebID"), null);
});

test("pickCookieValue: 空输入 / 无该键 → null", () => {
  assert.equal(L.pickCookieValue("", "Oasis-Token"), null);
  assert.equal(L.pickCookieValue(null, "Oasis-Token"), null);
  assert.equal(L.pickCookieValue("a=1; b=2", "Oasis-Token"), null);
});

// ───────────────────────── parseStepfunOasis ─────────────────────────

test("parseStepfunOasis: 实机响应形状（snake_case 字符串分）→ 金额转元 + credit 保留", () => {
  const r = L.parseStepfunOasis({
    voucher: "596", payment: "0", balance: "596",
    cost_yesterday: "457", cost_month: "447", cost_total: "904",
    voucher_expire_time: 7776000, notify_threshold: 10,
    credit: "0", voucher_api: "596", voucher_plan: "0",
  });
  assert.equal(r.voucher, 5.96);
  assert.equal(r.balance, 5.96);
  assert.equal(r.voucherApi, 5.96);
  assert.equal(r.voucherPlan, 0);
  assert.equal(r.costYesterday, 4.57);
  assert.equal(r.costMonth, 4.47);
  assert.equal(r.costTotal, 9.04);
  assert.equal(r.credit, 0);
});

test("parseStepfunOasis: 兼容 camelCase 与数字输入", () => {
  const r = L.parseStepfunOasis({ voucherPlan: 5000, costMonth: 150, credit: 12.5 });
  assert.equal(r.voucherPlan, 50);
  assert.equal(r.costMonth, 1.5);
  assert.equal(r.credit, 12.5);
});

test("parseStepfunOasis: 非法输入 / 无可用字段 → null", () => {
  assert.equal(L.parseStepfunOasis(null), null);
  assert.equal(L.parseStepfunOasis("not json"), null);
  assert.equal(L.parseStepfunOasis([]), null);
  assert.equal(L.parseStepfunOasis({ message: "x" }), null);   // Connect 错误形状
  assert.equal(L.parseStepfunOasis({ credit: "abc" }), null);  // 无可解析数字
});

test("parseStepfunOasis: 部分字段合法即可（credit 缺但 voucherPlan 在）", () => {
  const r = L.parseStepfunOasis({ voucherPlan: 700 });
  assert.equal(r.voucherPlan, 7);
  assert.equal(r.credit, null);
});

// ───────────────────────── LOGIN_ASSIST.stepfun ─────────────────────────

test("LOGIN_ASSIST: stepfun 条目 —— ref / 登录页 / 标记 cookie / 换票配置对齐", () => {
  const cfg = L.LOGIN_ASSIST.stepfun;
  assert.ok(cfg, "缺 stepfun 登录助手配置");
  assert.equal(cfg.ref, "STEPFUN_COOKIE");
  assert.ok(String(cfg.loginUrl).includes("account.stepfun.com"), "登录页应为账号域");
  assert.deepEqual(cfg.markerCookies, ["Oasis-Token"]);
  assert.equal(cfg.extract, "all");
  // 换票/自愈的导航目标 = 登录页
  assert.ok(cfg.via, "缺跨域换票配置");
  assert.ok(Array.isArray(cfg.via.urls) && cfg.via.urls.length > 0);
  assert.equal(String(cfg.via.returnUrl), String(cfg.loginUrl), "换票目标应为同一登录页");
});

test("LOGIN_ASSIST.stepfun: loginUrl 用平台自身 redirect 格式（2026-10-02 无数据修复回归）", () => {
  // 回归背景：旧值 …/login?redirect=%2F%3FreturnTo%3D… 用了账号域不识别的 returnTo 参数 ——
  // 实机复现「登录成功后只落到 /security、平台 Oasis-Token 永不刷新、卡片无数据」。
  // 平台自身的跳转格式为 login?redirect=<平台URL>&source_app=platform-cn（2026-10-02 实测）。
  const cfg = L.LOGIN_ASSIST.stepfun;
  const u = String(cfg.loginUrl);
  assert.ok(u.startsWith("https://account.stepfun.com/login?redirect="), u);
  assert.ok(u.includes(encodeURIComponent("https://platform.stepfun.com/account-overview")), "redirect 必须指向平台页: " + u);
  assert.ok(u.includes("source_app=platform-cn"), u);
  assert.ok(!u.includes("returnTo="), "不得再用账号域不识别的 returnTo 参数: " + u);
});

// ───────────────────────── parseStepfunPlanRateLimit / Status ─────────────────────────

test("parseStepfunPlanRateLimit: 实机形状 → 剩余率 / buckets（coding plan 额度）", () => {
  const r = L.parseStepfunPlanRateLimit({
    status: 1, desc: "", five_hour_usage_left_rate: 0, weekly_usage_left_rate: 0, plan_family: 2,
    plan_credit_rate_limit: {
      subscription_credit_left_rate: 0.9555458,
      subscription_credit_reset_time: "1792580265",
      topup_credit_left_rate: 0,
      credit_buckets: [{ type: 1, credit_total: "1600000000", credit_residual: "1528873224", expire_at: "1796357377", next_reset_at: "1792580265" }],
    },
  });
  assert.equal(r.creditLeftRate, 0.9555458);
  assert.equal(r.creditTotal, 1600000000);
  assert.equal(r.creditResidual, 1528873224);
  assert.equal(r.creditResetAt, 1792580265);
  assert.equal(r.planFamily, 2);
});

test("parseStepfunPlanRateLimit: 无 plan_credit_rate_limit → null", () => {
  assert.equal(L.parseStepfunPlanRateLimit(null), null);
  assert.equal(L.parseStepfunPlanRateLimit({ status: 1 }), null);
});

test("parseStepfunPlanStatus: 实机形状 → 套餐名 / 到期 / 续费", () => {
  const r = L.parseStepfunPlanStatus({
    status: 1,
    subscription: { plan_type: 1, name: "Plus", status: 1, activated_at: "1789877377", expired_at: "1796357377", auto_renew: false, plan_id: "21", plan_family: 2 },
  });
  assert.equal(r.name, "Plus");
  assert.equal(r.active, true);
  assert.equal(r.expiredAt, 1796357377);
  assert.equal(r.autoRenew, false);
});

test("parseStepfunPlanStatus: 无 subscription → null", () => {
  assert.equal(L.parseStepfunPlanStatus(null), null);
  assert.equal(L.parseStepfunPlanStatus({ status: 0 }), null);
});

// ───────────────────────── classifyLoginPage（看门狗，2026-10 白屏修复配套） ─────────────────────────

test("classifyLoginPage: 密码框出现 → login（即使正文还空）", () => {
  assert.equal(L.classifyLoginPage({ text: "", hasPassword: true }), "login");
});

test("classifyLoginPage: 无可见文本 → blank（白屏）", () => {
  assert.equal(L.classifyLoginPage({ text: "", hasPassword: false }), "blank");
  assert.equal(L.classifyLoginPage({ text: "   \n\t ", hasPassword: false }), "blank");
  assert.equal(L.classifyLoginPage(null), "blank");
  assert.equal(L.classifyLoginPage(undefined), "blank");
});

test("classifyLoginPage: 浏览器网络错误页（正文含 ERR_*）→ error", () => {
  assert.equal(
    L.classifyLoginPage({ text: "无法访问此网站\nERR_CONNECTION_TIMED_OUT", hasPassword: false }),
    "error"
  );
});

test("classifyLoginPage: 有内容但未见表单 → content", () => {
  assert.equal(L.classifyLoginPage({ text: "加载中...", hasPassword: false }), "content");
});

test("LOGIN_ASSIST.xiaomi: loginUrl 走服务端 302 直达 SSO（白屏修复回归）", () => {
  // 回归背景（2026-10-02 探针实证）：直接打开 console/balance 是 SPA 空壳，
  // 服务端不重定向，需等 ~8-10s 客户端 JS 执行后才跳 SSO，期间纯白 ——
  // 朋友实机因此报「点击卡片打开网页是白屏」。改用 genLoginUrl 服务端 302。
  const u = String(L.LOGIN_ASSIST.xiaomi.loginUrl);
  assert.ok(u.includes("platform.xiaomimimo.com/api/v1/genLoginUrl"), "应使用 genLoginUrl 服务端跳转端点: " + u);
  assert.ok(u.includes("currentPath="), "应带 currentPath 参数: " + u);
  assert.ok(!u.includes("console/balance"), "不应再直接打开 console SPA 空壳: " + u);
});

// ───────────────────────── isAuthFailureMessage（旧登录态自愈判据，2026-10） ─────────────────────────

test("isAuthFailureMessage: curl HTTP 401/403 → true", () => {
  assert.equal(L.isAuthFailureMessage('HTTP 401 · {"code":401}'), true);
  assert.equal(L.isAuthFailureMessage("HTTP 403 · forbidden"), true);
});

test("isAuthFailureMessage: Oasis 过期 / 未认证文案 → true", () => {
  // StepFun 实机（2026-10-02）: {"code":"unauthenticated","message":"auth failed: token is expired"}
  assert.equal(
    L.isAuthFailureMessage('{"code":"unauthenticated","message":"auth failed: token is expired"}'),
    true
  );
  assert.equal(L.isAuthFailureMessage("token is expired"), true);
  assert.equal(L.isAuthFailureMessage("Unauthenticated"), true);
});

test("isAuthFailureMessage: 其它失败（网络/5xx/空）→ false，且数字不误判", () => {
  assert.equal(L.isAuthFailureMessage("HTTP 500 · oops"), false);
  assert.equal(L.isAuthFailureMessage("curl 退出 7 · failed to connect"), false);
  assert.equal(L.isAuthFailureMessage(""), false);
  assert.equal(L.isAuthFailureMessage(null), false);
  assert.equal(L.isAuthFailureMessage(undefined), false);
  assert.equal(L.isAuthFailureMessage("HTTP 4010"), false, "4010 不应命中 401");
});
