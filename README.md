# dsh-musage-card（本地 fork，v1.0.0）

`dsh-musage` 的本地二次开发版 —— **不发布到任何 registry，通过 `file:` 依赖安装**，
插件市场永远不会覆盖它。

## 与上游 dsh-musage 0.1.1 的差异

- 注册点：`conversation.input.right`（composer 内联文字）→ `sidebar.footer.action`
  （左下角侧边栏 footer，"移动访问"按钮上方，order -100）
- 卡片化：半透明玻璃材质（backdrop-filter blur + 高光描边），明暗主题通用
- 剩余量倒数显示：已用% → 剩余% = 100 − 已用%（数值与进度条填充均为剩余量）
- 流动进度条：5h 流动绿、7d 流动彩（prefers-reduced-motion 自动停用）
- 会话来源：sidebar slot 无 sessionId，改订阅 `sessions.list` 的 current
- 点击卡片立即刷新（60s 定时刷新保留）
- host 半边（`dsh/index.js`）与上游完全一致，未做任何修改

## v1.1.0：新增 StepFun 支持

- Host（`dsh/index.js`）：新增 `stepfun` provider，走官方
  `GET https://api.stepfun.com/v1/accounts`，展示按量余额（CNY，
  含现金 / 代金券细分），复用 DSH 模型设置里的 `STEPFUN_API_KEY`。
- Client（`dsh/client.js`）：`stepfun` / `stepfun-plan` route id 均映射到
  stepfun，余额型卡片附加一行 "Step Plan Credit 用量仅官网可查"。
- **已知边界**：Step Plan（Token Plan）的 Credit 用量（官网
  account-overview 顶部进度条）没有 API-Key 认证的查询端点——官网走
  Connect RPC + 网页登录态。实测（2026-09-22）`step_plan/v1` 下的
  `usages` / `usage` / `quota` / `credits` / `subscription` / `balance`
  与 `/v1/credits`、`/v1/subscription` 全部 404，chat 响应头亦无用量
  字段。若将来 StepFun 开放端点，改 `PROVIDERS.stepfun.urls` 即可。

## 安装方式（已是安装状态，此处仅记录）

```jsonc
// C:\Users\25958\.dsh\profiles\desktop\package.json
{
  "dsh": { "profile": { "bundles": [ /* ..., "dsh-musage-card"（替代 dsh-musage） */ ] } },
  "dependencies": {
    "dsh-musage-card": "file:C:/Users/25958/.dsh/local-plugins/dsh-musage-card"
  }
}
```

然后在 profile 目录执行 `pnpm install`。

## 源码与文档

- 开发说明 / 迭代记录：`D:\deepseek工作区\musage-plugin-dev\开发说明.md`
- 上游原版备份：`D:\deepseek工作区\musage-plugin-dev\backup-dsh-musage-v0.1.1\`

> 注意：若将来在插件市场再次安装官方 `dsh-musage`，两者会同时挂载
> （insert id 不同：musage-card vs musage），出现重复卡片时卸载官方版即可。
