# dsh-musage-card

`dsh-musage` 的本地二次开发版 —— 挂在 **DSH 侧边栏底部（"移动访问"按钮上方）** 的多 provider
用量/余额玻璃卡片：跟随当前会话选中的模型**自动切换**，剩余量进度条（5h 流动绿 / 7d 流动彩）。

**不发布到任何 registry**，通过 `file:` 依赖或手动放置安装，插件市场的更新永远不会覆盖它。

## 支持的 Provider（11 家）

| Provider（DSH route id 变体） | 显示 | 端点 | 凭据 |
|---|---|---|---|
| `minimax` / `minimax-cn` / `minimax-en` | 5h / 7d 双窗口 | `api.minimaxi.com/v1/api/openplatform/coding_plan/remains` | `MINIMAX_CN_API_KEY` 等 |
| `deepseek` / `deepseek-official` | 余额（¥ / $） | `api.deepseek.com/user/balance` | `DEEPSEEK_API_KEY` |
| `kimi` / `kimi-coding` | 5h / 7d 双窗口 | `api.kimi.com/coding/v1/usages` | `KIMI_CODING_API_KEY` |
| `zhipu` / `zai-coding-cn` | 5h / 7d 双窗口 | `open.bigmodel.cn/api/monitor/usage/quota/limit` | `ZAI_CODING_CN_API_KEY` |
| `openrouter` | 余额（$） | `openrouter.ai/api/v1/credits` | `OPENROUTER_API_KEY` |
| `stepfun` / `stepfun-plan` | 余额（¥，现金/券细分） | `api.stepfun.com/v1/accounts` | `STEPFUN_API_KEY` |
| `siliconflow` / `siliconflow-cn` | 余额（¥，充值/总额细分） | `api.siliconflow.cn/v1/user/info` | `SILICONFLOW_API_KEY` |
| `tavily` | 已用 / 总量 credits + 明细 | `api.tavily.com/usage` | `TAVILY_API_KEY` |
| `zenmux` | PAYG 余额（$，充值/奖励细分） | `zenmux.ai/api/v1/management/payg/balance` | `ZENMUX_MANAGEMENT_API_KEY`（`sk-mg-v1-`） |
| `xiaomi-token-plan-{ams,cn,sgp}` / `xiaomi` / `mimo` … | 套餐 / 补偿 / 月总额 三行 | `platform.xiaomimimo.com/api/v1/tokenPlan/usage` | **浏览器 Cookie**（key 实测被 401，自动退 Cookie；见下） |
| `claude` / `anthropic` / `claude-code` | 5h / 7d 双窗口 | `api.anthropic.com/api/oauth/usage` | **sessionKey Cookie**（见下） |

> `modlens-<provider>` 视觉包装路由会自动剥壳后映射到上游 provider。

## 凭据怎么配

- **API Key 类（前 9 家）**：复用 DSH 模型设置里已配的 provider key
  （DSH 规范：`<PROVIDER 大写去特殊字符>_API_KEY`），无需重复填写。
- **小米 MiMo**：**需要浏览器登录态 Cookie**（2026-10 实机：Token Plan API key 走 Bearer 会被
  dashboard 端点 401 + loginUrl 拒绝；若命中了 key，插件会自动退 Cookie 重试一次）。获取：
  登录 `platform.xiaomimimo.com` → F12 → Network → 任一 `/api/v1/tokenPlan/*` 请求 →
  复制**完整 Cookie header 值**，存入 ref `XIAOMI_MIMO_COOKIE`。
- **Claude**：从 `claude.ai` 取 `sessionKey` cookie 值，存入 ref `CLAUDE_SESSION_KEY`
  （官方 OAuth 用量端点，插件自动带 `Anthropic-Beta: oauth-2025-04-20` 与 `claude-code` UA）。
- **Cookie 的存入方式**（MiMo 兜底、Claude 必需）：编辑 `~/.dsh/.credentials.yaml` 追加一行
  即可 —— DSH 凭据存储**会观察外部编辑并热生效**（不需要重启；值请用引号包裹）：

  ```yaml
  # ~/.dsh/.credentials.yaml（示例；与现有内容合并，勿覆盖）
  XIAOMI_MIMO_COOKIE: "api-platform_serviceToken=...; userId=...; api-platform_slh=...; api-platform_ph=..."
  CLAUDE_SESSION_KEY: "sk-ant-sid01-..."
  ```

- Cookie 会过期（Claude 约 8 小时、MiMo 随登出失效）：卡片显示 ⚠ 时重新复制一次即可。

## 与上游 dsh-musage 的差异

- 注册点：`conversation.input.right`（composer 内联）→ **`sidebar.footer.action`**
  （左下角侧边栏 footer，"移动访问"按钮上方，order -100）
- 卡片化：半透明玻璃材质（backdrop-filter blur + 高光描边），明暗主题通用
- 剩余量倒数显示：已用% → 剩余% = 100 − 已用%（数值与进度条填充均为剩余量）
- 流动进度条：5h 流动绿、7d 流动彩、通用行灰蓝（prefers-reduced-motion 自动停用）
- 会话来源：订阅 `uiSession` 服务的 current binding（主视图会话）——见 v1.3.0
- 点击卡片立即刷新（60s 定时刷新保留）
- host 半边已扩展为 11 家（上游 5 家）

