import { useEffect, useRef, useState } from "react";
import type { RuntimeConfigView } from "@yuanfang/shared";
import { api } from "../lib/api";
import { applyAccent, applyTheme, applyUiScale } from "../lib/appearance";
import { formatHotkey } from "../lib/hotkey";

export function QuickAsk() {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<"idle" | "sending" | "sent">("idle");
  const [reply, setReply] = useState<string | null>(null);
  const [config, setConfig] = useState<RuntimeConfigView | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const agentName = config?.agentName ?? "元芳";
  const hotkey = config?.quickAskHotkey ?? "CommandOrControl+Shift+Space";

  useEffect(() => {
    document.body.classList.add("quick-body");
    void api.getConfig().then(setConfig);
    inputRef.current?.focus();
    const unsubscribeEvent = api.onEvent((event) => {
      if (event.type === "log" && event.message === "quick-ask:focus") {
        inputRef.current?.focus();
        void api.getConfig().then(setConfig);
      }
      if (event.type === "assistant_message" && event.message.agentKind === "system") {
        setReply(event.message.content);
        setPhase("idle");
      }
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") api.hideQuickAsk();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.classList.remove("quick-body");
      unsubscribeEvent();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const submit = async () => {
    const value = text.trim();
    if (value.length === 0 || phase === "sending") return;
    setPhase("sending");
    setReply(null);
    try {
      await api.quickAsk(value);
      setPhase("sent");
      setText("");
      window.setTimeout(() => {
        if (document.body.dataset.hasReply !== "1") api.hideQuickAsk();
      }, 1600);
    } catch {
      setPhase("idle");
    }
  };

  useEffect(() => {
    document.body.dataset.hasReply = reply === null ? "0" : "1";
  }, [reply]);

  useEffect(() => {
    if (config === null) return;
    const cleanup = applyTheme(config.theme);
    applyAccent(config.accent);
    applyUiScale(config.uiScale);
    return cleanup;
  }, [config?.theme, config?.accent, config?.uiScale]);

  return (
    <div className="quick-shell">
      <div className="quick-header">
        <span className="logo-mark tiny" />
        <span className="quick-title">{agentName}</span>
        <span className="quick-hint">{formatHotkey(hotkey)} 呼出 · Esc 关闭</span>
      </div>
      <div className="quick-input-row">
        <input
          ref={inputRef}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={`交给${agentName}…`}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <button className="primary-button" disabled={phase === "sending" || text.trim().length === 0} onClick={() => void submit()}>
          {phase === "sending" ? "发送中" : "发送"}
        </button>
      </div>
      {reply !== null ? (
        <div className="quick-reply">
          <span className="quick-reply-label">{agentName}</span>
          <p>{reply.length > 220 ? `${reply.slice(0, 220)}…` : reply}</p>
          <button className="ghost-button" onClick={() => api.openMain()}>
            查看完整对话
          </button>
        </div>
      ) : (
        <div className="quick-status">
          {phase === "sent" ? "已发送。回复会从任务栏弹出。" : `Enter 发送。${agentName}会判断是否需要立项。`}
        </div>
      )}
    </div>
  );
}
