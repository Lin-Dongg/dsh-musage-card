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
