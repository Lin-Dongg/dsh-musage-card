// tests/mimo-flow.test.mjs — 用户场景回归：MiMo 会话 → 卡片渲染三行
//
// 背景（2026-10）：DSH 内置小米 provider id 为 xiaomi-token-plan-{ams,cn,sgp}；
// 用户报告 MiMo 模型下卡片显示"未选中支持的 provider"。route→别名链路
// 由 client-aliases.test.mjs 覆盖；本测试把后半段"已解析 provider=xiaomi +
// 已加载 pctRows → 渲染树出现 MiMo 抬头与 月总额/补偿 行"固化为回归
// （2026-10-01：套餐行与月总额合并；无 5h 窗口额度统一紫色流动条）。
//
// 运行: node --test tests/mimo-flow.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const CLIENT = new URL("../dsh/client.js", import.meta.url);
const src = fs.readFileSync(CLIENT, "utf8");
let captured = null;
new Function("window", "document", src)({ __ModuleLoader__: { load: (d) => { captured = d; } } }, undefined);

// 位置敏感 fake React（可预置 hookStates 模拟"订阅已回填"的稳态）
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

// 捕获卡片注册（与生产装配路径一致：scoped inject("uiSession") → slots.inject → register）
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
assert.equal(reg.opts.name, "sidebar.footer.action");

// hooks 顺序（QuotaCard）: 0=useState(sessionId) 1=useEffect 2=useState(provider)
//                          3=useState(rawProvider) 4=useEffect 5=useState(state)
//                          6=useState(retrySeq) 7=useEffect
function preset(states) {
  hookStates = states;
  hookIndex = 0;
  effects = [];
}

test("MiMo 会话（provider=xiaomi + pctRows）→ 卡片渲染 MiMo 三行", () => {
  preset([
    "s1", undefined,
    "xiaomi", "xiaomi-token-plan-ams", undefined,
    { ok: true, loaded: true, kind: "ok", message: null, display: { pctRows: [
      { label: "月总额", pct: 60, tone: "rainbow" },
      { label: "补偿", pct: 10, tone: "plain" },
    ] } },
    0, undefined,
  ]);
  const tree = reg.comp({ wide: true });
  const flat = JSON.stringify(tree);
  assert.ok(flat.includes("MiMo"), "抬头应为 MiMo（providerLabel(xiaomi)）");
  assert.ok(flat.includes("补偿"), "缺补偿行");
  assert.ok(flat.includes("月总额"), "缺月总额行");
  assert.ok(flat.includes("90%"), "补偿剩余量 = 100-10");
  assert.ok(flat.includes("40%"), "月总额剩余量 = 100-60");
  // 套餐行已与月总额合并（2026-10-01）——渲染树不应再出现"套餐"
  assert.ok(!flat.includes("套餐"), "套餐行应已合并进月总额");
});

test("MiMo rail 形态（侧栏收起）→ 缩写 + 主指标剩余%", () => {
  preset([
    "s1", undefined,
    "xiaomi", "xiaomi-token-plan-ams", undefined,
    { ok: true, loaded: true, kind: "ok", message: null, display: { pctRows: [
      { label: "月总额", pct: 30, tone: "rainbow" },
    ] } },
    0, undefined,
  ]);
  const tree = reg.comp({ wide: false });
  const flat = JSON.stringify(tree);
  assert.ok(flat.includes("MiMo"), "rail 缩写应为 MiMo");
  assert.ok(flat.includes("70%"), "rail 取第一行（主指标）剩余%");
});

test("未支持 provider 的会话 → 仍显示占位诊断（负向回归）", () => {
  preset([
    "s1", undefined,
    null, "some-unknown-route", undefined,
    { ok: false, loaded: true, kind: "other", message: null, display: null },
    0, undefined,
  ]);
  const tree = reg.comp({ wide: true });
  const flat = JSON.stringify(tree);
  assert.ok(flat.includes("未选中支持的 provider"), "应显示占位");
  assert.ok(flat.includes("some-unknown-route"), "诊断应带原 route");
});
