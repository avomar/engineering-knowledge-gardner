import {
  apiErrorResponseSchema,
  chatResponseSchema,
  conversationMessagesResponseSchema,
  documentSearchResponseSchema,
  healthResponseSchema,
  idSchema,
  syncDetailResponseSchema,
  syncOverviewResponseSchema,
  syncStartResponseSchema,
  type ChatMessage,
  type DocumentSearchItem,
  type HealthResponse,
  type SyncOverviewResponse,
  type SyncRun,
  type SyncRunDocument,
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

const apiBaseUrl = "/api";
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
        headers: { "X-Client-Session-Id": sessionId },
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
          "X-Client-Session-Id": sessionId,
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

  if (health.kind === "ready" && health.response.mode === "live") {
    return (
      <LiveWorkspace
        configured={health.response.checks.sourceConfiguration === "ok"}
        health={health}
        retryHealth={() => void checkHealth()}
      />
    );
  }

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

type LiveView = "chat" | "sync" | "sources";

function LiveWorkspace({
  configured,
  health,
  retryHealth,
}: {
  configured: boolean;
  health: HealthState;
  retryHealth: () => void;
}) {
  const [view, setView] = useState<LiveView>("sync");
  const [overview, setOverview] = useState<SyncOverviewResponse | null>(null);
  const [detail, setDetail] = useState<SyncRunDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialViewResolved = useRef(false);

  const loadOverview = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/sync`);
      const raw: unknown = await response.json();
      if (!response.ok)
        throw apiFailure(raw, "Synchronization status is unavailable.");
      const next = syncOverviewResponseSchema.parse(raw);
      setOverview(next);
      const active = next.runs.find((run) => isActive(run));
      if (active !== undefined) {
        const detailResponse = await fetch(`${apiBaseUrl}/sync/${active.id}`);
        if (detailResponse.ok) {
          const detailBody = syncDetailResponseSchema.parse(
            await detailResponse.json(),
          );
          setDetail(detailBody.documents);
        }
      } else if (next.runs[0] !== undefined) {
        const detailResponse = await fetch(
          `${apiBaseUrl}/sync/${next.runs[0].id}`,
        );
        if (detailResponse.ok) {
          const detailBody = syncDetailResponseSchema.parse(
            await detailResponse.json(),
          );
          setDetail(detailBody.documents);
        }
      }
      setError(null);
    } catch (caught) {
      setError(messageFrom(caught, "Synchronization status is unavailable."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const activeRun = overview?.runs.find((run) => isActive(run));
  useEffect(() => {
    if (overview === null || initialViewResolved.current) return;
    initialViewResolved.current = true;
    if (
      overview?.knowledgeSpace !== null &&
      overview?.knowledgeSpace !== undefined &&
      overview.runs.some(
        (run) => run.status === "completed" || run.status === "partial",
      )
    ) {
      setView("chat");
    }
  }, [overview]);
  useEffect(() => {
    if (activeRun === undefined) return;
    const timer = window.setInterval(() => void loadOverview(), 2_000);
    return () => window.clearInterval(timer);
  }, [activeRun?.id, loadOverview]);

  async function startSync() {
    if (!configured || starting || activeRun !== undefined) return;
    setStarting(true);
    setError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/sync`, { method: "POST" });
      const raw: unknown = await response.json();
      if (!response.ok)
        throw apiFailure(raw, "Synchronization could not be started.");
      syncStartResponseSchema.parse(raw);
      await loadOverview();
    } catch (caught) {
      setError(messageFrom(caught, "Synchronization could not be started."));
    } finally {
      setStarting(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#0b0d0c] text-stone-100">
      <div className="mx-auto min-h-screen max-w-6xl px-4 sm:px-7">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-white/10 py-4">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-xl bg-emerald-300 text-sm font-black text-emerald-950">
              KG
            </span>
            <div>
              <p className="text-sm font-semibold">
                Engineering Knowledge Gardener
              </p>
              <p className="text-xs text-stone-500">
                Private Notion source · read only
              </p>
            </div>
          </div>
          <HealthBadge health={health} retry={retryHealth} />
        </header>
        <div className="grid gap-8 py-7 lg:grid-cols-[14rem_minmax(0,1fr)]">
          <nav aria-label="Live workspace" className="space-y-2">
            {(["chat", "sync", "sources"] as const).map((item) => (
              <button
                className={`w-full rounded-xl px-4 py-3 text-left text-sm font-semibold capitalize ${view === item ? "bg-emerald-300 text-emerald-950" : "text-stone-400 hover:bg-white/5 hover:text-white"}`}
                key={item}
                onClick={() => setView(item)}
                type="button"
              >
                {item}
              </button>
            ))}
            <div className="mt-6 border-t border-white/10 pt-5 text-xs leading-5 text-stone-600">
              Answers are grounded in your indexed Notion sources. Verify
              important decisions against the cited page.
            </div>
          </nav>
          <section className="min-w-0">
            {!configured ? (
              <Notice title="Notion is not configured">
                Add the token and root page ID to the ignored live variables
                file, migrate the live database, and restart the Worker.
              </Notice>
            ) : view === "chat" ? (
              <LiveChat
                onOpenSync={() => setView("sync")}
                ready={
                  overview?.knowledgeSpace !== null &&
                  overview?.knowledgeSpace !== undefined &&
                  overview.runs.some(
                    (run) =>
                      run.status === "completed" || run.status === "partial",
                  )
                }
              />
            ) : view === "sync" ? (
              <SyncView
                detail={detail}
                error={error}
                loading={loading}
                onStart={() => void startSync()}
                overview={overview}
                starting={starting}
              />
            ) : (
              <SourcesView />
            )}
          </section>
        </div>
      </div>
    </main>
  );
}

