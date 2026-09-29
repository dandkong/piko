import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bell,
  Command,
  Lightbulb,
  Menu,
  MessageCircle,
  PanelsTopLeft,
  Plus,
  RotateCcw,
  Shapes,
  Square,
  SquareCheck,
} from "lucide-react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
};
type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

function newSessionId() {
  return crypto.randomUUID();
}

function readSessionId() {
  const saved = window.localStorage.getItem("piko-session");
  if (saved && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved)) return saved;
  const created = newSessionId();
  window.localStorage.setItem("piko-session", created);
  return created;
}

async function readJson<T>(response: Response): Promise<T> {
  const value = await response.json();
  if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : `Request failed (${response.status})`);
  return value as T;
}

function formatTime(value: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(value);
}

export default function App() {
  const [sessionId] = useState(readSessionId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState("");
  const [apiOnline, setApiOnline] = useState<boolean | undefined>();
  const [modelReady, setModelReady] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    setLoadingHistory(true);
    void Promise.all([
      fetch(`/api/sessions/${sessionId}`).then((response) => readJson<{ messages: Message[] }>(response)),
      fetch("/api/health").then((response) => readJson<{ ok: boolean; modelReady: boolean }>(response)),
    ])
      .then(([history, health]) => {
        if (!active) return;
        setMessages(history.messages);
        setApiOnline(health.ok);
        setModelReady(health.modelReady);
        setError(health.modelReady ? "" : "No Pi model is configured. Run `pi` in a terminal and finish setting up a provider and model.");
      })
      .catch((cause) => {
        if (active) {
          setApiOnline(false);
          setError(cause instanceof Error ? cause.message : "Could not reach the Piko server.");
        }
      })
      .finally(() => {
        if (active) setLoadingHistory(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId]);

  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    setShowScrollButton(distance > 140);
  }, [messages, streaming]);

  const scrollToLatest = useCallback((smooth = true) => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: smooth ? "smooth" : "instant" });
    setShowScrollButton(false);
  }, []);

  async function sendMessage(value = draft) {
    const text = value.trim();
    if (!text || streaming || loadingHistory) return;
    setError("");
    setDraft("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    const userMessage: Message = { id: newSessionId(), role: "user", content: text, createdAt: Date.now() };
    const assistantMessage: Message = { id: newSessionId(), role: "assistant", content: "", createdAt: Date.now() };
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setStreaming(true);
    scrollToLatest(false);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ sessionId, message: text }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`);
      }
      if (!response.body) throw new Error("The server did not open a response stream.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const events = pending.split("\n\n");
        pending = events.pop() || "";
        for (const raw of events) {
          const line = raw.split("\n").find((part) => part.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as StreamEvent;
          if (event.type === "delta") {
            setMessages((current) => current.map((item) => item.id === assistantMessage.id ? { ...item, content: item.content + event.text } : item));
          } else if (event.type === "error") {
            setError(event.message);
          }
        }
        if (done) break;
      }

      const history = await fetch(`/api/sessions/${sessionId}`).then((result) => readJson<{ messages: Message[] }>(result));
      setMessages(history.messages);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        const message = cause instanceof Error ? cause.message : "Piko could not complete this reply.";
        setError(message);
        setMessages((current) => current.filter((item) => item.id !== assistantMessage.id || item.content));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      requestAnimationFrame(() => scrollToLatest());
    }
  }

  function stopResponse() {
    abortRef.current?.abort();
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  const isEmpty = messages.length === 0;
  const statusText = apiOnline === false
    ? "Reconnecting…"
    : loadingHistory
      ? "Connecting…"
      : modelReady
        ? "Here when you need me"
        : "Pi setup needed";

  return (
    <main className="openmuse-shell">
      <header className="agent-header">
        <button className="header-side-button left" type="button" aria-label="Open menu" title="Menu" disabled>
          <Menu size={21} strokeWidth={1.7} />
        </button>
        <div className="agent-identity">
          <div className="mascot-halo"><img src="/capybara.png" alt="Piko" /></div>
          <strong>Piko</strong>
          <span className="agent-status"><i className={apiOnline === false || !modelReady ? "status-offline" : ""} />{statusText}</span>
        </div>
        <button className="header-side-button right" type="button" aria-label="Notifications" title="Notifications" disabled>
          <Bell size={20} strokeWidth={1.7} />
        </button>
      </header>

      <section className="chat-main">
        <div className="conversation" ref={listRef} onScroll={(event) => {
          const element = event.currentTarget;
          setShowScrollButton(element.scrollHeight - element.scrollTop - element.clientHeight > 140);
        }}>
          {loadingHistory ? (
            <div className="loading-state"><span className="loading-orbit" /><span>Opening your conversation…</span></div>
          ) : isEmpty ? (
            <div className="welcome-state">
              <p>Start a conversation with Piko.</p>
              {error && <div className="inline-error welcome-error"><span>{apiOnline === false ? "Piko is offline" : "Piko needs setup"}</span><p>{error}</p></div>}
            </div>
          ) : (
            <div className="message-list">
              {messages.map((message) => (
                <article className={`message-row ${message.role}`} key={message.id}>
                  <div className={`message-content ${message.role}`}>
                    {message.content || (streaming && message === messages.at(-1) ? <span className="typing-dots"><i /><i /><i /></span> : null)}
                    {message.role === "assistant" && streaming && message === messages.at(-1) && message.content.length > 0 && <span className="stream-caret" />}
                  </div>
                  <time className="message-time">{formatTime(message.createdAt)}</time>
                </article>
              ))}
              {error && <div className="inline-error"><span>Reply paused</span><p>{error}</p><button onClick={() => void sendMessage(messages.filter((item) => item.role === "user").at(-1)?.content || "")} type="button"><RotateCcw size={14} /> Try again</button></div>}
            </div>
          )}
        </div>

        {showScrollButton && <button className="scroll-latest" type="button" onClick={() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" })}><ArrowDown size={14} /> Latest</button>}

        <footer className="composer-area">
          <div className={`composer ${streaming ? "is-streaming" : ""}`}>
            <button className="composer-add" type="button" aria-label="Attachments are not available yet" title="Attachments coming later" disabled>
              <Plus size={22} strokeWidth={1.5} />
            </button>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                event.currentTarget.style.height = "auto";
                event.currentTarget.style.height = `${Math.min(140, event.currentTarget.scrollHeight)}px`;
              }}
              onKeyDown={onComposerKeyDown}
              placeholder="Message Piko…"
              rows={1}
              maxLength={12000}
              aria-label="Message Piko"
              disabled={loadingHistory}
            />
            <div className="composer-tools">
              <div className="composer-hint"><Command size={12} /><span>Return to send</span><span className="hint-divider">·</span><span>Shift + Return for a new line</span></div>
              <button className={`send-button ${streaming ? "stop" : ""}`} type="button" onClick={streaming ? stopResponse : () => void sendMessage()} disabled={!streaming && !draft.trim()} aria-label={streaming ? "Stop reply" : "Send message"}>
                {streaming ? <Square size={14} fill="currentColor" /> : <ArrowUp size={18} strokeWidth={2} />}
              </button>
            </div>
          </div>
          <div className="composer-footer"><span>Piko runs Pi locally on your machine.</span><span className="local-badge"><i /> CHAT ONLY · NO CONNECTORS</span></div>
        </footer>

        <nav className="bottom-nav" aria-label="Piko navigation">
          {[
            { label: "Chat", icon: MessageCircle, active: true },
            { label: "Activity", icon: PanelsTopLeft },
            { label: "Ideas", icon: Lightbulb },
            { label: "Goals", icon: SquareCheck },
            { label: "Apps", icon: Shapes },
          ].map(({ label, icon: Icon, active }) => (
            <button className={`bottom-nav-item ${active ? "active" : ""}`} type="button" key={label} aria-label={label} aria-current={active ? "page" : undefined} disabled={!active}>
              <Icon size={21} strokeWidth={1.8} />
            </button>
          ))}
        </nav>
      </section>
    </main>
  );
}
