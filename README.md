# dsh-musage-card

[![npm version](https://img.shields.io/npm/v/dsh-musage-card)](https://www.npmjs.com/package/dsh-musage-card)
[![GitHub](https://img.shields.io/badge/GitHub-Lin--Dongg%2Fdsh--musage--card-181717?logo=github)](https://github.com/Lin-Dongg/dsh-musage-card)

`dsh-musage` 的二次开发版 —— 挂在 **DSH 侧边栏底部（"移动访问"按钮上方）** 的多 provider
用量/余额玻璃卡片：跟随当前会话选中的模型**自动切换**，剩余量进度条（5h 流动绿 / 7d 流动彩 / 长周期额度紫）。

**发布到 npm 与 dsh-plugin 插件市场**（见「安装」），也支持 `file:` 本地挂载（开发调试）。

## 支持的 Provider（11 家）

| Provider（DSH route id 变体） | 显示 | 端点 | 凭据 |
|---|---|---|---|
| `minimax` / `minimax-cn` / `minimax-en` | 5h / 7d 双窗口 | `api.minimaxi.com/v1/api/openplatform/coding_plan/remains` | `MINIMAX_CN_API_KEY` 等 |
| `deepseek` / `deepseek-official` / `deepseek-account` | 余额（¥ / $） | `api.deepseek.com/user/balance` | `DEEPSEEK_API_KEY` |
| `kimi` / `kimi-coding` | 5h / 7d 双窗口 | `api.kimi.com/coding/v1/usages` | `KIMI_CODING_API_KEY` |
| `zhipu` / `zai-coding-cn` | 5h / 7d 双窗口 | `open.bigmodel.cn/api/monitor/usage/quota/limit` | `ZAI_CODING_CN_API_KEY` |
| `openrouter` | 余额（$） | `openrouter.ai/api/v1/credits` | `OPENROUTER_API_KEY` |
| `stepfun` / `stepfun-plan` | 余额（¥，现金/券细分）+ 账户总览 | `api.stepfun.com/v1/accounts` / `/api/…Dashboard/QueryAccountBalance` | `STEPFUN_API_KEY`；Step Plan / Credit 走**网页登录态**（**可一键登录**，见下） |
| `siliconflow` / `siliconflow-cn` | 余额（¥，充值/总额细分） | `api.siliconflow.cn/v1/user/info` | `SILICONFLOW_API_KEY` |
| `tavily` | 已用 / 总量 credits + 明细 | `api.tavily.com/usage` | `TAVILY_API_KEY` |
| `zenmux` | PAYG 余额（$，充值/奖励细分） | `zenmux.ai/api/v1/management/payg/balance` | `ZENMUX_MANAGEMENT_API_KEY`（`sk-mg-v1-`） |
| `xiaomi-token-plan-{ams,cn,sgp}` / `xiaomi` / `mimo` … | 月总额 / 补偿 两行（套餐已并入月总额） | `platform.xiaomimimo.com/api/v1/tokenPlan/usage` | **浏览器 Cookie**（key 实测被 401，自动退 Cookie；**可一键登录**，见下） |
| `claude` / `anthropic` / `claude-code` | 5h / 7d 双窗口 | `api.anthropic.com/api/oauth/usage` | **sessionKey Cookie**（**可一键登录**，见下） |

> `modlens-<provider>` 视觉包装路由会自动剥壳后映射到上游 provider。

## 凭据怎么配

- **API Key 类（前 9 家）**：复用 DSH 模型设置里已配的 provider key
  （DSH 规范：`<PROVIDER 大写去特殊字符>_API_KEY`），无需重复填写。
- **小米 MiMo**：**需要浏览器登录态 Cookie**（2026-10 实机：Token Plan API key 走 Bearer 会被
  dashboard 端点 401 + loginUrl 拒绝；若命中了 key，插件会自动退 Cookie 重试一次）。
  **推荐用「一键登录」**（见下节）——卡片失败态点击即自动打开官方登录页，完成后
  Cookie 自动写入 `XIAOMI_MIMO_COOKIE`。手动方式：登录 `platform.xiaomimimo.com` →
  F12 → Network → 任一 `/api/v1/tokenPlan/*` 请求 → 复制**完整 Cookie header 值**存入 ref。
- **Claude**：**推荐用「一键登录」**——点击卡片自动打开 `claude.ai` 登录页，完成后
  `sessionKey` 自动写入 ref `CLAUDE_SESSION_KEY`（官方 OAuth 用量端点，插件自动带
  `Anthropic-Beta: oauth-2025-04-20` 与 `claude-code` UA）。手动方式：从 `claude.ai`
  取 `sessionKey` cookie 值存入 ref。
- **Cookie 的存入方式**（MiMo 兜底、Claude 必需）：编辑 `~/.dsh/.credentials.yaml` 追加一行
  即可 —— DSH 凭据存储**会观察外部编辑并热生效**（不需要重启；值请用引号包裹）：

  ```yaml
  # ~/.dsh/.credentials.yaml（示例；与现有内容合并，勿覆盖）
  XIAOMI_MIMO_COOKIE: "api-platform_serviceToken=...; userId=...; api-platform_slh=...; api-platform_ph=..."
  CLAUDE_SESSION_KEY: "sk-ant-sid01-..."
  ```

- Cookie 会过期（Claude 约 8 小时、MiMo 随登出失效）：卡片显示 ⚠ 时重新复制一次即可。

### 一键登录（登录助手，v1.5.0 / v1.6.0，推荐）

对 **小米 MiMo**、**Claude**、**StepFun** 三家（网页登录态凭据，普通用户无法手工提取）：

1. 卡片显示 ⚠ / 🔑 / 「点击卡片登录读取」时 **点击卡片**；
2. 插件弹出**专用浏览器窗口**（本机 Edge/Chrome），停在官方登录页；
3. 你在窗口里正常登录（账号密码直接提交给官方站点，插件不接触）；
4. 登录完成 → 窗口自动关闭 → 卡片自动显示用量。**无需 F12、无需复制、无需编辑文件。**

为什么可以放心：

- 窗口是**真实浏览器 + 真实官网页面**（保留地址栏，可自行核对域名）；
- 专用 profile 存在 `~/.dsh/musage-login/`：登录态被保留（Cookie 过期后重登通常免输密码），
  与你的日常浏览器完全隔离，可随时整个删除；
- 插件只在登录完成后经浏览器调试协议读取该站点的 Cookie，**只写入 DSH 凭据库**
  （打开的是独立调试端口、仅回环地址，随会话结束关闭）；
- 登录中直接关闭浏览器窗口 = 取消；30 分钟未完成自动收尾；
- 环境不支持时（未装 Edge/Chrome、企业策略禁用调试）卡片会提示失败原因，
  仍可按上面的手动方式配置。

## 与上游 dsh-musage 的差异

- 注册点：`conversation.input.right`（composer 内联）→ **`sidebar.footer.action`**
  （左下角侧边栏 footer，"移动访问"按钮上方，order -100）
- 卡片化：半透明玻璃材质（backdrop-filter blur + 高光描边），明暗主题通用
- 剩余量倒数显示：已用% → 剩余% = 100 − 已用%（数值与进度条填充均为剩余量）
- 流动进度条：5h 流动绿、7d 流动彩、补偿/通用行流动橙（prefers-reduced-motion 自动停用）
- 会话来源：订阅 `uiSession` 服务的 current binding（主视图会话）——见 v1.3.0
- 点击卡片立即刷新（60s 定时刷新保留）
- 登录助手（v1.5.0）：小米 / Claude 失败态点击卡片 → 专用浏览器登录 → 自动写入凭据
- host 半边已扩展为 11 家（上游 5 家）

## 变更记录

### v1.6.6（2026-10）Windows 登录窗口「完全不可见」根因修复

- **根因（2026-10-02 实机全链定位）**：DSH 的 local subprocess 服务在 Windows 上经
  Job runner 架构启动子进程，runner 对目标一律带 `windowsHide: true`
  （`dsh-subprocess-local/lib/runner-launch`: `windowsHide: platform === "win32"`）——
  本意是隐藏控制台窗口，但 Windows 的启动显示状态继承让 GUI 子进程（Edge）的
  首个窗口以**隐藏状态**创建（实测 `IsWindowVisible=false`，恢复需 `ShowWindow(SW_SHOW)`）：
  窗口自出现起在屏幕上与任务栏中都不可见——CDP 仍可连接、页面正常渲染，
  不是「白屏」也不是「被盖住」；`Page.bringToFront` 只能改焦点、不能恢复显示；
  经该 runner 链执行的 `ShowWindow` 实测也修不动（同机对照：直接 spawn 的
  PowerShell 可修复且稳定保持）。
- **修复**：登录浏览器改走**直接 spawn（`node:child_process`，显式 `windowsHide: false`）**
  ——绕开 runner 链的隐藏继承，窗口从创建起正常显示（同机 A/B 实证：同参数、
  唯一变量 `windowsHide` → `true` 隐藏 / `false` 可见）；环境不允许
  `node:child_process` 时回退 `ctx.subprocess`，并保留一次 `ShowWindow(SW_SHOW)`
  修复作为回退路径兜底（会话 15s 时单次复查；脚本输出含 `stuck` 统计——调用被
  静默拒绝时可见）。修复过程写 `musage-window-fix.log`（profile 目录内）便于排查。
  仅 Windows 涉及（`windowsHide` 为 Windows 平台语义），其余平台全链不变。
- 测试：`parseWindowVisibilityReport` 纯函数用例（报告 / `stuck` 解析 / 旧格式兼容）；
  session-orchestration 经 `__login.setNodeChildProcessForTests` 注入 headless 包装，
  direct spawn 路径保持真实浏览器覆盖。

### v1.6.5（2026-10）DeepSeek Account 登录 provider 支持

- DSH 内置的「DeepSeek Account」登录式 provider（route id `deepseek-account`，
  模型 DeepSeek-V41-Flash / V4-Pro）此前不在别名表内 → 卡片显示「未选中支持的 provider」。
  实测该账号的充值余额即 `api.deepseek.com/user/balance`（与 `DEEPSEEK_API_KEY` 同账户同端点，
  whale 组件的「DeepSeek 余额」走的就是这条链路：`keyRef: DEEPSEEK_API_KEY` + 同端点），
  已把它并入 `deepseek` 别名组 —— 选中 Account 模型时卡片显示同一份余额。
- 测试：别名回归用例（`deepseek-account` / `modlens-deepseek-account` → `deepseek`）。

### v1.6.4（2026-10）卡片「登出」按钮

- 卡片右上角新增小按钮 **登出**（仅 StepFun / 小米 MiMo / Claude 这类 Cookie 型 provider 显示）：
  清除本插件保存的 Cookie 登录态（`credentials.unset` 公开 API；含 xiaomi 的兜底 refs），
  **不影响你自配的 API Key**；清除后卡片立即回到「🔑 点击卡片登录」引导，
  可重新走一遍一键登录（便于验证登录流程）。进行中的登录会话会被一并取消。
- Host：`POST /musage/login?action=logout&provider=<p>`（与 start/cancel 同路由同鉴权，
  仅同源回环可调）。
- Client：头部右上角「登出」（悬停加深；点击不触发卡片本身的刷新/登录行为）；
  StepFun 钱包行文案「昨 ¥」→「昨日 ¥」更易读。
- 测试：logout 路由编排用例（Cookie 清掉 / API Key 不动 / 非登录 provider 拒绝）+
  `parseLoginRequest(logout)` + 客户端 `canLogoutFor` 用例。

### v1.6.3（2026-10）StepFun 登录链路修正 —— 「登录成功但没数据」根因修复

- **根因（2026-10-02 实机复现）**：StepFun 登录窗口旧 URL 用了账号域**不识别**的编造参数
  `login?redirect=/?returnTo=…` —— 用户登录成功后，账号域只把浏览器带到 `/security`
  （账号中心），**平台域 `platform.stepfun.com` 的 Oasis-Token 永远不会刷新**，
  探针恒 401 → 卡片永远拿不到 Step Plan Credit / 账户总览（实机现象：窗口停在账号中心、
  卡片「已检测到凭证但尚未生效」空转）。
- **修复**：登录入口改为平台自身对未登录会话使用的跳转格式
  `account.stepfun.com/login?redirect=<平台页>&source_app=platform-cn`
  —— 登录成功后账号域按 `redirect` 把浏览器送回平台页并完成平台域 token 签发；
  `via.returnUrl`（跨域换票 / 自愈的导航目标）同步改为该登录页（旧 `returnTo` 实测不触发换票）。
- **自愈改进**：探针鉴权失败时导航回登录页重新走授权；若用户此刻已在登录页上，
  只给文案、不刷新页面（避免把正在输入的登录表单刷掉）。
- 测试：新增 loginUrl 格式回归用例（禁止 `returnTo` 参数）；stepfun 配置用例同步更新。

### v1.6.2（2026-10）StepFun 登录窗口「白屏」修复 + 旧登录态自愈

- **「白屏」根因（2026-10-02 实机复现）**：登录浏览器窗口由后台进程 spawn，受
  Windows 前台锁影响会开在 DSH 主窗口**后面** —— 用户只看到窗口露出的白色边缘
  （登录页是白底、登录表单在窗口中央，被主窗口盖住），看起来就像"白屏"；实测现场
  窗口 `left=158/top=0/520x760`、`hasFocus=false`。**修复**：CDP 连接建立后调用
  `Page.bringToFront` 把登录窗口带到前台（实测 `hasFocus: false → true`）。
- **旧登录态卡死自愈**：平台域存在过期凭证（如 StepFun 的 Oasis-Token 被服务端
  判过期）时，原逻辑把「有 marker」当成「已登录」→ 探针每 3s 失败一次、空转到
  30 分钟超时，卡片固定显示"已检测到凭证但尚未生效"。**修复**：探针鉴权失败
  （401/403/expired/unauthenticated）→ 借账号域做一次跨域换票重签目标域凭证
  （仅一次，防环）；文案明确为「登录态已失效：请在浏览器窗口中重新登录」。
- 看门狗文案修订：空白 / 网络错误提示与探针状态文案不再互相覆盖（各自只管理自己的状态）。
- 测试：新增 `isAuthFailureMessage` 用例（含 `HTTP 4010` 不误判）。

### v1.6.1（2026-10）登录窗口白屏修复（MiMo 直达 SSO）+ 页面看门狗

- **白屏根因（2026-10-02 探针复现）**：MiMo 登录窗口原先打开 `console/balance`
  —— 该页是 SPA 空壳，服务端不重定向，要等客户端 JS 包加载执行后才跳小米账号 SSO，
  期间 **约 8-10 秒纯白无内容**（弱网 / JS 失败则一直白屏）。实机反馈
  「点击卡片打开网页是白屏」即此。
- **修复**：登录窗口改为直接打开平台的服务端 302 端点
  `platform.xiaomimimo.com/api/v1/genLoginUrl?currentPath=%2Fconsole%2Fbalance`
  —— 服务端直接 302 到小米账号 SSO：**1s 内进入登录页、3-4s 表单就绪**，
  完全绕开 SPA 白屏期（同机探针对比：旧 URL 白屏 ~8-10s → 新 URL 无白屏）。
  登录后回跳与 cookie 落域不变（callback/followup 与旧路径完全一致）。
- **看门狗**：登录会话每轮采样页面状态，持续空白 >20s 或落到浏览器网络错误页时，
  卡片上给出可操作提示（检查网络/代理、Ctrl+R 重试），不再出现「窗口一片白、
  卡片却一直提示请登录」的错位状态。
- 测试：新增 `classifyLoginPage` 纯函数用例 + MiMo `loginUrl` 回归用例。

### v1.6.0（2026-10）StepFun 一键登录：读取 Step Plan Credit / 账户总览

- **Host（`dsh/index.js`）**：登录助手新增 StepFun（登录页 `account.stepfun.com`；
  成功判定 = Connect-JSON `QueryAccountBalance` 试调自证，认证 = 整段 cookie +
  从 cookie 提取的 `Oasis-Token` / `Oasis-Webid` 请求头——2026-10-01 逆向自官网
  bundle 并经未认证 401 探针实证）；`curlFetch` 扩展 POST / 自定义头 / body 支持
  （新增 `oasis` 鉴权型）；StepFun 余额响应附加 `display.oasis`
  （credit / voucherPlan / voucher 等账户总览字段，失败静默不阻塞余额）。
- **Client（`dsh/client.js`）**：StepFun 卡片渲染 🧾 账户总览行（Plan/Credit/赠送）；
  缺数据时渲染「🔑 点击卡片登录读取 Step Plan Credit」引导；
  `canLoginAssistFor` 语义调整为以 host 附着为唯一事实源（StepFun 成功态也可给登录入口）。
- **测试**：95 用例 —— 新增 pickCookieValue / parseStepfunOasis / stepfun 配置纯函数
  用例、StepFun 接口在线契约探测（端点漂移报警）、stepfun 卡片渲染仿真 4 用例。

### v1.5.0（2026-10）登录助手：点击卡片 → 浏览器登录 → 自动获取 Cookie

- **Host（`dsh/index.js`）**：新增登录助手——CDP（DevTools 协议）客户端
  （DevToolsActivePort 发现 / WebSocket 问答 / `Network.getCookies` 读含 HttpOnly /
  `Browser.close` 优雅关闭）；登录会话单例（Cookie 轮询 → 试调用量 API 自证 →
  `credentials.set` 原子写入 → 优雅关窗 → 缓存失效）；新路由 `POST /musage/login`
  （action=start|cancel）与 `GET /musage/login/status`；失败响应附 `loginAssist` 标记
  （client 据此给出登录入口）。
- **Client（`dsh/client.js`）**：失败态卡片显示「🔑 需要 XX 登录 · 点击卡片自动获取」；
  登录中/刚成功过渡态文案；登录完成后自动刷新用量。点击分发与文案选择收在三个纯函数
  （`decideCardClick` / `canLoginAssistFor` / `loginNoteFor`），可直接单测。
- **测试**：`node --test`（全量自动发现，82 用例）——新增 login-assist 30 用例
  （纯函数：cookie 拼接/提取、marker 判定、浏览器探测、请求解析）、cdp-integration
  2 用例（真实 headless 浏览器全链路：读 HttpOnly cookie 与 Browser.close）、
  session-orchestration 4 用例（mock ctx + 真实浏览器驱动生产路由的会话编排：
  start/取消/关窗/dispose 清理；含同 profile 二次会话回归）、client-login 12 用例
  （交互决策）。浏览器类用例无浏览器时自动 skip。

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

### 方式 A：npm / 插件市场（推荐）

- **npm 安装**：`dsh plugin --profile web add -w dsh-musage-card`；或
- 在 DSH **设置 → 插件** 的「插件市场」搜索 **dsh-musage-card** 一键安装（GitHub topic [`dsh-plugin`](https://github.com/topics/dsh-plugin) 收录，市场自动同步）；或
- 让 agent 执行 `market_install`。

安装后重启 DSH。

### 方式 B：本地 file: 挂载（开发调试）

1. 把 `dsh-musage-card` 目录放到任意位置（见下方 profile 依赖写法）。
2. 编辑 `~/.dsh/profiles/desktop/package.json`：
   - `dsh.profile.bundles` 数组加入 `"dsh-musage-card"`；
   - `dependencies` 加入 `"dsh-musage-card": "file:<绝对路径，如 D:/dsh-plugins/dsh-musage-card>"`。
3. 在 profile 目录执行 `pnpm install`。
4. 重启 DSH（host 半边）或刷新页面（client 半边）。

> 注意：与官方 `dsh-musage` 同时挂载会出现重复卡片（insert id 不同：
> `musage-card` vs `musage`），二选一即可。

## 开发

- **生效方式**：client 半边（`dsh/client.js`）改完刷新页面（F5）即可；host 半边
  （`dsh/index.js`）改完需重启 DSH。pnpm 对 `file:` 依赖是**复制安装**——改源码后需在
  profile 目录 `pnpm install`（或直接同步改 `node_modules` 里的副本）。
- **测试**：`node --test`（全量自动发现；其中 cdp-integration 需要本机 Edge/Chrome，
  无浏览器时自动 skip）。
- **host 形态**：手写懒加载 bundle 协议（`window.__ModuleLoader__.load` + factory），
  无构建步骤；`dsh/index.js` 侧为 ESM，`__parsers` / `__login` 导出仅供测试。

## 源码与文档

- GitHub：https://github.com/Lin-Dongg/dsh-musage-card
- 开发说明 / 迭代记录：`docs/开发说明.md`（若从作者机器迁移，见其 `D:\deepseek工作区\musage-plugin-dev\`）
- 数据 schemas 参考：[Musage](https://github.com/Thedeergod666/Musage) 的 `src-tauri/src/providers/*.rs`

## License

MIT（见 `LICENSE`）。
