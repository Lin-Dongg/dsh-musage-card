// tests/session-orchestration.test.mjs — 登录会话编排层集成测试（node:test）
//
// 运行: node --test tests/session-orchestration.test.mjs
// 覆盖: 从【生产路由 handler】驱动 apply() 的登录会话编排 ——
//   start → 真实浏览器(CDP) → waiting → cancel → 关窗清理;
//   同 profile 二次会话（stale DevToolsActivePort 回归）;
//   用户关窗 → cancelled; 参数校验 / cancel 幂等 / dispose 清理。
// mock 只包住 ctx 服务面（credentials/subprocess/timer/effect/inject）;
// 浏览器与 CDP 均为真实执行。测试把浏览器降级为 --headless=new（不弹窗）;
// headful 路径已由首轮编排探针实测验证（同场景 headful PASS）。
// 无浏览器时自动 skip（不算失败）。

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as host from "../dsh/index.js";

// 测试专用 DSH_HOME：生产代码的 profileDir = <DSH_HOME>/musage-login/<browser>
// 由环境变量派生，spawn argv 与端口读取共用同一来源。改它即可整体隔离——
// 真实联调会话可能正占用默认 profile（Chromium singleton 锁会让测试浏览器
// 直接退出、不写 DevToolsActivePort → 30s 超时误报）。
const TEST_DSH_HOME = mkdtempSync(join(tmpdir(), "musage-orch-home-"));
process.env.DSH_HOME = TEST_DSH_HOME;

const browsers = (() => {
  try { return host.__login.pickBrowserCandidates(process.platform, undefined, process.env); }
  catch (e) { return []; }
})();
const hasBrowser = browsers.length > 0;

// ---------- mock ctx（文件级共享：编排是有状态的，用例顺序执行） ----------
const registeredRoutes = [];
const disposers = [];
const children = new Set();
const credentialsStore = new Map();

const ctx = {
  credentials: {
    resolve: async (ref) => credentialsStore.has(ref)
      ? { value: credentialsStore.get(ref), source: "file" }
      : undefined,
    set: async (ref, value) => { credentialsStore.set(ref, value); },
  },
  subprocess: {
    resolveExecutable: async (name) => name,
    spawn: (spec) => {
      const argv = spec.argv.slice();
      argv.splice(1, 0, "--headless=new"); // 测试降级：不弹窗（headful 由手工 E2E 覆盖）
      // profile 隔离由模块级 DSH_HOME 改写完成（spawn argv 与端口读取同源）
      const child = spawn(argv[0], argv.slice(1), { stdio: "ignore" });
      children.add(child);
      child.on("exit", () => children.delete(child));
      const done = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ exitCode: code, signal })));
      return {
        pid: child.pid,
        done,
        collected: { stdout: null, stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) } },
        terminate: () => { try { child.kill(); } catch (e) {} },
        waitForExit: () => done,
      };
    },
  },
  // 预热轮询不执行（本测试只关心登录会话；登录轮询走 sleepMs 自管循环）
  timer: { interval: () => () => {}, timeout: () => {} },
  effect: (fn) => { const d = fn(); if (typeof d === "function") disposers.push(d); },
  inject: (deps, cb) => {
    if (Array.isArray(deps) && deps.indexOf("webServer") >= 0) {
      cb({ webServer: { register: (route) => { registeredRoutes.push(route); return () => {}; } } });
    }
  },
};

host.apply(ctx);

