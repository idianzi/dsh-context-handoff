window.__ModuleLoader__.load({
  id: "dsh-context-handoff",
  factory: (require) => {
    const React = require("react");
    const { createElement: h, useCallback, useEffect, useRef, useState } = React;

    const API = "/context-handoff/api";
    const TAB_ID = "dsh-context-handoff/panel";
    const TAB_KIND = "context-handoff";
    let hostCtx;

    async function request(path, init) {
      const response = await fetch(API + path, {
        cache: "no-store",
        credentials: "same-origin",
        ...init,
        headers: { ...(init && init.headers ? init.headers : {}) },
      });
      let body;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      if (!response.ok) {
        throw new Error((body && body.error) || `HTTP ${response.status}`);
      }
      return body;
    }

    function post(path, payload) {
      return request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-context-handoff": "1" },
        body: JSON.stringify(payload),
      });
    }

    function currentSessionId(ctx) {
      try {
        // The right sidebar marks the session it is drawing. This is the most
        // reliable scope for a tab body; the controller list is only a fallback.
        if (typeof document !== "undefined") {
          const owner = document.querySelector("[data-sidebar-right-session]");
          const fromDom = owner && owner.dataset ? owner.dataset.sidebarRightSession : undefined;
          if (fromDom) return fromDom;
        }
        const list = ctx.sessions.list.getSnapshot();
        const rows = Object.values((list && list.byId) || {});
        const current = rows.find((row) => ((row && row.retainedBy && row.retainedBy.mainView) || 0) > 0);
        return current ? current.id : undefined;
      } catch {
        return undefined;
      }
    }

    function useCurrentSessionId(ctx) {
      const [id, setId] = useState(() => currentSessionId(ctx));
      useEffect(() => {
        let list;
        try {
          list = ctx.sessions.list;
        } catch {
          return undefined;
        }
        if (!list || typeof list.subscribe !== "function") return undefined;
        const sync = () => setId(currentSessionId(ctx));
        const dispose = list.subscribe(sync);
        sync();
        return dispose;
      }, [ctx]);

      // A tab can mount before the sidebar has written its session marker.
      // Poll briefly instead of leaving the switch disabled forever.
      useEffect(() => {
        if (id) return undefined;
        const timer = setInterval(() => {
          const next = currentSessionId(ctx);
          if (next) setId(next);
        }, 1000);
        return () => clearInterval(timer);
      }, [ctx, id]);

      return id;
    }

    function useSessionState(sessionId) {
      const [state, setState] = useState(null);
      const [error, setError] = useState("");
      const [busy, setBusy] = useState(false);

      const refresh = useCallback(async () => {
        if (!sessionId) {
          setState(null);
          return;
        }
        try {
          const next = await request(`/state?session=${encodeURIComponent(sessionId)}`);
          setState(next);
          setError(next && next.ok === false ? next.error || "状态不可用" : "");
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }, [sessionId]);

      useEffect(() => {
        let stopped = false;
        refresh();
        const timer = setInterval(() => {
          if (!stopped && (typeof document === "undefined" || document.visibilityState !== "hidden")) refresh();
        }, 5000);
        return () => {
          stopped = true;
          clearInterval(timer);
        };
      }, [refresh]);

      const writeAuto = useCallback(
        async (enabled) => {
          if (!sessionId) return;
          setBusy(true);
          try {
            const next = await post("/auto", { sessionId, enabled });
            setState(next);
            setError("");
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
          } finally {
            setBusy(false);
          }
        },
        [sessionId],
      );

      const run = useCallback(
        async (newSession) => {
          if (!sessionId) return;
          setBusy(true);
          try {
            const response = await post("/run", { sessionId, newSession });
            const result = response && response.result;
            if (result && result.newSessionId) {
              openSession(result.newSessionId);
              await post("/ack", { sessionId, newSessionId: result.newSessionId }).catch(() => {});
            }
            await refresh();
            setError("");
            return result;
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            return undefined;
          } finally {
            setBusy(false);
          }
        },
        [refresh, sessionId],
      );

      return { state, error, busy, refresh, writeAuto, run };
    }

    function openSession(id) {
      try {
        const uiWorkspace =
          (hostCtx.get && hostCtx.get("uiWorkspace")) || hostCtx.uiWorkspace;
        if (!uiWorkspace || typeof uiWorkspace.openSession !== "function") return false;
        uiWorkspace.openSession(id);
        return true;
      } catch (cause) {
        console.error("[context-handoff] could not open the new session", cause);
        return false;
      }
    }

    function formatTokens(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return "—";
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
      return String(Math.round(n));
    }

    const styles = {
      root: {
        padding: "16px",
        color: "inherit",
        font: "inherit",
        fontSize: "13px",
        lineHeight: 1.55,
        display: "flex",
        flexDirection: "column",
        gap: "14px",
      },
      header: { display: "flex", flexDirection: "column", gap: "2px" },
      title: { fontSize: "14px", fontWeight: 650, letterSpacing: "0.01em" },
      muted: { opacity: 0.62, fontSize: "12px" },
      card: {
        border: "1px solid rgba(127,127,127,.22)",
        borderRadius: "12px",
        padding: "12px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
      },
      row: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px" },
      switch: {
        width: "40px",
        height: "22px",
        borderRadius: "99px",
        border: "1px solid rgba(127,127,127,.28)",
        padding: "2px",
        cursor: "pointer",
        background: "rgba(127,127,127,.18)",
        display: "flex",
        alignItems: "center",
        transition: "background .15s ease",
      },
      switchOn: { background: "var(--dsh-accent, #4f8cff)", borderColor: "transparent" },
      knob: {
        width: "16px",
        height: "16px",
        borderRadius: "50%",
        background: "#fff",
        boxShadow: "0 1px 2px rgba(0,0,0,.25)",
        transform: "translateX(0)",
        transition: "transform .15s ease",
      },
      knobOn: { transform: "translateX(18px)" },
      bar: {
        position: "relative",
        height: "8px",
        borderRadius: "99px",
        background: "rgba(127,127,127,.18)",
        overflow: "hidden",
      },
      fill: {
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        background: "var(--dsh-accent, #4f8cff)",
        borderRadius: "99px",
      },
      marker: {
        position: "absolute",
        top: "-2px",
        bottom: "-2px",
        width: "2px",
        background: "rgba(127,127,127,.7)",
      },
      buttons: { display: "flex", gap: "8px", flexWrap: "wrap" },
      button: {
        appearance: "none",
        border: "1px solid rgba(127,127,127,.28)",
        background: "rgba(127,127,127,.10)",
        color: "inherit",
        font: "inherit",
        fontSize: "12px",
        padding: "6px 10px",
        borderRadius: "8px",
        cursor: "pointer",
      },
      primary: {
        appearance: "none",
        border: "1px solid transparent",
        background: "var(--dsh-accent, #4f8cff)",
        color: "#fff",
        font: "inherit",
        fontSize: "12px",
        padding: "6px 10px",
        borderRadius: "8px",
        cursor: "pointer",
      },
      error: { color: "#d9534f", fontSize: "12px", margin: 0 },
      code: {
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: "11px",
        opacity: 0.8,
        wordBreak: "break-all",
      },
    };

    function HandoffPanel() {
      const sessionId = useCurrentSessionId(hostCtx);
      const { state, error, busy, refresh, writeAuto, run } = useSessionState(sessionId);
      const handled = useRef(new Set());
      const [lastResult, setLastResult] = useState(undefined);

      const lastAuto = state && state.lastAuto;
      useEffect(() => {
        if (!lastAuto || !sessionId) return;
        if (lastAuto.newSessionId === sessionId) {
          void post("/ack", { sessionId, newSessionId: lastAuto.newSessionId }).catch(() => {});
          return;
        }
        if (handled.current.has(lastAuto.newSessionId)) return;
        if (openSession(lastAuto.newSessionId)) {
          handled.current.add(lastAuto.newSessionId);
          void post("/ack", { sessionId, newSessionId: lastAuto.newSessionId }).catch(() => {});
        }
      }, [lastAuto, sessionId]);

      if (!sessionId) {
        return h(
          "div",
          { style: styles.root },
          h("div", { style: styles.header }, h("div", { style: styles.title }, "上下文交接")),
          h("p", { style: styles.muted }, "先打开一个会话，再设置自动总结。"),
        );
      }

      const prompt = Number(state && state.promptTokens) || 0;
      const window = Number(state && state.windowTokens) || 0;
      const threshold = Number(state && state.recommendedAt) || 0;
      const percent = window > 0 ? Math.min(100, Math.round((prompt / window) * 100)) : 0;
      const thresholdPercent = window > 0 && threshold > 0 ? Math.min(100, Math.round((threshold / window) * 100)) : 0;
      const auto = Boolean(state && state.auto);
      const running = Boolean(state && state.running) || busy;
      const loading = state === null && !error;
      const unavailable = Boolean(error) || Boolean(state && state.ok === false);

      const toggle = () => {
        void writeAuto(!auto);
      };

      const runNow = (newSession) => {
        void run(newSession).then((result) => {
          if (result) setLastResult(result);
        });
      };

      return h(
        "div",
        { style: styles.root },
        h(
          "div",
          { style: styles.header },
          h("div", { style: styles.title }, "上下文交接"),
          h("div", { style: styles.muted }, "达到阈值时总结当前会话，并开一个新会话接着做"),
        ),

        h(
          "div",
          { style: styles.card },
          loading
            ? h("div", { style: styles.muted }, "正在读取当前会话的状态…")
            : h(
                "div",
                { style: styles.row },
                h(
                  "div",
                  null,
                  h("div", { style: { fontWeight: 600 } }, auto ? "自动总结已开启" : "自动总结已关闭"),
                  h("div", { style: styles.muted }, "只对当前工作区生效"),
                ),
                h(
                  "button",
                  {
                    type: "button",
                    role: "switch",
                    "aria-checked": auto,
                    "aria-label": "自动总结",
                    disabled: busy || unavailable,
                    onClick: toggle,
                    style: { ...styles.switch, ...(auto ? styles.switchOn : {}), opacity: busy || unavailable ? 0.6 : 1, flex: "0 0 auto" },
                  },
                  h("span", { style: { ...styles.knob, ...(auto ? styles.knobOn : {}) } }),
                ),
              ),
          h(
            "div",
            null,
            h(
              "div",
              { style: { ...styles.row, marginBottom: "5px" } },
              h("span", { style: styles.muted }, `当前 ${formatTokens(prompt)}${window > 0 ? ` / ${formatTokens(window)}` : ""}`),
              h("span", { style: styles.muted }, `推荐 ${formatTokens(threshold)}`),
            ),
            h(
              "div",
              { style: styles.bar, title: `推荐点在 ${formatTokens(threshold)} tokens` },
              h("div", { style: { ...styles.fill, width: `${percent}%` } }),
              thresholdPercent > 0 ? h("div", { style: { ...styles.marker, left: `${thresholdPercent}%` } }) : null,
            ),
            h(
              "div",
              { style: { ...styles.muted, marginTop: "5px" } },
              window > 0
                ? `${percent}% 窗口已用 · 推荐点 ${thresholdPercent}%${state && state.savingPerTurn ? ` · 每轮约省 ${formatTokens(state.savingPerTurn)}` : ""}`
                : "模型窗口未知，阈值退化为经济阈值",
            ),
          ),
          h(
            "div",
            { style: styles.buttons },
            h(
              "button",
              {
                type: "button",
                style: styles.button,
                disabled: busy || loading || unavailable,
                onClick: toggle,
              },
              auto ? "关闭自动总结" : "开启自动总结",
            ),
            h(
              "button",
              { type: "button", style: styles.primary, disabled: running || loading || unavailable, onClick: () => runNow(true) },
              running ? "正在生成…" : "生成并开新会话",
            ),
            h(
              "button",
              { type: "button", style: styles.button, disabled: running || loading || unavailable, onClick: () => runNow(false) },
              "只生成文件",
            ),
          ),
          error
            ? h(
                "div",
                { style: { ...styles.error, display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
                h("span", null, error),
                h(
                  "button",
                  { type: "button", style: styles.button, onClick: () => void refresh() },
                  "重试",
                ),
              )
            : null,
        ),

        state && state.latest
          ? h(
              "div",
              { style: styles.card },
              h("div", { style: { fontWeight: 600 } }, "最近一份交接"),
              h("div", { style: styles.code }, state.latest.file),
              h(
                "div",
                { style: styles.muted },
                `${formatTokens(state.latest.digestTokens)} 摘要 · 来源 ${formatTokens(state.latest.sourceTokens)}`,
              ),
            )
          : null,

        lastAuto && lastAuto.newSessionId !== sessionId
          ? h(
              "div",
              { style: styles.card },
              h("div", { style: { fontWeight: 600 } }, "自动创建的新会话"),
              h("div", { style: styles.code }, lastAuto.newSessionId),
              h(
                "button",
                {
                  type: "button",
                  style: styles.primary,
                  onClick: () => {
                    if (openSession(lastAuto.newSessionId)) {
                      void post("/ack", { sessionId, newSessionId: lastAuto.newSessionId }).catch(() => {});
                    }
                  },
                },
                "打开新会话",
              ),
            )
          : null,

        lastResult && lastResult.text
          ? h(
              "div",
              { style: styles.card },
              h("div", { style: { fontWeight: 600 } }, "刚刚完成"),
              h(
                "pre",
                {
                  style: {
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    fontFamily: "inherit",
                    fontSize: "12px",
                    opacity: 0.78,
                  },
                },
                lastResult.text,
              ),
            )
          : null,

        h(
          "div",
          { style: styles.muted },
          "阈值 = max(经济盈亏点, 窗口 × 55%)，再用 96k 和窗口余量封顶。可在插件 config 里调整；开关状态保存在工作区的 .dsh/handoff/auto.json。",
        ),
      );
    }

    function HandoffIcon() {
      return h(
        "svg",
        {
          width: 24,
          height: 24,
          viewBox: "0 0 24 24",
          fill: "none",
          "aria-hidden": true,
        },
        h("path", {
          d: "M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20V3.5Z",
          stroke: "currentColor",
          strokeWidth: 1.5,
        }),
        h("path", { d: "M14 3.5V8h4", stroke: "currentColor", strokeWidth: 1.5 }),
        h("path", { d: "M9 13h6M9 16.5h4", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round" }),
      );
    }

    const name = "context-handoff-client";
    const inject = ["slots", "sidebarRightTabs", "sessions"];

    function apply(ctx) {
      hostCtx = ctx;
      const tabs = ctx.sidebarRightTabs;
      const slots = ctx.slots;
      if (!tabs || !slots) return;
      const disposers = [];
      try {
        disposers.push(
          tabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => "上下文交接",
            guide: [
              {
                id: "context-handoff",
                order: 86,
                title: () => "上下文交接",
                description: () => "自动总结、阈值提醒、开新会话",
                icon: HandoffIcon,
              },
            ],
          }),
        );
        disposers.push(
          slots.inject("sidebar.right.pane.tab", () =>
            slots.register(
              {
                name: "sidebar.right.pane.tab",
                key: TAB_ID,
              },
              HandoffPanel,
            ),
          ),
        );
      } catch (error) {
        console.error("[context-handoff] sidebar registration failed", error);
      }
      ctx.effect(function* disposeHandoffClient() {
        yield () => {
          for (const dispose of disposers.reverse()) {
            try {
              dispose();
            } catch {
              // A failed tab registration may already be gone.
            }
          }
        };
      }, "context-handoff-client");
    }

    const exports = { apply, inject, name };
    return exports;
  },
});
