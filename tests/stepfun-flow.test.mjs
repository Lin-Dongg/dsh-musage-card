// tests/stepfun-flow.test.mjs — StepFun 卡片渲染仿真（oasis 数据行 / 登录引导）
//
// 运行: node --test tests/stepfun-flow.test.mjs
// 背景（2026-10-01）: StepFun 接入「点击卡片登录读取 Step Plan Credit」——
//   host 在账户总览数据（display.oasis）可得时附加数据、不可得时附 loginAssist
//   引导登录; client 在余额型分支渲染对应行。本测试固化这三条渲染路径。
// 设施与 mimo-flow.test.mjs 相同（fake React + hooks preset + 注册捕获）。

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const CLIENT = new URL("../dsh/client.js", import.meta.url);
const src = fs.readFileSync(CLIENT, "utf8");
let captured = null;
new Function("window", "document", src)({ __ModuleLoader__: { load: (d) => { captured = d; } } }, undefined);

let hookStates = [];
let effects = [];
let hookIndex = 0;
const fakeReact = {
  createElement: (type, props, ...children) => ({ __el: type, props, children }),
  useState: (init) => {
    const i = hookIndex++;
    if (hookStates[i] === undefined) hookStates[i] = typeof init === "function" ? init() : init;
    const setter = (v) => { hookStates[i] = typeof v === "function" ? v(hookStates[i]) : v; };
    return [hookStates[i], setter];
  },
  useEffect: (fn) => { const i = hookIndex++; effects[i] = fn; },
};

const mod = captured.factory((id) => {
  if (id === "react") return fakeReact;
  throw new Error("unexpected require: " + id);
});

let reg = null;
const slotsFake = {
  inject: (name, fn) => { const g = fn(); if (g && typeof g.next === "function") g.next(); },
  register: (opts, comp) => { reg = { opts, comp }; },
};
const ctx = {
  slots: slotsFake,
  timer: { interval: () => () => {}, timeout: () => {} },
  modelDirectories: { directoryFor: () => null },
  inject: (deps, cb) => cb({ uiSession: null, slots: slotsFake }),
};
mod.apply(ctx);
assert.ok(reg, "卡片未注册");

// hooks 顺序（QuotaCard, 2026-10-01 后）:
//   0=useState(sessionId) 1=useEffect 2=useState(provider) 3=useState(rawProvider)
//   4=useEffect 5=useState(state) 6=useState(retrySeq) 7=useState(login)
//   8=useEffect(quota) 9=useEffect(login poll)
function preset(states) {
  hookStates = states;
  hookIndex = 0;
  effects = [];
}

const READY_OASIS = {
  credit: 0, voucher: 5.96, voucherApi: 5.96, voucherPlan: 0,
  payment: 0, balance: 5.96, costYesterday: 4.57, costMonth: 4.47,
};

test("stepfun: oasis 已连接 → 简化布局（💰 余额+消费合并行），无重复明细", () => {
  preset([
    "s1", undefined,
    "stepfun", "stepfun", undefined,
    { ok: true, loaded: true, kind: "ok", message: null, display: {
      balanceUsd: 12, balanceText: "¥12.00", balanceLabel: "余额",
      balanceDetail: "现金 ¥10.00 · 代金券 ¥2.00",
      oasis: { balance: 5.96, costYesterday: 4.57, costMonth: 4.47, voucher: 5.96 },
      planNote: "Step Plan Credit 用量仅官网可查",
    } },
    0,
    { active: false, state: "idle" },
    undefined, undefined,
  ]);
  const flat = JSON.stringify(reg.comp({ wide: true }));
  assert.ok(flat.includes("💰 余额 ¥5.96"), "应渲染合并钱包行（oasis 余额）");
  assert.ok(flat.includes("昨 ¥4.57"), "应含昨日消费");
  assert.ok(flat.includes("本月 ¥4.47"), "应含本月消费");
  assert.ok(!flat.includes("🔑"), "oasis 已连接时不应出现登录引导");
  // 简化后不再渲染: 🧾 明细行 / Plan ¥ 明细 / 大字余额行（2026-10-01 用户指定）
  assert.ok(!flat.includes("🧾"), "oasis 明细行已并入钱包行");
  assert.ok(!flat.includes("Plan ¥"), "Plan ¥ 明细应已去除");
  assert.ok(!flat.includes("💰 余额 ¥12.00"), "oasis 在时不应回落通用 balanceText");
  // 注意: 卡片 tooltip（quotaTitle）会 JSON dump 整个 display——以渲染行特征串判定
  assert.ok(!flat.includes("Step Plan (Token Plan) 未连接"), "不应回落渲染 planNote 行");
});

