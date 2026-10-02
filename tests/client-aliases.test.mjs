// tests/client-aliases.test.mjs — client 半边 route→provider 别名映射单测（node:test）
//
// 背景（2026-10 修复）：DSH pi-ai 内置的小米 provider 家族是
// xiaomi-token-plan-{ams,cn,sgp}（另有 api.xiaomimimo.com 的 xiaomi），
// 旧别名表只有短名（xiaomi / mimo / …），用户在 MiMo-V2.6 会话中卡片
// 显示"未选中支持的 provider（provider=xiaomi-token-pla…）"。
//
// 运行: node --test tests/client-aliases.test.mjs

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

const { readActiveProvider, PROVIDER_ALIASES } = mod.__test;

test("xiaomi-token-plan-ams → xiaomi（DSH 内置小米三区之一）", () => {
  assert.equal(readActiveProvider({ current: { provider: "xiaomi-token-plan-ams" } }), "xiaomi");
});

test("xiaomi-token-plan-cn → xiaomi", () => {
  assert.equal(readActiveProvider({ current: { provider: "xiaomi-token-plan-cn" } }), "xiaomi");
});

test("xiaomi-token-plan-sgp → xiaomi", () => {
  assert.equal(readActiveProvider({ current: { provider: "xiaomi-token-plan-sgp" } }), "xiaomi");
});

test("MiMo 短名保持映射", () => {
  assert.equal(readActiveProvider({ current: { provider: "mimo" } }), "xiaomi");
  assert.equal(readActiveProvider({ current: { provider: "xiaomi" } }), "xiaomi");
  assert.equal(readActiveProvider({ current: { provider: "xiaomimimo" } }), "xiaomi");
});

test("modlens 包装剥壳后同样命中（modlens-xiaomi-token-plan-ams）", () => {
  assert.equal(readActiveProvider({ current: { provider: "modlens-xiaomi-token-plan-ams" } }), "xiaomi");
});

test("deepseek-account → deepseek（DSH 内置「DeepSeek Account」登录 provider；2026-10-02 实机）", () => {
  assert.equal(readActiveProvider({ current: { provider: "deepseek-account" } }), "deepseek");
  // modlens 包装同样可剥壳命中
  assert.equal(readActiveProvider({ current: { provider: "modlens-deepseek-account" } }), "deepseek");
});

test("回归：既有别名不受影响", () => {
  assert.equal(readActiveProvider({ current: { provider: "zai-coding-cn" } }), "zhipu");
  assert.equal(readActiveProvider({ current: { provider: "stepfun-plan" } }), "stepfun");
  assert.equal(readActiveProvider({ current: { provider: "deepseek-modlens" } }), "deepseek");
});
