// tests/client-login.test.mjs — client 半边登录交互决策单测（node:test）
//
// 运行: node --test tests/client-login.test.mjs
// 覆盖: 点击分发（登录中 noop / 可登录 login / 其余 refresh）、
//       affordance 判定（仅失败态+loginAssist.supported）、
//       失败态登录文案选择（active/success/affordance/null）。
// 加载方式与 client-aliases.test.mjs 相同: 捕获 __ModuleLoader__ 定义,
// 用 mock react 执行 factory 后取 __test 出口。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const CLIENT = new URL("../dsh/client.js", import.meta.url);
const src = fs.readFileSync(CLIENT, "utf8");
let captured = null;
const fakeWindow = { __ModuleLoader__: { load: (def) => { captured = def; } } };
new Function("window", "document", src)(fakeWindow, undefined);

const mod = captured.factory((id) => {
  if (id === "react") {
    return { createElement: () => null, useState: (v) => [typeof v === "function" ? v() : v, () => {}], useEffect: () => {} };
  }
  throw new Error("unexpected require: " + id);
});

const { canLoginAssistFor, decideCardClick, loginNoteFor } = mod.__test;

// ───────────────────────── canLoginAssistFor ─────────────────────────

test("canLoginAssistFor: 以 host 附着为唯一事实源（含 stepfun 成功态）", () => {
  assert.equal(canLoginAssistFor({ loaded: true, ok: false, loginAssist: { supported: true } }), true);   // 失败态
  assert.equal(canLoginAssistFor({ loaded: true, ok: true, loginAssist: { supported: true } }), true);    // stepfun 成功态缺 oasis（host 主动附着）
  assert.equal(canLoginAssistFor({ loaded: true, ok: false }), false);                                    // host 未标记
  assert.equal(canLoginAssistFor({ loaded: true, ok: true }), false);                                     // 正常态且 host 未标记
  assert.equal(canLoginAssistFor({ loaded: true, ok: false, loginAssist: { supported: false } }), false);
  assert.equal(canLoginAssistFor({ loaded: false, ok: false, loginAssist: { supported: true } }), false); // 加载中
  assert.equal(canLoginAssistFor(null), false);
});

// ───────────────────────── decideCardClick ─────────────────────────

test("decideCardClick: 登录中 → noop（忽略重复点击）", () => {
  assert.equal(decideCardClick({ loginActive: true, canLoginAssist: true }), "noop");
  assert.equal(decideCardClick({ loginActive: true, canLoginAssist: false }), "noop");
});

test("decideCardClick: 可登录 → login（发起登录助手）", () => {
  assert.equal(decideCardClick({ loginActive: false, canLoginAssist: true }), "login");
});

test("decideCardClick: 其余 → refresh（维持原有手动刷新行为）", () => {
  assert.equal(decideCardClick({ loginActive: false, canLoginAssist: false }), "refresh");
  assert.equal(decideCardClick(null), "refresh");
  assert.equal(decideCardClick(undefined), "refresh");
});

// ───────────────────────── loginNoteFor ─────────────────────────

test("loginNoteFor: 登录中 → active 文案（带 host 侧 message）", () => {
  const n = loginNoteFor("xiaomi", { loaded: true, ok: false }, {
    active: true, state: "waiting", message: "已打开浏览器，请在页面中完成登录…",
  });
  assert.equal(n.kind, "active");
  assert.ok(n.text.includes("🔓"));
  assert.ok(n.text.includes("请在页面中完成登录"));
});

test("loginNoteFor: 登录中无 message → 兜底文案", () => {
  const n = loginNoteFor("claude", { loaded: true, ok: false }, { active: true, state: "starting" });
  assert.equal(n.kind, "active");
  assert.ok(n.text.includes("完成登录后自动生效"));
});

test("loginNoteFor: 刚成功（quota 刷新前过渡）→ success 文案", () => {
  const n = loginNoteFor("xiaomi", { loaded: true, ok: false }, { active: false, state: "success" });
  assert.equal(n.kind, "success");
  assert.ok(n.text.includes("✓"));
});

test("loginNoteFor: 可登录失败态 → affordance 文案（含 provider 标签）", () => {
  const n = loginNoteFor("xiaomi", {
    loaded: true, ok: false, message: "HTTP 401 · …", loginAssist: { supported: true },
  }, { active: false, state: "idle" });
  assert.equal(n.kind, "affordance");
  assert.ok(n.text.includes("🔑"));
  assert.ok(n.text.includes("MiMo"), "应带 provider 显示名");
  assert.ok(n.title.includes("HTTP 401"), "tooltip 应保留原始失败信息");
});

test("loginNoteFor: failed 会话 message 附到 affordance 尾部（可见错误原因）", () => {
  const n = loginNoteFor("claude", {
    loaded: true, ok: false, loginAssist: { supported: true },
  }, { active: false, state: "failed", message: "未找到 Edge / Chrome（自动登录需要其中一个浏览器）" });
  assert.equal(n.kind, "affordance");
  assert.ok(n.text.includes("未找到 Edge"), "失败原因应展示给用户");
});

test("loginNoteFor: cancelled/timeout 同理保持可重试（affordance）", () => {
  const n1 = loginNoteFor("xiaomi", { loaded: true, ok: false, loginAssist: { supported: true } },
    { active: false, state: "cancelled", message: "已取消登录" });
  assert.equal(n1.kind, "affordance");
  const n2 = loginNoteFor("xiaomi", { loaded: true, ok: false, loginAssist: { supported: true } },
    { active: false, state: "timeout", message: "登录超时（30 分钟）" });
  assert.equal(n2.kind, "affordance");
});

test("loginNoteFor: 正常态 / 非登录 provider → null（走原失败/正常渲染）", () => {
  assert.equal(loginNoteFor("xiaomi", { loaded: true, ok: true }, { active: false, state: "idle" }), null);
  assert.equal(loginNoteFor("deepseek", { loaded: true, ok: false }, { active: false, state: "idle" }), null);
  assert.equal(loginNoteFor("xiaomi", { loaded: false, ok: false }, { active: false, state: "idle" }), null);
});

test("loginNoteFor: stepfun 成功态缺 oasis（host 附着）→ affordance（引导读取 Credit）", () => {
  const n = loginNoteFor("stepfun", { loaded: true, ok: true, loginAssist: { supported: true } }, { active: false, state: "idle" });
  assert.equal(n.kind, "affordance");
  assert.ok(n.text.includes("StepFun"), "应带 provider 显示名");
});

test("loginNoteFor: login 缺省（undefined）按 idle 处理", () => {
  const n = loginNoteFor("xiaomi", { loaded: true, ok: false, loginAssist: { supported: true } }, undefined);
  assert.equal(n.kind, "affordance");
});