test("stepfun: 缺 oasis + host 附 loginAssist → 登录引导行（取代 planNote）", () => {
  preset([
    "s1", undefined,
    "stepfun", "stepfun", undefined,
    { ok: true, loaded: true, kind: "ok", message: null,
      loginAssist: { supported: true, ref: "STEPFUN_COOKIE" },
      display: { balanceUsd: 12, balanceText: "¥12.00", planNote: "Step Plan Credit 用量仅官网可查" } },
    0,
    { active: false, state: "idle" },
    undefined, undefined,
  ]);
  const flat = JSON.stringify(reg.comp({ wide: true }));
  assert.ok(flat.includes("🔑 点击卡片登录读取 Step Plan Credit"), "应渲染登录引导");
  // 同上前提: 以渲染行特征串判定（tooltip dump 含 planNote 字段属预期）
  assert.ok(!flat.includes("Step Plan (Token Plan) 未连接"), "登录引导应取代 planNote 渲染行");
});

test("stepfun: 登录进行中 → 🔓 状态行", () => {
  preset([
    "s1", undefined,
    "stepfun", "stepfun", undefined,
    { ok: true, loaded: true, kind: "ok", message: null,
      loginAssist: { supported: true, ref: "STEPFUN_COOKIE" },
      display: { balanceText: "¥12.00" } },
    0,
    { active: true, state: "waiting", message: "已打开浏览器，请在页面中完成登录…" },
    undefined, undefined,
  ]);
  const flat = JSON.stringify(reg.comp({ wide: true }));
  assert.ok(flat.includes("🔓"), "登录中应显示 🔓 行");
  assert.ok(flat.includes("请在页面中完成登录"), "应带 host 侧 message");
});

test("stepfun: 缺 oasis 且 host 未附 loginAssist → 回落 planNote（防御路径）", () => {
  preset([
    "s1", undefined,
    "stepfun", "stepfun", undefined,
    { ok: true, loaded: true, kind: "ok", message: null,
      display: { balanceText: "¥12.00", planNote: "Step Plan Credit 未连接" } },
    0,
    { active: false, state: "idle" },
    undefined, undefined,
  ]);
  const flat = JSON.stringify(reg.comp({ wide: true }));
  assert.ok(flat.includes("Step Plan Credit 未连接"), "无登录入口时应回落 planNote");
});

test("stepfun: coding plan 额度行（置顶）→ Credit 百分比 + 套餐 / 亿 / 重置", () => {
  preset([
    "s1", undefined,
    "stepfun", "stepfun", undefined,
    { ok: true, loaded: true, kind: "ok", message: null, display: {
      balanceUsd: 12, balanceText: "¥12.00", balanceLabel: "余额",
      stepfunPlan: {
        name: "Plus", active: true, autoRenew: false,
        creditLeftRate: 0.9556,
        creditResidual: 1528873224, creditTotal: 1600000000,
        creditResetIn: "477h36m 重置",
      },
      oasis: READY_OASIS,
    } },
    0,
    { active: false, state: "idle" },
    undefined, undefined,
  ]);
  const flat = JSON.stringify(reg.comp({ wide: true }));
  assert.ok(flat.includes("planCredit"), "应有 planCredit 行");
  assert.ok(flat.includes("Credit"), "行键应为 Credit");
  assert.ok(flat.includes("dsh-musage-card__fill--rainbow"), "无 5h 窗口额度应为紫色流动条（2026-10-01 用户指定）");
  assert.ok(flat.includes("96%"), "剩余率 0.9556 → 96%");
  assert.ok(flat.includes("Plus 套餐"), "应含套餐名");
  assert.ok(flat.includes("重置 19d21h"), "477h36m → compact 19d21h");
  // 额度绝对值已挪进 tooltip（视觉简化）
  assert.ok(!flat.includes("15.3/16.0亿"), "亿明细不应直接渲染（已挪入 title）");
});
