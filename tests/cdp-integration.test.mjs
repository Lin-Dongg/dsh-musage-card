// tests/cdp-integration.test.mjs — 登录助手 CDP 集成测试（真实浏览器）
//
// 运行: node --test tests/cdp-integration.test.mjs
// 覆盖: DevToolsActivePort 端口发现 → /json 列 targets → ws 一问一答
//       → Network.setCookie → Network.getCookies（HttpOnly 也可读）
//       → joinCookieHeader/extractLoginCookie 与返回值形态兼容。
// 依赖本机 Edge/Chrome；找不到浏览器时自动 skip（不算失败）。
// 注意: 本测试用 node:child_process 直接拉起 headless 浏览器（生产走
//       ctx.subprocess 服务）——被验证的是两侧共享的 dsh/index.js CDP 层。

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __login as L } from "../dsh/index.js";

function findBrowser() {
  try {
    const list = L.pickBrowserCandidates(process.platform, undefined, process.env);
    return list.length > 0 ? list[0] : null;
  } catch (e) {
    return null;
  }
}

test("CDP 全链路: 启动 → 读 HttpOnly cookie → 拼接层兼容", { timeout: 120000 }, async (t) => {
  const exe = findBrowser();
  if (!exe) {
    t.skip("本机未找到 Edge/Chrome，跳过 CDP 集成测试");
    return;
  }

  const profileDir = await mkdtemp(join(tmpdir(), "musage-cdp-test-"));
  const child = spawn(exe, [
    "--headless=new",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profileDir,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: "ignore" });

  let sess = null;
  try {
    // 1) 端口发现：浏览器把实际端口写入 DevToolsActivePort（生产同款函数）
    const port = await L.cdp.readDevToolsPort(profileDir, 30000);
    assert.ok(port > 0, "DevToolsActivePort 应给出有效端口");

    // 2) 列 targets → 页面 ws
    const targets = await L.cdp.cdpListTargets(port);
    const wsUrl = L.cdp.pickPageWsUrl(targets);
    assert.ok(wsUrl, "应能找到一个 page target 的 ws url");

    // 3) browser 级 ws 可取（Browser.close 通道）
    const browserWs = await L.cdp.cdpBrowserWsUrl(port);
    assert.ok(browserWs, "应能取得 browser 级 ws url");

    // 4) 连接 + setCookie(httpOnly) → getCookies 读回
    const ws = await L.cdp.cdpOpenWs(wsUrl, 10000);
    sess = L.cdp.cdpSession(ws);
    const setRes = await sess.call("Network.setCookie", {
      name: "probe",
      value: "hello-httpOnly",
      url: "https://example.com",
      httpOnly: true,
      secure: true,
    });
    assert.equal(setRes.success, true, "setCookie 应成功");

    const cookies = await L.cdp.cdpGetCookies(sess, ["https://example.com"]);
    const probe = cookies.find((c) => c.name === "probe");
    assert.ok(probe, "getCookies 应包含 probe");
    // 关键断言：HttpOnly cookie 的值可读——这正是普通页面脚本拿不到、
    // 用户只能 F12 手工复制的那部分。
    assert.equal(probe.value, "hello-httpOnly");
    assert.equal(probe.httpOnly, true);

    // 5) 返回值与拼接层兼容（登录成功判定同款消费路径）
    const header = L.joinCookieHeader(cookies);
    assert.ok(String(header).includes("probe=hello-httpOnly"), "拼接结果应含 probe 键值");

    // 6) 数据形态与提取规则兼容：无 sessionKey 时 claude 规则不应误取
    assert.equal(L.extractLoginCookie("claude", cookies), null);
    // xiaomi 规则应全量拼接
    assert.equal(L.extractLoginCookie("xiaomi", cookies), header);
  } finally {
    if (sess) sess.close();
    try { child.kill(); } catch (e) {}
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
});

test("CDP: Browser.close 优雅关闭（Browser.close 通道可用性）", { timeout: 120000 }, async (t) => {
  const exe = findBrowser();
  if (!exe) {
    t.skip("本机未找到 Edge/Chrome，跳过 CDP 集成测试");
    return;
  }

  const profileDir = await mkdtemp(join(tmpdir(), "musage-cdp-close-"));
  const child = spawn(exe, [
    "--headless=new",
    "--remote-debugging-port=0",
    "--user-data-dir=" + profileDir,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: "ignore" });

  let exited = false;
  child.on("exit", () => { exited = true; });
  try {
    const port = await L.cdp.readDevToolsPort(profileDir, 30000);
    const browserWs = await L.cdp.cdpBrowserWsUrl(port);
    assert.ok(browserWs, "应能取得 browser 级 ws url");

    const ws = await L.cdp.cdpOpenWs(browserWs, 10000);
    ws.send(JSON.stringify({ id: 1, method: "Browser.close", params: {} }));
    // 等浏览器自行退出（生产 closeBrowserForSession 的优雅路径同款）。
    // 30s 上限：本用例与 session-orchestration 在同一全量套件里并发跑，
    // 多台 headless 浏览器竞争 CPU 时退出会明显变慢（单跑实测 1-2s；
    // 并发下曾观测到 >15s 的偶发——非功能缺陷，见 2026-10-01 flaky 记录）。
    const deadline = Date.now() + 30000;
    while (!exited && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(exited, true, "Browser.close 后浏览器应自行退出");
  } finally {
    try { child.kill(); } catch (e) {}
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
});
