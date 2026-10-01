// dsh/client.js — DSH Client 半边 (bundle 形态) — 二次开发版 (卡片式)
//
// 本地 fork 变更 (v1.1.0):
//   - 新增 stepfun provider 映射 ("stepfun" / "stepfun-plan" → stepfun):
//     余额型显示 (¥), 附现金/代金券细分与 "Step Plan Credit 用量仅官网可查"
//     提示行 (Credit 无 API-Key 查询端点, 见 host 头注释的实测记录).
//
// 二次开发变更 (v0.2.1, 基于 v0.1.1):
//   1. 注册点从 `conversation.input.right` (composer 内, model select 旁的
//      一行内联 readout) 迁移到 `sidebar.footer.action` (左下角侧边栏
//      footer, "移动访问"按钮所在 list slot), 注册 order: -100 → 渲染在
//      "移动访问"按钮的上方。
//   2. 渲染为半透明玻璃卡片 (backdrop-filter blur + 半透明底 + 高光描边,
//      明暗主题通用); 配色走 DSH 的 --dsw-alias-* 设计变量。
//   3. 用量按剩余量倒数显示: fiveHrPct/weeklyPct (已用%) → 剩余% =
//      100 - 已用%; 进度条填充与数值都是剩余量。
//   4. 进度条: 5h = 流动绿色渐变, 7d = 流动彩色渐变
//      (background-position 循环滚动动画, prefers-reduced-motion 时停用)。
//   5. 注册点: `conversation.input.right` —— **session 作用域** slot，sessionId 由 slot 直接
//      提供（契约表 standardProps 含 "sessionId: SessionId"）；这也是上游 dsh-musage 的原始注册点。
//      ⚠ 不要放 `sidebar.footer.action`：scope=root，契约 doc 写明 "each action receives only
//        the column state"；实测那里的会话态 = {ids,byId,phase,projectionsBySession} 无 current
//        字段（phase=ready、ids=47 也没有），卡片会恒显示"未选中支持的 provider"（v1.2.19 即栽于此）。
//      拿到 sessionId 后用 modelDirectories.directoryFor(sessionId) 取同一份 ModelDirectory。
//   6. 原 sidebar.footer.action 专用 CSS（把 slot 锚点改成垂直 flex 容器）已随注册点
//      迁移到 conversation.input.right 一并删除 —— composer 行是既有水平布局，无需覆盖。
//
// 功能保持不变 (继承 v0.1.1):
//   - 跟随当前会话选中的模型自动切换 provider (含 modlens- 包装剥离);
//   - MiniMax / Kimi / Zhipu 显示 5h + 7d 用量, DeepSeek / OpenRouter 显示
//     余额; 每分钟自动刷新; 失败时显示 ⚠ 并把错误信息放在 title tooltip;
//     未选支持的 provider 时显示占位状态; 点击卡片立即刷新;
//   - 数据仍来自 host 半边 (dsh/index.js, 未改动) 的同源路由
//     GET /musage/quota?provider=<p>。
//
// 形态说明 (v0.1.0): 手写的 lazy-CJS bundle 协议
//       (window.__ModuleLoader__.load + factory(require) 返回 cordis-plugin
//       exports), 无构建步骤, 与 in-box 插件 / modlens 同一形态.