// ---------- fake req/res（走生产 handler; isTrustedRequest 用 loopback host 通过） ----------
function makeReq(method, url) {
  const handlers = {};
  const req = {
    method,
    url,
    headers: { host: "127.0.0.1:19387" },
    on(ev, fn) { handlers[ev] = fn; },
    destroy() {},
  };
  setImmediate(() => { if (handlers.end) handlers.end(); });
  return req;
}
function makeRes() {
  const state = { status: 0, body: null };
  return {
    writeHead(code) { state.status = code; },
    end(text) { try { state.body = JSON.parse(text); } catch (e) { state.body = { raw: text }; } },
    _state: state,
  };
}
async function callRoute(path, method, url) {
  const route = registeredRoutes.find((r) => r.path === path);
  if (!route) throw new Error("route not found: " + path);
  const res = makeRes();
  await route.handler(makeReq(method, url), res);
  return res._state;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getLogin() {
  const rs = await callRoute("/musage/login/status", "GET", "/musage/login/status");
  return rs.body && rs.body.login;
}
async function waitState(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let snap = await getLogin();
  while (!pred(snap) && Date.now() < deadline) {
    await sleep(500);
    snap = await getLogin();
  }
  return snap;
}
const TERMINAL = ["failed", "cancelled", "timeout"];
const reachedWaitOrTerminal = (s) => !!s && (s.state === "waiting" || TERMINAL.indexOf(s.state) >= 0);

after(() => {
  for (const c of children) { try { c.kill(); } catch (e) {} }
  try { rmSync(TEST_DSH_HOME, { recursive: true, force: true }); } catch (e) {}
});

// ---------- 用例 ----------

test("编排: start → waiting → cancel（真实浏览器 + CDP 全链）", { timeout: 90000 }, async (t) => {
  if (!hasBrowser) { t.skip("无 Edge/Chrome，跳过编排集成测试"); return; }
  const r1 = await callRoute("/musage/login", "POST", "/musage/login?action=start&provider=xiaomi");
  assert.equal(r1.status, 200);
  assert.equal(r1.body.ok, true);
  assert.equal(r1.body.status.active, true);

  const snap = await waitState(reachedWaitOrTerminal, 45000);
  assert.equal(snap.state, "waiting", "应到达 waiting（浏览器就绪 + CDP 连接）: " + JSON.stringify(snap));
  assert.equal(snap.ws, undefined, "快照不应泄露内部 ws 引用");
  assert.equal(snap.profileDir, undefined, "快照不应泄露 profileDir");

  const r2 = await callRoute("/musage/login", "POST", "/musage/login?action=cancel");
  assert.equal(r2.body.ok, true);
  const snap2 = await waitState((s) => s && s.state === "cancelled", 15000);
  assert.equal(snap2.state, "cancelled");
  assert.equal(snap2.active, false);
  await sleep(2500);
  assert.equal(children.size, 0, "cancel 后不应有浏览器进程残留");
});

test("编排: 同 profile 二次会话（stale DevToolsActivePort 回归）", { timeout: 90000 }, async (t) => {
  // 守护 bug：同一 profileDir 第二次启动若不清 DevToolsActivePort，
  // readDevToolsPort 会读到旧端口（无监听）→ CDP fetch failed。
  // 红灯证据：首轮探针（未修复版）第二会话实测 "fetch failed"（11/12）。
  if (!hasBrowser) { t.skip("无 Edge/Chrome，跳过"); return; }
  const r1 = await callRoute("/musage/login", "POST", "/musage/login?action=start&provider=claude");
  assert.equal(r1.body.ok, true, JSON.stringify(r1.body));
  const snap = await waitState(reachedWaitOrTerminal, 45000);
  assert.equal(snap.state, "waiting", "第二个会话（同 profile）也应到达 waiting: " + JSON.stringify(snap));
  await callRoute("/musage/login", "POST", "/musage/login?action=cancel");
  await waitState((s) => s && s.state === "cancelled", 15000);
  await sleep(2500);
});

test("编排: 用户关窗 → cancelled（浏览器已关闭路径）", { timeout: 90000 }, async (t) => {
  if (!hasBrowser) { t.skip("无 Edge/Chrome，跳过"); return; }
  const r1 = await callRoute("/musage/login", "POST", "/musage/login?action=start&provider=xiaomi");
  assert.equal(r1.body.ok, true);
  const snap = await waitState(reachedWaitOrTerminal, 45000);
  assert.equal(snap.state, "waiting", JSON.stringify(snap));
  // 模拟用户直接关闭浏览器窗口
  for (const c of children) { try { c.kill(); } catch (e) {} }
  const snap2 = await waitState((s) => s && s.state === "cancelled", 20000);
  assert.equal(snap2.state, "cancelled", JSON.stringify(snap2));
  assert.equal(snap2.active, false);
});

test("编排: 参数校验 / cancel 幂等 / dispose 清理", { timeout: 30000 }, async () => {
  const rBad = await callRoute("/musage/login", "POST", "/musage/login?action=start&provider=deepseek");
  assert.equal(rBad.status, 400);
  assert.equal(rBad.body.ok, false);

  const rCancel = await callRoute("/musage/login", "POST", "/musage/login?action=cancel");
  assert.equal(rCancel.body.ok, false, "无进行中会话时 cancel 应返回 ok:false");

  const rStatus = await callRoute("/musage/login/status", "GET", "/musage/login/status");
  assert.equal(rStatus.status, 200);
  assert.ok(rStatus.body.login, "status 应始终返回 login 快照");

  // dispose（插件卸载/重载路径）不应抛错、不应留下进程
  for (const d of disposers) { try { d(); } catch (e) {} }
  await sleep(1500);
  assert.equal(children.size, 0, "dispose 后不应有浏览器进程残留");
});
