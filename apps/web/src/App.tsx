import {
  healthResponseSchema,
  type HealthResponse,
} from "@knowledge-gardener/domain";
import { useCallback, useEffect, useState } from "react";

type HealthState =
  | { kind: "loading" }
  | { kind: "ready"; response: HealthResponse }
  | { kind: "error"; message: string };

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8787"
).replace(/\/$/, "");

export function App() {
  const [health, setHealth] = useState<HealthState>({ kind: "loading" });

  const checkHealth = useCallback(async (signal?: AbortSignal) => {
    setHealth({ kind: "loading" });
    try {
      const result = await fetch(
        `${apiBaseUrl}/health`,
        signal === undefined ? {} : { signal },
      );
      const body = healthResponseSchema.parse(await result.json());
      if (!result.ok || body.status !== "ok") {
        throw new Error("The local database is not ready.");
      }
      setHealth({ kind: "ready", response: body });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setHealth({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The Worker health check could not be completed.",
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void checkHealth(controller.signal);
    return () => controller.abort();
  }, [checkHealth]);

  return (
    <main className="min-h-screen bg-stone-950 px-6 py-12 text-stone-100 sm:px-10">
      <div className="mx-auto flex min-h-[calc(100vh-6rem)] max-w-5xl flex-col justify-between">
        <header className="flex items-center justify-between gap-6 border-b border-white/10 pb-5">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl bg-emerald-300 text-lg font-black text-emerald-950">
              KG
            </span>
            <span className="text-sm font-semibold tracking-wide text-stone-200">
              Engineering Knowledge Gardener
            </span>
          </div>
          <span className="rounded-full border border-amber-300/30 bg-amber-300/10 px-3 py-1 text-xs font-medium text-amber-200">
            Phase 0 foundation
          </span>
        </header>

        <section className="grid gap-12 py-20 lg:grid-cols-[1fr_22rem] lg:items-end">
          <div>
            <p className="mb-5 font-mono text-xs uppercase tracking-[0.25em] text-emerald-300">
              Private · grounded · reviewable
            </p>
            <h1 className="max-w-3xl text-5xl font-semibold leading-[1.05] tracking-[-0.04em] text-balance sm:text-7xl">
              Keep engineering knowledge useful.
            </h1>
            <p className="mt-7 max-w-2xl text-lg leading-8 text-stone-400">
              A source-grounded assistant for exploring documentation, proposing
              careful improvements, and drafting new knowledge for human
              approval.
            </p>
          </div>

          <aside className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 shadow-2xl shadow-black/30">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-widest text-stone-500">
                  Local foundation
                </p>
                <h2 className="mt-2 text-xl font-semibold">System health</h2>
              </div>
              <HealthIndicator state={health} />
            </div>

            <dl className="mt-8 space-y-4 text-sm">
              <HealthRow
                label="Worker"
                state={
                  health.kind === "ready"
                    ? "Ready"
                    : health.kind === "error"
                      ? "Unavailable"
                      : "Checking"
                }
              />
              <HealthRow
                label="D1 database"
                state={
                  health.kind === "ready" &&
                  health.response.checks.database === "ok"
                    ? "Ready"
                    : health.kind === "error"
                      ? "Unavailable"
                      : "Checking"
                }
              />
              <HealthRow
                label="Mode"
                state={health.kind === "ready" ? health.response.mode : "demo"}
              />
            </dl>

            {health.kind === "error" ? (
              <div className="mt-6 rounded-2xl bg-rose-400/10 p-4" role="alert">
                <p className="text-sm leading-6 text-rose-200">
                  {health.message}
                </p>
                <button
                  className="mt-3 rounded-lg bg-rose-200 px-3 py-2 text-sm font-semibold text-rose-950 transition hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-200"
                  onClick={() => void checkHealth()}
                  type="button"
                >
                  Retry health check
                </button>
              </div>
            ) : null}
          </aside>
        </section>

        <footer className="flex flex-wrap justify-between gap-4 border-t border-white/10 py-5 text-xs text-stone-500">
          <span>Controlled fictional fixtures only</span>
          <span>Chat and live Notion access arrive in later phases</span>
        </footer>
      </div>
    </main>
  );
}

function HealthIndicator({ state }: { state: HealthState }) {
  const color =
    state.kind === "ready"
      ? "bg-emerald-300"
      : state.kind === "error"
        ? "bg-rose-300"
        : "bg-amber-300";
  const label =
    state.kind === "ready"
      ? "Ready"
      : state.kind === "error"
        ? "Unavailable"
        : "Checking";

  return (
    <span
      className="flex items-center gap-2 text-xs text-stone-400"
      role="status"
    >
      <span className={`size-2 rounded-full ${color}`} aria-hidden="true" />
      {label}
    </span>
  );
}

function HealthRow({ label, state }: { label: string; state: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-white/5 pb-4 last:border-0 last:pb-0">
      <dt className="text-stone-500">{label}</dt>
      <dd className="font-mono text-xs text-stone-200">{state}</dd>
    </div>
  );
}
