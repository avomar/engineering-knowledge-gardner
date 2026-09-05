import {
  apiErrorResponseSchema,
  chatResponseSchema,
  conversationMessagesResponseSchema,
  healthResponseSchema,
  idSchema,
  type ChatMessage,
  type HealthResponse,
} from "@knowledge-gardener/domain";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

type HealthState =
  | { kind: "loading" }
  | { kind: "ready"; response: HealthResponse }
  | { kind: "error"; message: string };

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787"
).replace(/\/$/u, "");
const sessionStorageKey = "knowledge-gardener.demo-session-id";
const conversationStorageKey = "knowledge-gardener.active-conversation-id";
const maximumQuestionLength = 2_000;
const starters = [
  "Why did we choose D1?",
  "How was the connection incident mitigated?",
  "How do I run this project locally?",
  "What did we decide about Kubernetes?",
] as const;

export function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });
  const [sessionId] = useState(getOrCreateSessionId);
  const [conversationId, setConversationId] = useState<string | null>(
    getStoredConversationId,
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [restoring, setRestoring] = useState(conversationId !== null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endOfMessages = useRef<HTMLDivElement>(null);
  const initialConversationId = useRef(conversationId);

  const checkHealth = useCallback(async (signal?: AbortSignal) => {
    setHealth({ kind: "loading" });
    try {
      const result = await fetch(
        `${apiBaseUrl}/health`,
        signal === undefined ? {} : { signal },
      );
      const body = healthResponseSchema.parse(await result.json());
      if (!result.ok || body.status !== "ok") {
        throw new Error("The demo database is not ready.");
      }
      setHealth({ kind: "ready", response: body });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError")
        return;
      setHealth({
        kind: "error",
        message: messageFrom(caught, "The Worker could not be reached."),
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void checkHealth(controller.signal);
    return () => controller.abort();
  }, [checkHealth]);

  useEffect(() => {
    const storedConversationId = initialConversationId.current;
    if (storedConversationId === null) {
      setRestoring(false);
      return;
    }
    const controller = new AbortController();
    setRestoring(true);
    void fetch(
      `${apiBaseUrl}/conversations/${encodeURIComponent(storedConversationId)}/messages`,
      {
        headers: { "X-Demo-Session-Id": sessionId },
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) {
          const body = apiErrorResponseSchema.safeParse(await response.json());
          if (
            response.status === 404 ||
            (body.success && body.data.error.code === "conversation_not_found")
          ) {
            localStorage.removeItem(conversationStorageKey);
            setConversationId(null);
            setMessages([]);
            return;
          }
          throw new Error(
            body.success
              ? body.data.error.message
              : "Chat history could not be restored.",
          );
        }
        const body = conversationMessagesResponseSchema.parse(
          await response.json(),
        );
        setMessages(body.messages);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError")
          return;
        setError(messageFrom(caught, "Chat history could not be restored."));
      })
      .finally(() => setRestoring(false));
    return () => controller.abort();
  }, [sessionId]);

  useEffect(() => {
    endOfMessages.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function sendQuestion(value: string): Promise<void> {
    const submitted = value.trim();
    if (
      submitted.length === 0 ||
      submitted.length > maximumQuestionLength ||
      sending
    ) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Demo-Session-Id": sessionId,
        },
        body: JSON.stringify({
          question: submitted,
          ...(conversationId === null ? {} : { conversationId }),
        }),
      });
      const raw: unknown = await response.json();
      if (!response.ok) {
        const parsedError = apiErrorResponseSchema.safeParse(raw);
        throw new Error(
          parsedError.success
            ? parsedError.data.error.message
            : "The question could not be answered.",
        );
      }
      const body = chatResponseSchema.parse(raw);
      localStorage.setItem(conversationStorageKey, body.conversationId);
      setConversationId(body.conversationId);
      setMessages((current) => [
        ...current,
        body.userMessage,
        body.assistantMessage,
      ]);
      setQuestion("");
    } catch (caught) {
      setQuestion(submitted);
      setError(messageFrom(caught, "The question could not be answered."));
    } finally {
      setSending(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void sendQuestion(question);
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendQuestion(question);
    }
  }

  function startNewChat(): void {
    localStorage.removeItem(conversationStorageKey);
    setConversationId(null);
    setMessages([]);
    setQuestion("");
    setError(null);
  }

  const remaining = maximumQuestionLength - question.length;
  const readyToSend =
    question.trim().length > 0 && remaining >= 0 && !sending && !restoring;

  return (
    <main className="min-h-screen bg-[#0b0d0c] text-stone-100">
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 sm:px-7">
        <header className="flex items-center justify-between gap-4 border-b border-white/10 py-4">
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-emerald-300 text-sm font-black text-emerald-950">
              KG
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">
                Engineering Knowledge Gardener
              </p>
              <p className="text-xs text-stone-500">Fictional demo knowledge</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <HealthBadge health={health} retry={() => void checkHealth()} />
            <button
              className="rounded-lg border border-white/10 px-3 py-2 text-xs font-semibold text-stone-300 transition hover:border-white/25 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
              onClick={startNewChat}
              type="button"
            >
              New chat
            </button>
          </div>
        </header>

        <section className="grid flex-1 gap-8 py-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:py-8">
          <aside className="hidden lg:block">
            <p className="font-mono text-[0.68rem] uppercase tracking-[0.22em] text-emerald-300">
              Grounded answers
            </p>
            <p className="mt-3 text-sm leading-6 text-stone-500">
              Answers are limited to four controlled engineering documents.
              Every supported claim should point back to an exact excerpt.
            </p>
            <div className="mt-6 border-t border-white/10 pt-5 text-xs leading-5 text-stone-600">
              Workers AI · D1 memory
              <br />
              No personal Notion data
            </div>
          </aside>

          <div className="flex min-h-[calc(100vh-8.5rem)] min-w-0 flex-col rounded-3xl border border-white/10 bg-white/[0.025] shadow-2xl shadow-black/20">
            <div
              aria-live="polite"
              className="flex-1 overflow-y-auto px-4 py-6 sm:px-7"
              role="log"
            >
              {restoring ? (
                <StatusMessage>Restoring this conversation…</StatusMessage>
              ) : messages.length === 0 ? (
                <EmptyState onSelect={(prompt) => void sendQuestion(prompt)} />
              ) : (
                <div className="space-y-7">
                  {messages.map((message) => (
                    <MessageCard key={message.id} message={message} />
                  ))}
                </div>
              )}
              {sending ? (
                <StatusMessage>Searching the demo sources…</StatusMessage>
              ) : null}
              <div ref={endOfMessages} />
            </div>

            <div className="border-t border-white/10 p-4 sm:p-5">
              {error === null ? null : (
                <div
                  className="mb-3 flex items-center justify-between gap-4 rounded-xl bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
                  role="alert"
                >
                  <span>{error}</span>
                  <button
                    className="shrink-0 font-semibold underline underline-offset-4"
                    disabled={!readyToSend}
                    onClick={() => void sendQuestion(question)}
                    type="button"
                  >
                    Try again
                  </button>
                </div>
              )}
              <form onSubmit={submit}>
                <label className="sr-only" htmlFor="question">
                  Ask the engineering knowledge base
                </label>
                <div className="rounded-2xl border border-white/10 bg-black/20 p-3 focus-within:border-emerald-300/50">
                  <textarea
                    className="max-h-40 min-h-20 w-full resize-y bg-transparent px-1 text-[0.95rem] leading-6 text-stone-100 outline-none placeholder:text-stone-600"
                    disabled={restoring}
                    id="question"
                    maxLength={maximumQuestionLength}
                    onChange={(event) => setQuestion(event.target.value)}
                    onKeyDown={handleComposerKeyDown}
                    placeholder="Ask about an architecture decision, incident, runbook, or setup…"
                    value={question}
                  />
                  <div className="mt-2 flex items-center justify-between gap-4">
                    <span
                      className={`text-xs ${remaining < 100 ? "text-amber-300" : "text-stone-600"}`}
                    >
                      {remaining.toLocaleString()} characters left
                    </span>
                    <button
                      className="rounded-xl bg-emerald-300 px-4 py-2 text-sm font-bold text-emerald-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
                      disabled={!readyToSend}
                      type="submit"
                    >
                      {sending ? "Answering…" : "Ask"}
                    </button>
                  </div>
                </div>
              </form>
              <p className="mt-3 text-center text-[0.68rem] text-stone-600">
                Demo answers may be incomplete. Verify the cited fictional
                sources.
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function EmptyState({ onSelect }: { onSelect: (prompt: string) => void }) {
  return (
    <div className="mx-auto flex min-h-[18rem] max-w-2xl flex-col justify-center">
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-emerald-300">
        Explore the fixture garden
      </p>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
        Ask what the engineering docs actually say.
      </h1>
      <p className="mt-4 max-w-xl leading-7 text-stone-400">
        This public-safe demo answers from controlled architecture, incident,
        deployment, and onboarding notes—and refuses questions they cannot
        support.
      </p>
      <div className="mt-6 grid gap-3 sm:grid-cols-2">
        {starters.map((prompt) => (
          <button
            className="rounded-2xl border border-white/10 bg-white/[0.03] p-3.5 text-left text-sm leading-6 text-stone-300 transition hover:border-emerald-300/30 hover:bg-emerald-300/[0.04] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-300"
            key={prompt}
            onClick={() => onSelect(prompt)}
            type="button"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageCard({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <article className="ml-auto max-w-2xl rounded-2xl rounded-br-md bg-stone-100 px-4 py-3 text-sm leading-6 text-stone-900">
        {message.content}
      </article>
    );
  }
  return (
    <article className="max-w-3xl">
      <div className="mb-3 flex items-center gap-3">
        <span className="grid size-7 place-items-center rounded-lg bg-emerald-300 text-[0.65rem] font-black text-emerald-950">
          KG
        </span>
        {message.confidence === null ? null : (
          <span className="rounded-full border border-white/10 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wider text-stone-400">
            {message.confidence} confidence
          </span>
        )}
      </div>
      <p className="whitespace-pre-wrap text-[0.95rem] leading-7 text-stone-200">
        {message.content}
      </p>
      {message.citations.length > 0 ? (
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {message.citations.map((citation) => (
            <section
              className="rounded-2xl border border-white/10 bg-white/[0.025] p-4"
              key={citation.chunkId}
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="text-sm font-semibold text-stone-200">
                  {citation.source.title}
                </h2>
                <span className="shrink-0 rounded-full bg-sky-300/10 px-2 py-1 text-[0.6rem] font-semibold uppercase tracking-wider text-sky-200">
                  Fictional
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-stone-600">
                {citation.source.breadcrumb.join(" / ")}
              </p>
              <blockquote className="mt-3 border-l-2 border-emerald-300/50 pl-3 text-xs leading-5 text-stone-400">
                “{citation.quote}”
              </blockquote>
            </section>
          ))}
        </div>
      ) : null}
      {message.unansweredQuestions.length > 0 ? (
        <div className="mt-4 rounded-xl bg-amber-300/[0.06] px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-amber-200">
            Still unanswered
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-4 text-sm text-stone-400">
            {message.unansweredQuestions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  );
}

function StatusMessage({ children }: { children: string }) {
  return (
    <p
      className="my-6 flex items-center gap-2 text-sm text-stone-500"
      role="status"
    >
      <span className="size-2 animate-pulse rounded-full bg-emerald-300" />
      {children}
    </p>
  );
}

function HealthBadge({
  health,
  retry,
}: {
  health: HealthState;
  retry: () => void;
}) {
  if (health.kind === "error") {
    return (
      <button
        className="flex items-center gap-2 rounded-full bg-rose-300/10 px-3 py-2 text-xs text-rose-200"
        onClick={retry}
        title={health.message}
        type="button"
      >
        <span className="size-2 rounded-full bg-rose-300" />
        Retry Worker
      </button>
    );
  }
  const ready = health.kind === "ready";
  return (
    <span
      className="hidden items-center gap-2 rounded-full border border-white/10 px-3 py-2 text-xs text-stone-400 sm:flex"
      role="status"
    >
      <span
        className={`size-2 rounded-full ${ready ? "bg-emerald-300" : "animate-pulse bg-amber-300"}`}
      />
      {ready ? `${health.response.mode} ready` : "Checking"}
    </span>
  );
}

function getOrCreateSessionId(): string {
  const stored = localStorage.getItem(sessionStorageKey);
  if (idSchema.safeParse(stored).success && stored !== null) return stored;
  const created = crypto.randomUUID();
  localStorage.setItem(sessionStorageKey, created);
  return created;
}

function getStoredConversationId(): string | null {
  const stored = localStorage.getItem(conversationStorageKey);
  if (idSchema.safeParse(stored).success && stored !== null) return stored;
  localStorage.removeItem(conversationStorageKey);
  return null;
}

function messageFrom(value: unknown, fallback: string): string {
  return value instanceof Error ? value.message : fallback;
}
