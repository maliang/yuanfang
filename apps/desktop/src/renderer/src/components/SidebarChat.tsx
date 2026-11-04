import { useEffect, useRef, useState } from "react";
import type { ConversationFeed } from "@yuanfang/shared";
import { Markdown } from "./Markdown";
import { formatRelative } from "../lib/format";
import { formatHotkey } from "../lib/hotkey";

interface Props {
  agentName: string;
  feed: ConversationFeed | null;
  busy: boolean;
  ready: boolean;
  collapsed: boolean;
  unread: number;
  onToggle: (collapsed: boolean) => void;
  onSend: (text: string) => Promise<void>;
  onStop: () => Promise<void>;
  quickAskHotkey: string;
  onOpenQuickAsk: () => void;
  onOpenSettings: () => void;
}

export function SidebarChat({ agentName, feed, busy, ready, collapsed, unread, quickAskHotkey, onToggle, onSend, onStop, onOpenQuickAsk, onOpenSettings }: Props) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = listRef.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [feed?.messages.length, feed?.partial, busy]);

  useEffect(() => {
    const element = textareaRef.current;
    if (element === null) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(180, element.scrollHeight)}px`;
  }, [draft]);

  const submit = async () => {
    const text = draft.trim();
    if (text.length === 0 || sending || !ready) return;
    setDraft("");
    setSending(true);
    try {
      await onSend(text);
    } finally {
      setSending(false);
    }
  };

  if (collapsed) {
    return (
      <aside className="chat-rail">
        <button className="rail-logo" onClick={() => onToggle(false)} title={`展开${agentName}`}>
          <span className="logo-mark small" />
          {unread > 0 ? <span className="rail-badge">{unread > 99 ? "99+" : unread}</span> : null}
        </button>
        <button className="rail-label" onClick={() => onToggle(false)}>
          和{agentName}对话
        </button>
        <button className="icon-button quick-ask-icon" onClick={onOpenQuickAsk} title={`快速提问 (${formatHotkey(quickAskHotkey)})`}>
          ✦
        </button>
      </aside>
    );
  }

  const messages = feed?.messages ?? [];
  const partial = feed?.partial ?? "";
  const runningTools = (feed?.tools ?? []).filter((tool) => tool.status === "running");

  return (
    <aside className="chat-panel">
      <header className="chat-header">
        <div className="agent-identity">
          <div className={`agent-avatar ${busy ? "pulsing" : ""}`}>
            <span className="logo-mark small" />
            <span className={`presence ${busy ? "busy" : "idle"}`} />
          </div>
          <div>
            <div className="agent-name">{agentName}</div>
            <div className="agent-sub">{busy ? "正在思考…" : ready ? "随时在" : "启动中…"}</div>
          </div>
        </div>
        <div className="chat-header-actions">
          <button className="icon-button quick-ask-icon" onClick={onOpenQuickAsk} title={`快速提问 (${formatHotkey(quickAskHotkey)})`}>
            ✦
          </button>
          <button className="icon-button" onClick={onOpenSettings} title="设置">
            ⚙
          </button>
          <button className="icon-button" onClick={() => onToggle(true)} title="收起">
            »
          </button>
        </div>
      </header>

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 && partial.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-mark">
              <span className="logo-mark" />
            </div>
            <p className="chat-empty-title">把一件事交给{agentName}</p>
            <p className="chat-empty-sub">它会判断是否需要立项，然后替你盯着项目负责人。</p>
            <div className="prompt-chips">
              {[
                "帮我做一个能记录灵感的桌面工具",
                "看看现在的项目进展，有哪些卡住了？",
                "总结一下今天各个项目的产出",
              ].map((prompt) => (
                <button
                  key={prompt}
                  className="prompt-chip"
                  onClick={() => {
                    setDraft(prompt);
                    textareaRef.current?.focus();
                  }}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {messages.map((message) =>
          message.role === "event" ? (
            <div key={message.id} className="chat-event">
              {message.content}
            </div>
          ) : (
            <div key={message.id} id={`message-${message.id}`} className={`chat-message ${message.role}`}>
              <div className="bubble">
                {message.role === "assistant" ? (
                  <Markdown>{message.content}</Markdown>
                ) : (
                  <p className="plain">{message.content}</p>
                )}
              </div>
              <div className="message-time">{formatRelative(message.createdAt)}</div>
            </div>
          ),
        )}

        {busy && partial.length > 0 ? (
          <div className="chat-message assistant streaming">
            <div className="bubble">
              <Markdown>{partial}</Markdown>
              <span className="typing-cursor" />
            </div>
          </div>
        ) : null}
        {busy && partial.length === 0 ? (
          <div className="chat-thinking">
            <span />
            <span />
            <span />
          </div>
        ) : null}
      </div>

      {runningTools.length > 0 ? (
        <div className="tool-strip">
          <span className="tool-strip-dot" />
          {runningTools.map((tool) => tool.name).slice(-3).join(" · ")}
        </div>
      ) : null}
      <div className="chat-composer">
        <textarea
          ref={textareaRef}
          value={draft}
          placeholder={ready ? `和${agentName}说点什么…` : `${agentName}正在启动…`}
          disabled={!ready}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-footer">
          <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
          <div className="composer-buttons">
            {busy ? (
              <button className="stop-button" onClick={() => void onStop()} title="停止当前运行">
                停止
              </button>
            ) : null}
            <button className="send-button" disabled={!ready || sending || draft.trim().length === 0} onClick={() => void submit()}>
              {sending ? "发送中" : "发送"}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
