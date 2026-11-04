import type { ConversationFeed } from "@yuanfang/shared";
import { Markdown } from "./Markdown";
import { formatRelative } from "../lib/format";

export function ChatTranscript({ feed, empty }: { feed: ConversationFeed | null; empty: string }) {
  if (feed === null || (feed.messages.length === 0 && (feed.partial ?? "").length === 0)) {
    return <div className="transcript-empty">{empty}</div>;
  }
  return (
    <div className="transcript">
      {feed.messages.map((message) =>
        message.role === "event" ? (
          <div key={message.id} className="chat-event">
            {message.content}
          </div>
        ) : (
          <div key={message.id} className={`chat-message ${message.role}`}>
            <div className="bubble">
              {message.role === "assistant" ? <Markdown>{message.content}</Markdown> : <p className="plain">{message.content}</p>}
            </div>
            <div className="message-time">{formatRelative(message.createdAt)}</div>
          </div>
        ),
      )}
      {feed.busy && (feed.partial ?? "").length > 0 ? (
        <div className="chat-message assistant streaming">
          <div className="bubble">
            <Markdown>{feed.partial ?? ""}</Markdown>
            <span className="typing-cursor" />
          </div>
        </div>
      ) : null}
      {feed.busy && (feed.partial ?? "").length === 0 ? (
        <div className="chat-thinking">
          <span />
          <span />
          <span />
        </div>
      ) : null}
    </div>
  );
}
