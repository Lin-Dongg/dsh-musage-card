// tests/stepfun-oasis.test.mjs — StepFun 账户总览接口契约（在线探测，无浏览器）
//
// 运行: node --test tests/stepfun-oasis.test.mjs
// 背景: 登录助手读取 Step Plan Credit 依赖该接口（2026-10-01 逆向自官网 bundle）:
//   POST https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryAccountBalance
//   Connect-JSON 协议; 未认证 → 401 {"code":"unauthenticated"}。
// 本测试在无登录态下探测「端点存活 + 协议形状」——端点若变更/下线, 本测试报警。
// 网络不可达时自动 skip（不算失败）。

import { test } from "node:test";
import assert from "node:assert/strict";

const OASIS_URL = "https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard/QueryAccountBalance";

test("stepfun oasis 契约: 端点存活且未认证返回 Connect 401", { timeout: 30000 }, async (t) => {
  let res;
  try {
    res = await fetch(OASIS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "connect-protocol-version": "1",
        accept: "application/json",
      },
      body: JSON.stringify({ bizType: 1 }),
    });
  } catch (e) {
    t.skip("网络不可达，跳过在线契约测试");
    return;
  }
  assert.equal(res.status, 401, "未认证应返回 401（端点/协议若变更本测试报警）");
  const j = await res.json();
  assert.ok(j && typeof j === "object");
  assert.equal(j.code, "unauthenticated");
});