## 变更记录

### v1.4.0（2026-10）新增 5 家 provider

- **Host（`dsh/index.js`）**：新增 `siliconflow` / `tavily` / `zenmux` / `xiaomi` / `claude`
  五家 PROVIDERS 条目与解析器（schema 对齐 [Musage](https://github.com/Thedeergod666/Musage)
  同名实现）；`curlFetch` 增加 `cookie`（整段 Cookie header）与 `claude`
  （sessionKey + beta header + UA）两种鉴权形态。
- **Client（`dsh/client.js`）**：新增各家 route 别名与标签；新增通用百分比行
  `pctRows` 渲染（MiMo 的 套餐/补偿/月总额 三行）；余额行标签可定制（Tavily 显示"用量"）。
- **测试**：新增 `tests/parsers.test.mjs`（node:test，21 用例——5 家新 provider 的
  正常/缺失/业务错误路径 + 既有家回归）。`node --test tests/parsers.test.mjs`。

### v1.3.0（2026-10）注册点回归侧边栏（修正 v1.2.19 误判）

- 注册点：`conversation.input.right` → **回归 `sidebar.footer.action`**（root 作用域，
  "移动访问"按钮上方，order -100）。v1.2.19 曾在 sidebar 上误判"root 拿不到当前会话"
  （只翻了 sessions store 快照找 `current` 字段）而把卡片临时挪到输入框旁——位置不对。
- 会话来源：`uiSession` 服务的 current binding（`dsh-client-ui-session` 的
  `UiSession.publishMain`：优先保持上一次有效选择，否则取 `retainedBy.mainView>0`
  的主视图会话；无会话时 `props.sessionId` 为 undefined）。用 scoped
  `ctx.inject(["uiSession"], …)` 等服务就绪后注册，服务缺失时卡片占位不崩。
  （root 作用域拿当前会话的另一条通道：`useSessions` + `retainedBy.mainView` 推导——
  官方 layout 包 `DocumentTitle` 同款模式；详见 `dsh/client.js` 头注释第 5 条。）
- CSS：恢复 `[data-slot="sidebar.footer.action"]` 垂直 flex 列覆盖（卡片在按钮上方）。

### v1.1.0（2026-09）新增 StepFun 支持

- Host：新增 `stepfun` provider，走 `GET https://api.stepfun.com/v1/accounts`，
  展示按量余额（CNY，含现金 / 代金券细分），复用 `STEPFUN_API_KEY`。
- **已知边界**：Step Plan（Token Plan）的 Credit 用量没有 API-Key 认证的查询端点
  （实测 2026-09-22：`step_plan/v1` 下 `usages`/`usage`/`quota`/`credits`/`subscription`/`balance`
  与 `/v1/credits`、`/v1/subscription` 全部 404）。卡片附一行"Step Plan Credit 用量仅官网可查"。

### v1.0.0 本地包化（防市场覆盖）

- 背景：profile 中官方 `dsh-musage` 依赖为 `github:Thedeergod666/dsh-musage`（无版本锁定），
  市场更新会覆盖二次开发。方案：改为独立本地包 `dsh-musage-card`，`file:` 安装；
  registry 不存在该包名，永远不被覆盖。cordis insert id 用 `musage-card`（防与官方 `musage` 冲突）。

## 安装

1. 把 `dsh-musage-card` 目录放到任意位置（见下方 profile 依赖写法）。
2. 编辑 `~/.dsh/profiles/desktop/package.json`：
   - `dsh.profile.bundles` 数组加入 `"dsh-musage-card"`；
   - `dependencies` 加入 `"dsh-musage-card": "file:<绝对路径，如 D:/dsh-plugins/dsh-musage-card>"`。
3. 在 profile 目录执行 `pnpm install`。
4. 重启 DSH（host 半边）或刷新页面（client 半边）。

> 注意：若在插件市场装了官方 `dsh-musage`，两者会同时挂载（insert id 不同：
> `musage-card` vs `musage`），出现重复卡片时卸载官方版即可。

## 开发

- **生效方式**：client 半边（`dsh/client.js`）改完刷新页面（F5）即可；host 半边
  （`dsh/index.js`）改完需重启 DSH。pnpm 对 `file:` 依赖是**复制安装**——改源码后需在
  profile 目录 `pnpm install`（或直接同步改 `node_modules` 里的副本）。
- **测试**：`node --test tests/parsers.test.mjs`（21 用例，21 pass）。
- **host 形态**：手写懒加载 bundle 协议（`window.__ModuleLoader__.load` + factory），
  无构建步骤；`dsh/index.js` 侧为 ESM，`__parsers` 导出仅供测试。

## 源码与文档

- GitHub：https://github.com/Lin-Dongg/dsh-musage-card
- 开发说明 / 迭代记录：`docs/开发说明.md`（若从作者机器迁移，见其 `D:\deepseek工作区\musage-plugin-dev\`）
- 数据 schemas 参考：[Musage](https://github.com/Thedeergod666/Musage) 的 `src-tauri/src/providers/*.rs`

## License

MIT（见 `LICENSE`）。