window.__ModuleLoader__.load({
  id: "dsh-musage-card",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");

    const REFRESH_INTERVAL_MS = 60_000;

    // DSH provider route id → 我们 host PROVIDERS key 的映射.
    // DSH 把用户配的 provider route id 存在 directory.store.getSnapshot().current.provider 里.
    // 例如 "minimax-cn" / "deepseek" / "minimax-en" / "anthropic" / "openai" 等等.
    // 我们只关注 PROVIDERS 里有的. 其它 provider 显示 "musage".

    const PROVIDER_ALIASES = {
      "minimax-cn": "minimax",
      "minimax-en": "minimax",
      "minimax": "minimax",
      "deepseek": "deepseek",
      "deepseek-official": "deepseek",  // DSH dsh-llm-deepseek 实际 provider id (带后缀)
      "kimi-coding": "kimi",
      "openrouter": "openrouter",
      "zai-coding-cn": "zhipu",
      "zhipu": "zhipu",
      "stepfun": "stepfun",
      "stepfun-plan": "stepfun",        // pi 生态同名的 Step Plan route id
    };

    function readActiveProvider(snapshot) {
      if (!snapshot) return null;
      const cur = snapshot.current;
      if (!cur) return null;
      const route = cur.provider;
      if (!route) return null;
      if (PROVIDER_ALIASES[route]) return PROVIDER_ALIASES[route];
      // modlens vision 包装 route: id 为 "modlens-<上游 provider id>" (或旧版固定
      // "deepseek-modlens"). 包装只是给上游模型加视觉转发, 计费仍走上源的
      // coding plan, 所以剥掉包装前缀后按上游 id 再映射一次.
      if (route.indexOf("modlens-") === 0) {
        return PROVIDER_ALIASES[route.slice("modlens-".length)] || null;
      }
      if (route === "deepseek-modlens") return "deepseek";
      return null;
    }

    // 同源 fetch host 半边路由; 404 = host 半边没挂上 (无 web profile).
    async function fetchQuota(provider) {
      const res = await fetch("/musage/quota?provider=" + encodeURIComponent(provider), {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "same-origin",
      });
      if (!res.ok) {
        throw new Error("quota 路由 HTTP " + res.status);
      }
      return res.json();
    }

    function providerLabel(p) {
      if (p === "minimax") return "MiniMax";
      if (p === "deepseek") return "DeepSeek";
      if (p === "kimi") return "Kimi";
      if (p === "openrouter") return "OpenRouter";
      if (p === "zhipu") return "Zhipu";
      if (p === "stepfun") return "StepFun";
      return p;
    }

    function providerShortLabel(p) {
      if (p === "minimax") return "MM";
      if (p === "deepseek") return "DS";
      if (p === "kimi") return "Kimi";
      if (p === "openrouter") return "OR";
      if (p === "zhipu") return "ZP";
      if (p === "stepfun") return "SF";
      return "···";
    }

    // ============================================================
    // 卡片样式 (补充 CSS, 一次性注入 document.head)
    // ============================================================
    // （原 [data-slot="sidebar.footer.action"] 的垂直布局覆盖已删除：注册点已迁到
    //   conversation.input.right，composer 行自带水平布局。）
    // - .dsh-musage-card*: 卡片本体 = 半透明玻璃材质 (backdrop-filter blur
    //   + 半透明底 + 高光描边), 明暗主题通用; 文字配色走 --dsw-alias-* 变量。
    // - 进度条: 剩余量倒数显示。5h = 流动绿色渐变, 7d = 流动彩色渐变
    //   (background-position 循环滚动动画); prefers-reduced-motion 时停用。

    const STYLE_TAG = "dsh-musage-cards";

    const CARD_CSS = [
      "/* ---- 卡片: 半透明玻璃材质 ---- */",
      ".dsh-musage-card {",
      "  box-sizing: border-box;",
      "  width: 100%;",
      "  min-width: 0;",
      "  padding: 8px 8px;",
      "  border-radius: 12px;",
      "  border: 1px solid rgba(255, 255, 255, 0.16);",
      "  background: rgba(136, 152, 170, 0.13);",
      "  -webkit-backdrop-filter: blur(14px) saturate(1.5);",
      "  backdrop-filter: blur(14px) saturate(1.5);",
      "  box-shadow:",
      "    inset 0 1px 0 rgba(255, 255, 255, 0.18),",
      "    0 4px 16px rgba(0, 0, 0, 0.10);",
      "  color: var(--dsw-alias-label-secondary, #888);",
      "  font-size: 11px;",
      "  line-height: 1.45;",
      "  font-variant-numeric: tabular-nums;",
      "  user-select: none;",
      "  cursor: pointer;",
      "  transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;",
      "}",
      ".dsh-musage-card:hover {",
      "  background: rgba(160, 178, 196, 0.20);",
      "  border-color: rgba(255, 255, 255, 0.28);",
      "  box-shadow:",
      "    inset 0 1px 0 rgba(255, 255, 255, 0.24),",
      "    0 6px 20px rgba(0, 0, 0, 0.14);",
      "}",
      ".dsh-musage-card--rail {",
      "  padding: 4px 2px;",
      "  border-radius: 8px;",
      "  text-align: center;",
      "  font-size: 10px;",
      "}",
      ".dsh-musage-card__head {",
      "  display: flex;",
      "  align-items: center;",
      "  gap: 6px;",
      "  min-width: 0;",
      "  margin-bottom: 6px;",
      "}",
      ".dsh-musage-card--rail .dsh-musage-card__head {",
      "  margin-bottom: 2px;",
      "  justify-content: center;",
      "}",
      ".dsh-musage-card__dot {",
      "  flex: none;",
      "  width: 6px;",
      "  height: 6px;",
      "  border-radius: 50%;",
      "  background: var(--dsw-alias-label-dimmed, #888);",
      "}",
      ".dsh-musage-card__dot--ok { background: var(--dsw-alias-state-success-primary, #34c759); }",
      ".dsh-musage-card__dot--warn { background: var(--dsw-alias-state-warn-primary, #f5a623); }",
      ".dsh-musage-card__name {",
      "  flex: none;",
      "  font-weight: 600;",
      "  font-size: 11px;",
      "  color: var(--dsw-alias-label-primary, #eee);",
      "  white-space: nowrap;",
      "  overflow: hidden;",
      "  text-overflow: ellipsis;",
      "}",
      ".dsh-musage-card__refresh {",
      "  margin-left: auto;",
      "  flex: none;",
      "  font-size: 10px;",
      "  color: var(--dsw-alias-label-tertiary, #999);",
      "  opacity: 0;",
      "  transition: opacity 0.15s ease;",
      "}",
      ".dsh-musage-card:hover .dsh-musage-card__refresh { opacity: 1; }",
      ".dsh-musage-card__row {",
      "  display: flex;",
      "  align-items: center;",
      "  gap: 5px;",
      "  min-width: 0;",
      "}",
      ".dsh-musage-card__row + .dsh-musage-card__row { margin-top: 4px; }",
      ".dsh-musage-card__rowKey {",
      "  flex: none;",
      "  font-size: 10px;",
      "  color: var(--dsw-alias-label-tertiary, #999);",
      "}",
      ".dsh-musage-card__track {",
      "  display: block;  /* span 默认 inline, 防御性块化 */",
      "  flex: 1 1 auto;",
      "  min-width: 0;",
      "  height: 6px;",
      "  border-radius: 3px;",
      "  background: rgba(127, 137, 148, 0.28);",
      "  overflow: hidden;",
      "}",
      "/* ---- 进度条: 剩余量; 5h 流动绿 / 7d 流动彩 ---- */",
      ".dsh-musage-card__fill {",
      "  display: block;  /* span 默认 inline, 无 display 修复则宽高全部失效 */",
      "  height: 100%;",
      "  border-radius: 3px;",
      "  transition: width 0.4s ease;",
      "  will-change: background-position;",
      "}",
      ".dsh-musage-card__fill--green {",
      "  background-image: linear-gradient(90deg,",
      "    #1f9d55, #4ade80, #a7f3d0, #4ade80, #1f9d55);",
      "  background-size: 200% 100%;",
      "  animation: dsh-musage-flow-green 2.6s linear infinite;",
      "}",
      ".dsh-musage-card__fill--rainbow {",
      "  background-image: linear-gradient(90deg,",
      "    #8b5cf6, #a855f7, #c084fc, #6366f1, #0ea5e9, #6366f1, #c084fc, #a855f7, #8b5cf6);",
      "  background-size: 300% 100%;",
      "  animation: dsh-musage-flow-rainbow 8s linear infinite;",
      "}",
      "@keyframes dsh-musage-flow-green {",
      "  from { background-position: 0% 50%; }",
      "  to { background-position: -200% 50%; }",
      "}",
      "@keyframes dsh-musage-flow-rainbow {",
      "  from { background-position: 0% 50%; }",
      "  to { background-position: -300% 50%; }",
      "}",
      "@media (prefers-reduced-motion: reduce) {",
      "  .dsh-musage-card__fill--green,",
      "  .dsh-musage-card__fill--rainbow { animation: none; }",
      "}",
      ".dsh-musage-card__rowValue {",
      "  flex: none;",
      "  min-width: 30px;",
      "  text-align: right;",
      "  font-weight: 600;",
      "  font-size: 11px;",
      "  color: var(--dsw-alias-label-primary, #eee);",
      "}",
      ".dsh-musage-card__balance {",
      "  font-weight: 600;",
      "  font-size: 13px;",
      "  color: var(--dsw-alias-label-primary, #eee);",
      "}",
      ".dsh-musage-card__balanceLabel {",
      "  font-size: 10px;",
      "  color: var(--dsw-alias-label-tertiary, #999);",
      "  margin-right: 6px;",
      "}",
      ".dsh-musage-card__note {",
      "  font-size: 10px;",
      "  color: var(--dsw-alias-label-tertiary, #999);",
      "  white-space: nowrap;",
      "  overflow: hidden;",
      "  text-overflow: ellipsis;",
      "}",
      ".dsh-musage-card__railValue {",
      "  font-weight: 600;",
      "  font-size: 10px;",
      "  color: var(--dsw-alias-label-primary, #eee);",
      "}",
      ".dsh-musage-card__resetsHead {",
      "  flex: 0 1 auto;",
      "  min-width: 0;",
      "  font-size: 10px;",
      "  color: var(--dsw-alias-label-tertiary, #999);",
      "  font-variant-numeric: tabular-nums;",
      "  white-space: nowrap;",
      "  overflow: hidden;",
      "  text-overflow: ellipsis;",
      "}",
    ].join("\n");

    function injectStyles() {
      if (typeof document === "undefined") return;
      if (document.querySelector("style[data-musage-cards]")) return;
      const tag = document.createElement("style");
      tag.dataset.musageCards = STYLE_TAG;
      tag.textContent = CARD_CSS;
      document.head.appendChild(tag);
    }

    // ============================================================
    // 卡片组件
    // ============================================================

    // 已用% → 剩余% (显示与进度条都用剩余量; 上游异常值夹取到 0-100).
    function remainingPct(usedPct) {
      if (typeof usedPct !== "number" || !isFinite(usedPct)) return null;
      const remaining = 100 - usedPct;
      if (remaining < 0) return 0;
      if (remaining > 100) return 100;
      return remaining;
    }

    // host 给的 resetsIn 形如 "2h35m 重置" / "45m 重置" / " 即将重置" / "".
    // 提取紧凑形式; 超过 24h 转成 "Xd Yh" (7d 窗口常见几十上百小时).
    function compactResets(s) {
      if (typeof s !== "string") return null;
      const t = s.trim();
      if (!t) return null;
      const m = t.match(/^(\d+)h(\d+)m/);
      if (m) {
        const h = parseInt(m[1], 10);
        const mm = parseInt(m[2], 10);
        if (h >= 24) return Math.floor(h / 24) + "d" + (h % 24) + "h";
        return h + "h" + mm + "m";
      }
      const m2 = t.match(/^(\d+)m/);
      if (m2) return m2[1] + "m";
      if (t.indexOf("即将重置") >= 0) return "<1m";
      return t;
    }

    function quotaTitle(state, provider, d) {
      if (state.title) return state.title;
      try {
        return "dsh-musage · " + provider + "\n" + JSON.stringify(d || {}, null, 2);
      } catch (e) {
        return "dsh-musage · " + provider;
      }
    }

    function QuotaCard(props, models, timer) {
      // ---- 当前 sessionId ----
      // conversation.input.right 是 session 作用域 slot：sessionId 由 slot **直接提供**
      // （契约表 standardProps 含 "sessionId: SessionId"），不需要任何探测。
      // 历史教训：早前放在 sidebar.footer.action（scope=root）时，运行时状态里根本没有
      // 当前会话——实测会话态 = {ids,byId,phase,projectionsBySession}（phase=ready、ids=47，
      // 但无 current），面板态 = {activePanelId: undefined}，所以卡片恒显示"未选中支持的 provider"。
      const sessionId = (props && props.sessionId) || null;

      // ---- 按当前会话的 model directory 解析 active provider ----
      const [provider, setProvider] = React.useState(null);
      // 诊断用：slot 实际报出的 provider route（映射前的原值），失败时显示在卡片上。
      const [rawProvider, setRawProvider] = React.useState(null);
      const diag = !sessionId
        ? "slot 未提供 sessionId"
        : (rawProvider ? ("provider=" + rawProvider) : "目录里没有 provider 字段");
      React.useEffect(() => {
        if (!models || !sessionId) {
          console.log("[musage-client] skip: no models or no sessionId. models=" + !!models + " sessionId=" + sessionId + " → no fallback (没订阅到 provider)");
          setProvider(null);
          return;
        }
        let directory;
        try {
          directory = models.directoryFor(sessionId);
          console.log("[musage-client] directoryFor ok: " + (directory ? "have directory" : "null"));
        } catch (e) {
          console.error("[musage-client] directoryFor 抛异常: " + ((e && e.stack) || e) + " → no fallback");
          setProvider(null);
          return;
        }
        if (!directory || !directory.store) {
          console.log("[musage-client] directory 缺失 → no fallback");
          setProvider(null);
          return;
        }
        const updateProvider = () => {
          try {
            const snap = directory.store.getSnapshot();
            const raw = (snap && snap.current && snap.current.provider) || null;
            const p = readActiveProvider(snap);
            console.log("[musage-client] model 变化: current.provider=" + raw + " → mapped=" + p);
            setRawProvider(raw);
            setProvider(p);  // 不 fallback minimax, 拿不到就 null → 显示 "musage"
          } catch (e) {
            console.error("[musage-client] readActiveProvider 抛异常: " + ((e && e.stack) || e));
            setProvider(null);
          }
        };
        updateProvider();
        const stop = directory.store.subscribe(updateProvider);
        return () => { stop(); };
      }, [models, sessionId]);

      // ---- quota 状态: 每次 provider 切换 / timer / 手动 retry 重 fetch ----
      const [state, setState] = React.useState({
        ok: false, loaded: false, kind: "other", message: "加载中", display: null,
      });
      const [retrySeq, setRetrySeq] = React.useState(0);

      React.useEffect(() => {
        if (!provider) {
          setState({ ok: false, loaded: true, kind: "other", message: "未选中支持的 provider（" + diag + "）", display: null });
          return;
        }
        let alive = true;
        async function refresh() {
          try {
            const result = await fetchQuota(provider);
            if (alive) setState(result
              ? { ...result, loaded: true }
              : { ok: false, loaded: true, kind: "other", message: "空响应", display: null });
          } catch (e) {
            if (alive) setState({ ok: false, loaded: true, kind: "network", message: String((e && e.message) || e), display: null });
          }
        }
        refresh();
        const dispose = timer.interval(refresh, REFRESH_INTERVAL_MS);
        return () => {
          alive = false;
          try { dispose(); } catch (e) {}
        };
      }, [provider, timer, retrySeq]);

      const wide = !props || props.wide !== false;
      const onCardClick = () => setRetrySeq((s) => s + 1);  // 手动刷新 (60s 定时不变)

      const d = (state && state.display) || {};

      // ---- 状态点 ----
      let dotClass = "dsh-musage-card__dot";
      if (state.loaded && state.ok) dotClass += " dsh-musage-card__dot--ok";
      else if (state.loaded && !state.ok && provider) dotClass += " dsh-musage-card__dot--warn";

      const headName = provider ? providerLabel(provider) : "musage";

      // ---- rail (侧边栏收起) 紧凑形态: 缩写 + 剩余百分比 ----
      if (!wide) {
        let railValue = "···";
        if (state.loaded && state.ok) {
          const rem = remainingPct(d.fiveHrPct);
          if (rem !== null) railValue = rem + "%";
          else if (d.balanceText) railValue = d.balanceText;
          else if (typeof d.balanceUsd === "number") railValue = "$" + d.balanceUsd.toFixed(2);
        } else if (state.loaded && !state.ok && provider) {
          railValue = "⚠";
        }
        return React.createElement(
          "div",
          {
            className: "dsh-musage-card dsh-musage-card--rail",
            title: quotaTitle(state, provider || "none", d) + "\n点击刷新",
            onClick: onCardClick,
          },
          React.createElement("div", { className: "dsh-musage-card__head" },
            React.createElement("span", { className: dotClass }),
            React.createElement("span", { className: "dsh-musage-card__name" }, providerShortLabel(provider))
          ),
          React.createElement("span", { className: "dsh-musage-card__railValue" }, railValue)
        );
      }

      // ---- wide 完整卡片 ----
      // 头部倒计时 (provider 名右侧): 左值 = 5h 窗口, 右值 = 7d 窗口 (与进度条顺序对应)
      const r5 = compactResets(d.fiveHrResetsIn);
      const r7 = compactResets(d.weeklyResetsIn);
      const resetText = [r5, r7].filter(Boolean).join(" · ");
      const children = [
        React.createElement("div", { key: "head", className: "dsh-musage-card__head" },
          React.createElement("span", { className: dotClass }),
          React.createElement("span", { className: "dsh-musage-card__name" }, headName),
          resetText
            ? React.createElement("span", {
                className: "dsh-musage-card__resetsHead",
                title: "窗口重置倒计时（左 5h · 右 7d，重置后用量清零）",
              }, resetText)
            : null
        ),
      ];

      if (!state.loaded) {
        // 加载中
        children.push(React.createElement("div", { key: "note", className: "dsh-musage-card__note" }, "加载中 ···"));
      } else if (!provider) {
        // 当前模型未在支持列表
        children.push(React.createElement("div", {
          key: "note",
          className: "dsh-musage-card__note",
          title: "dsh-musage · 当前模型未在 musage 支持列表内 · " + diag,
        }, "未选中支持的 provider（" + diag + "）"));
      } else if (!state.ok) {
        // 拉取失败
        children.push(React.createElement("div", {
          key: "note",
          className: "dsh-musage-card__note",
          style: { color: "var(--dsw-alias-state-warn-label, #f5a623)" },
          title: "dsh-musage · " + provider + " (失败)\n" + (state.message || "unknown"),
        }, "⚠ " + (state.message || "拉取失败")));
      } else if (typeof d.fiveHrPct === "number" || typeof d.weeklyPct === "number") {
        // 百分比型 (MiniMax / Kimi / Zhipu): 5h 流动绿 + 7d 流动彩, 剩余量倒数
        // rows: [key, fillClass]
        const rows = [];
        if (typeof d.fiveHrPct === "number") {
          rows.push(["5h", "dsh-musage-card__fill--green"]);
        }
        if (typeof d.weeklyPct === "number") {
          rows.push(["7d", "dsh-musage-card__fill--rainbow"]);
        }
        rows.forEach((row, i) => {
          const key = row[0];
          const fillClass = row[1];
          const rem = remainingPct(d[key === "5h" ? "fiveHrPct" : "weeklyPct"]);
          const remText = rem === null ? "—" : rem + "%";
          const remWidth = rem === null ? 0 : rem;
          children.push(React.createElement("div", { key: "row" + i, className: "dsh-musage-card__row" },
            React.createElement("span", { className: "dsh-musage-card__rowKey" }, key),
            React.createElement("span", { className: "dsh-musage-card__track" },
              React.createElement("span", {
                className: "dsh-musage-card__fill " + fillClass,
                style: { width: remWidth + "%" },
              })
            ),
            React.createElement("span", { className: "dsh-musage-card__rowValue" }, remText)
          ));
        });
      } else {
        // 余额型 (DeepSeek / OpenRouter / StepFun)
        const txt = d.balanceText || ("$" + (d.balanceUsd != null ? d.balanceUsd.toFixed(2) : "0.00"));
        children.push(React.createElement("div", { key: "balance", className: "dsh-musage-card__row" },
          React.createElement("span", { className: "dsh-musage-card__balanceLabel" }, "余额"),
          React.createElement("span", { className: "dsh-musage-card__balance" }, txt)
        ));
        // StepFun: 现金/代金券细分 (有值才显示)
        if (d.balanceDetail) {
          children.push(React.createElement("div", {
            key: "balanceDetail",
            className: "dsh-musage-card__note",
            title: d.balanceDetail,
          }, d.balanceDetail));
        }
        // StepFun: Plan Credit 无 API 端点的提示 (避免误读按量余额 = Credit)
        if (d.planNote) {
          children.push(React.createElement("div", {
            key: "planNote",
            className: "dsh-musage-card__note",
            title: "Step Plan (Token Plan) 的 Credit 用量没有 API-Key 认证的查询端点，请在 platform.stepfun.com/account-overview 查看",
          }, d.planNote));
        }
      }

      return React.createElement(
        "div",
        {
          className: "dsh-musage-card",
          title: quotaTitle(state, provider || "none", d) + "\n点击刷新",
          onClick: onCardClick,
        },
        ...children
      );
    }

    function apply(ctx) {
      const slots = ctx.slots;
      if (!slots || typeof slots.inject !== "function") {
        console.log("[musage-client] skip: slots service 不可用");
        return;
      }
      const timer = ctx.timer;
      const models = ctx.modelDirectories;
      injectStyles();
      // conversation.input.right 是 **session 作用域** slot（契约表 scope:"session"，
      // standardProps 含 "sessionId: SessionId"），由 client-ui-conversation 的
      // conversation.composer.bar 条目声明 —— 也正是上游 dsh-musage 原本的注册点。
      // ⚠ 不能放 sidebar.footer.action：那是 root 作用域，运行时状态里没有当前会话
      //   （契约 doc 原文 "each action receives only the column state"）。
      slots.inject("conversation.input.right", function* () {
        yield slots.register(
          {
            name: "conversation.input.right",
            id: "musage",
            order: 100,
            label: "musage",
          },
          (props) => QuotaCard(props, models, timer)
        );
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "timer", "modelDirectories"];
    return module.exports;
  },
});