const liveSessionStorageKey = "knowledge-gardener.live-session-id";
const liveConversationStorageKey = "knowledge-gardener.live-conversation-id";

function LiveChat({
  onOpenSync,
  ready,
}: {
  onOpenSync: () => void;
  ready: boolean;
}) {
  const [sessionId] = useState(() => getOrCreateId(liveSessionStorageKey));
  const [conversationId, setConversationId] = useState(() =>
    getStoredId(liveConversationStorageKey),
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (conversationId === null) return;
    const controller = new AbortController();
    void fetch(`${apiBaseUrl}/conversations/${conversationId}/messages`, {
      headers: { "X-Client-Session-Id": sessionId },
      signal: controller.signal,
    })
      .then(async (response) => {
        const raw: unknown = await response.json();
        if (!response.ok)
          throw apiFailure(raw, "Chat history could not be restored.");
        setMessages(conversationMessagesResponseSchema.parse(raw).messages);
      })
      .catch(() => {
        localStorage.removeItem(liveConversationStorageKey);
        setConversationId(null);
      });
    return () => controller.abort();
  }, [conversationId, sessionId]);

  async function send() {
    const submitted = question.trim();
    if (
      !ready ||
      submitted.length === 0 ||
      submitted.length > maximumQuestionLength ||
      sending
    )
      return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`${apiBaseUrl}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Client-Session-Id": sessionId,
        },
        body: JSON.stringify({
          question: submitted,
          ...(conversationId === null ? {} : { conversationId }),
        }),
      });
      const raw: unknown = await response.json();
      if (!response.ok)
        throw apiFailure(raw, "The question could not be answered.");
      const result = chatResponseSchema.parse(raw);
      localStorage.setItem(liveConversationStorageKey, result.conversationId);
      setConversationId(result.conversationId);
      setMessages((current) => [
        ...current,
        result.userMessage,
        result.assistantMessage,
      ]);
      setQuestion("");
    } catch (caught) {
      setError(messageFrom(caught, "The question could not be answered."));
      setQuestion(submitted);
    } finally {
      setSending(false);
    }
  }

  if (!ready) {
    return (
      <div>
        <Notice title="Sync before asking">
          This Notion root has no completed synchronization yet. Run a sync,
          then return here to ask grounded questions.
        </Notice>
        <button
          className="mt-4 rounded-xl bg-emerald-300 px-4 py-2 text-sm font-bold text-emerald-950"
          onClick={onOpenSync}
          type="button"
        >
          Open sync
        </button>
      </div>
    );
  }
  return (
    <div className="flex min-h-[calc(100vh-13rem)] flex-col rounded-2xl border border-white/10 bg-white/[0.025]">
      <div className="border-b border-white/10 px-5 py-4">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-emerald-300">
          Grounded chat
        </p>
        <p className="mt-2 text-sm text-stone-400">
          Searching your indexed Notion sources. Answers can be incomplete;
          verify citations.
        </p>
      </div>
      <div className="flex-1 space-y-6 overflow-y-auto p-5" role="log">
        {messages.length === 0 ? (
          <Notice title="Ask your knowledge garden">
            Ask about a runbook, incident, or architecture decision in the
            synchronized Notion hierarchy.
          </Notice>
        ) : (
          messages.map((message) => (
            <MessageCard key={message.id} live message={message} />
          ))
        )}
        {sending ? (
          <StatusMessage>Searching your indexed Notion sources…</StatusMessage>
        ) : null}
      </div>
      <form
        className="border-t border-white/10 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {error === null ? null : (
          <div
            className="mb-3 rounded-xl bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
            role="alert"
          >
            {error}
          </div>
        )}
        <textarea
          aria-label="Ask the live knowledge base"
          className="min-h-24 w-full rounded-xl border border-white/10 bg-black/20 p-3 text-sm outline-none focus:border-emerald-300/50"
          maxLength={maximumQuestionLength}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder="Ask about your indexed Notion sources…"
          value={question}
        />
        <div className="mt-3 flex justify-between gap-3">
          <button
            className="rounded-xl border border-white/10 px-4 py-2 text-sm"
            onClick={() => {
              localStorage.removeItem(liveConversationStorageKey);
              setConversationId(null);
              setMessages([]);
            }}
            type="button"
          >
            New chat
          </button>
          <button
            className="rounded-xl bg-emerald-300 px-4 py-2 text-sm font-bold text-emerald-950 disabled:opacity-40"
            disabled={sending || question.trim().length === 0}
            type="submit"
          >
            {sending ? "Answering…" : "Ask"}
          </button>
        </div>
      </form>
    </div>
  );
}

function SyncView({
  detail,
  error,
  loading,
  onStart,
  overview,
  starting,
}: {
  detail: SyncRunDocument[];
  error: string | null;
  loading: boolean;
  onStart: () => void;
  overview: SyncOverviewResponse | null;
  starting: boolean;
}) {
  const run = overview?.runs[0];
  const active = run !== undefined && isActive(run);
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-emerald-300">
            Knowledge synchronization
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">
            Keep the source garden current.
          </h1>
          <p className="mt-3 max-w-2xl leading-7 text-stone-400">
            Reads only the configured Notion root, its child pages, and
            descendant database rows.
          </p>
        </div>
        <button
          className="rounded-xl bg-emerald-300 px-5 py-3 text-sm font-bold text-emerald-950 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={starting || active}
          onClick={onStart}
          type="button"
        >
          {starting ? "Starting…" : active ? "Sync in progress" : "Start sync"}
        </button>
      </div>
      {error === null ? null : (
        <div
          className="mt-6 rounded-xl bg-rose-400/10 px-4 py-3 text-sm text-rose-200"
          role="alert"
        >
          {error}
        </div>
      )}
      {loading ? (
        <StatusMessage>Loading synchronization status…</StatusMessage>
      ) : run === undefined ? (
        <Notice title="No synchronization yet">
          Start the first read-only import from the selected Notion root.
        </Notice>
      ) : (
        <>
          <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.025] p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wider text-stone-500">
                  Latest run
                </p>
                <p className="mt-1 text-lg font-semibold capitalize">
                  {run.status}
                </p>
              </div>
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${run.status === "completed" ? "bg-emerald-300/10 text-emerald-200" : run.status === "partial" || run.status === "failed" ? "bg-amber-300/10 text-amber-200" : "bg-sky-300/10 text-sky-200"}`}
              >
                {run.status}
              </span>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Metric label="Discovered" value={run.discoveredCount} />
              <Metric label="Indexed" value={run.indexedCount} />
              <Metric label="Skipped" value={run.skippedCount} />
              <Metric label="Failed" value={run.failedCount} />
              <Metric label="Deleted" value={run.deletedCount} />
            </div>
            {run.errorSummary === null ? null : (
              <p className="mt-5 rounded-xl bg-amber-300/[0.06] px-4 py-3 text-sm text-amber-100">
                {run.errorSummary}
              </p>
            )}
            <p className="mt-4 text-xs text-stone-600">
              Started {formatDate(run.startedAt ?? run.createdAt)} · Last
              successful sync{" "}
              {formatDate(
                overview?.knowledgeSpace?.lastSuccessfulSyncAt ?? null,
              )}
            </p>
          </div>
          {detail.filter((item) => item.outcome === "failed").length > 0 ? (
            <div className="mt-6">
              <h2 className="text-sm font-semibold">
                Documents needing attention
              </h2>
              <div className="mt-3 space-y-3">
                {detail
                  .filter((item) => item.outcome === "failed")
                  .map((item) => (
                    <div
                      className="rounded-xl border border-amber-300/20 px-4 py-3"
                      key={item.id}
                    >
                      <p className="text-sm font-semibold">{item.title}</p>
                      <p className="mt-1 text-xs text-stone-500">
                        {item.errorMessage ??
                          "This document could not be synchronized."}
                      </p>
                    </div>
                  ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function SourcesView() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<DocumentSearchItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(
    async (append = false, nextCursor?: string) => {
      setLoading(true);
      try {
        const parameters = new URLSearchParams({ q: query, limit: "20" });
        if (status) parameters.set("status", status);
        if (nextCursor) parameters.set("cursor", nextCursor);
        const response = await fetch(
          `${apiBaseUrl}/documents/search?${parameters.toString()}`,
        );
        const raw: unknown = await response.json();
        if (!response.ok) throw apiFailure(raw, "Sources could not be loaded.");
        const body = documentSearchResponseSchema.parse(raw);
        setItems((current) =>
          append ? [...current, ...body.items] : body.items,
        );
        setCursor(body.nextCursor);
        setError(null);
      } catch (caught) {
        setError(messageFrom(caught, "Sources could not be loaded."));
      } finally {
        setLoading(false);
      }
    },
    [query, status],
  );

  useEffect(() => {
    void search();
  }, []);

  return (
    <div>
      <p className="font-mono text-xs uppercase tracking-[0.2em] text-emerald-300">
        Indexed sources
      </p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight">
        Browse what the assistant can use.
      </h1>
      <form
        className="mt-6 flex flex-wrap gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
      >
        <input
          aria-label="Search sources"
          className="min-w-56 flex-1 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm outline-none focus:border-emerald-300/50"
          maxLength={100}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search titles and content…"
          value={query}
        />
        <select
          aria-label="Filter source status"
          className="rounded-xl border border-white/10 bg-[#151816] px-4 py-3 text-sm"
          onChange={(event) => setStatus(event.target.value)}
          value={status}
        >
          <option value="">All states</option>
          <option value="indexed">Indexed</option>
          <option value="stale">Stale</option>
          <option value="failed">Failed</option>
        </select>
        <button
          className="rounded-xl bg-emerald-300 px-5 py-3 text-sm font-bold text-emerald-950"
          type="submit"
        >
          Search
        </button>
      </form>
      {error === null ? null : (
        <div className="mt-5 text-sm text-rose-200" role="alert">
          {error}
        </div>
      )}
      {loading && items.length === 0 ? (
        <StatusMessage>Loading indexed sources…</StatusMessage>
      ) : items.length === 0 ? (
        <Notice title="No indexed sources">
          Run a synchronization or adjust the search.
        </Notice>
      ) : (
        <div className="mt-6 grid gap-4">
          {items.map((item) => (
            <SourceRow item={item} key={item.id} />
          ))}
          {cursor === null ? null : (
            <button
              className="rounded-xl border border-white/10 px-4 py-3 text-sm text-stone-300"
              disabled={loading}
              onClick={() => void search(true, cursor)}
              type="button"
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SourceRow({ item }: { item: DocumentSearchItem }) {
  const link = safeLiveSourceUrl(item.sourceUrl);
  return (
    <article className="rounded-2xl border border-white/10 bg-white/[0.025] p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          {link === null ? (
            <h2 className="font-semibold">{item.title}</h2>
          ) : (
            <h2>
              <a
                className="font-semibold text-emerald-200 hover:underline"
                href={link}
                rel="noopener noreferrer"
                target="_blank"
              >
                {item.title}
              </a>
            </h2>
          )}
          <p className="mt-1 text-xs text-stone-600">
            {item.breadcrumb.join(" / ")}
          </p>
        </div>
        <span className="rounded-full border border-white/10 px-2.5 py-1 text-[0.65rem] font-semibold uppercase tracking-wider text-stone-400">
          {item.indexStatus}
        </span>
      </div>
      {item.excerpt === null ? null : (
        <p className="mt-4 line-clamp-3 whitespace-pre-wrap text-sm leading-6 text-stone-400">
          {item.excerpt}
        </p>
      )}
      <p className="mt-4 text-xs text-stone-600">
        Edited {formatDate(item.lastEditedAt)} · Checked{" "}
        {formatDate(item.lastSyncedAt)}
      </p>
      {item.errorMessage === null ? null : (
        <p className="mt-3 text-xs text-amber-200">{item.errorMessage}</p>
      )}
    </article>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl bg-black/20 px-3 py-3">
      <p className="text-xl font-semibold">{value}</p>
      <p className="text-[0.65rem] uppercase tracking-wider text-stone-600">
        {label}
      </p>
    </div>
  );
}

function Notice({ children, title }: { children: string; title: string }) {
  return (
    <div className="mt-8 rounded-2xl border border-white/10 bg-white/[0.025] p-6">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-400">
        {children}
      </p>
    </div>
  );
}

function isActive(run: SyncRun): boolean {
  return run.status === "queued" || run.status === "running";
}

function formatDate(value: string | null): string {
  return value === null ? "never" : new Date(value).toLocaleString();
}

function safeLiveSourceUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      ["notion.so", "www.notion.so", "notion.com", "www.notion.com"].includes(
        url.hostname,
      )
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function apiFailure(value: unknown, fallback: string): Error {
  const parsed = apiErrorResponseSchema.safeParse(value);
  return new Error(parsed.success ? parsed.data.error.message : fallback);
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

function MessageCard({
  live = false,
  message,
}: {
  live?: boolean;
  message: ChatMessage;
}) {
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
                  {live &&
                  safeLiveSourceUrl(citation.source.sourceUrl) !== null ? (
                    <a
                      className="text-emerald-200 hover:underline"
                      href={safeLiveSourceUrl(citation.source.sourceUrl)!}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      {citation.source.title}
                    </a>
                  ) : (
                    citation.source.title
                  )}
                </h2>
                <span className="shrink-0 rounded-full bg-sky-300/10 px-2 py-1 text-[0.6rem] font-semibold uppercase tracking-wider text-sky-200">
                  {live ? citation.source.sourceState : "Fictional"}
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
  return getOrCreateId(sessionStorageKey);
}

function getOrCreateId(storageKey: string): string {
  const stored = localStorage.getItem(storageKey);
  if (idSchema.safeParse(stored).success && stored !== null) return stored;
  const created = crypto.randomUUID();
  localStorage.setItem(storageKey, created);
  return created;
}

function getStoredConversationId(): string | null {
  return getStoredId(conversationStorageKey);
}

function getStoredId(storageKey: string): string | null {
  const stored = localStorage.getItem(storageKey);
  if (idSchema.safeParse(stored).success && stored !== null) return stored;
  localStorage.removeItem(storageKey);
  return null;
}

function messageFrom(value: unknown, fallback: string): string {
  return value instanceof Error ? value.message : fallback;
}
