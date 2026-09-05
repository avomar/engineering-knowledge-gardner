import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { SourceAdapterError } from "@knowledge-gardener/source";

import { checksum, chunkDocument, stableUuid } from "./chunking";
import type { Env } from "./env";
import {
  discoverNotionDocuments,
  normalizeNotionId,
  NotionClient,
} from "./notion";

export interface SyncWorkflowParams {
  runId: string;
  knowledgeSpaceId: string;
  rootId: string;
}

interface ExistingDocument {
  id: string;
  source_page_id: string;
  checksum: string;
}

export class KnowledgeSyncWorkflow extends WorkflowEntrypoint<
  Env,
  SyncWorkflowParams
> {
  override async run(
    event: WorkflowEvent<SyncWorkflowParams>,
    step: WorkflowStep,
  ) {
    const params = event.payload;
    const startedAt = new Date().toISOString();
    await step.do("mark sync running", async () => {
      await assertRunWrite(
        this.env.DB.prepare(
          "UPDATE sync_runs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status IN ('queued', 'running')",
        )
          .bind(startedAt, params.runId)
          .run(),
      );
    });

    try {
      return await step.do(
        "synchronize notion hierarchy",
        {
          retries: { limit: 2, delay: "2 seconds", backoff: "exponential" },
          timeout: "10 minutes",
        },
        async () => await synchronize(this.env, params),
      );
    } catch (error) {
      const completedAt = new Date().toISOString();
      await step.do("mark sync failed", async () => {
        await assertRunWrite(
          this.env.DB.prepare(
            `UPDATE sync_runs SET status = 'failed', completed_at = ?,
           error_code = ?, error_summary = ? WHERE id = ?`,
          )
            .bind(
              completedAt,
              safeErrorCode(error),
              safeErrorMessage(error),
              params.runId,
            )
            .run(),
        );
      });
      throw new NonRetryableError("Synchronization failed.");
    }
  }
}

export async function synchronize(env: Env, params: SyncWorkflowParams) {
  if (!env.NOTION_TOKEN || !env.NOTION_ROOT_PAGE_ID) {
    throw new NonRetryableError("The live source is not configured.");
  }
  const client = new NotionClient(env.NOTION_TOKEN, {
    log: (record) => console.log(JSON.stringify(record)),
  });
  const discovery = await discoverNotionDocuments(client, params.rootId, 51);
  const selected = discovery.documents.slice(0, 50);
  const discoveryComplete =
    discovery.complete && discovery.documents.length <= 50;
  const seen = new Set<string>();
  const counts = { indexed: 0, skipped: 0, failed: 0, deleted: 0, chunks: 0 };
  const now = new Date().toISOString();

  for (const failure of discovery.failures) {
    const existing = await env.DB.prepare(
      "SELECT id FROM documents WHERE knowledge_space_id = ? AND source_page_id = ?",
    )
      .bind(params.knowledgeSpaceId, failure.sourcePageId)
      .first<{ id: string }>();
    const documentId =
      existing?.id ??
      (await stableUuid(`notion:document:${failure.sourcePageId}`));
    if (existing === null) {
      await assertRunWrite(
        env.DB.prepare(
          `INSERT INTO documents (
            id, knowledge_space_id, source_page_id, source_url,
            parent_source_page_id, title, breadcrumb_json, last_edited_at,
            checksum, index_status, last_synced_at, created_at, updated_at,
            metadata_json, last_sync_error_code, last_sync_error_message
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'failed', NULL, ?, ?, '{}', ?, ?)`,
        )
          .bind(
            documentId,
            params.knowledgeSpaceId,
            failure.sourcePageId,
            failure.sourceUrl,
            failure.parentSourcePageId,
            failure.title,
            JSON.stringify(failure.breadcrumb),
            now,
            now,
            now,
            failure.errorCode,
            failure.errorMessage,
          )
          .run(),
      );
    } else {
      await assertRunWrite(
        env.DB.prepare(
          `UPDATE documents SET index_status = 'stale',
           last_sync_error_code = ?, last_sync_error_message = ?, updated_at = ?
           WHERE id = ?`,
        )
          .bind(failure.errorCode, failure.errorMessage, now, documentId)
          .run(),
      );
    }
    await recordOutcome(
      env.DB,
      params.runId,
      documentId,
      failure,
      "failed",
      now,
      failure.errorCode,
      failure.errorMessage,
    );
    counts.failed += 1;
  }

  for (const source of selected) {
    seen.add(source.sourcePageId);
    const documentChecksum = await checksum(
      JSON.stringify({
        title: source.title,
        breadcrumb: source.breadcrumb,
        metadata: source.metadata,
        contentMarkdown: source.contentMarkdown,
      }),
    );
    const existing = await env.DB.prepare(
      "SELECT id, source_page_id, checksum FROM documents WHERE knowledge_space_id = ? AND source_page_id = ?",
    )
      .bind(params.knowledgeSpaceId, source.sourcePageId)
      .first<ExistingDocument>();
    const documentId =
      existing?.id ??
      (await stableUuid(`notion:document:${source.sourcePageId}`));

    if (existing?.checksum === documentChecksum) {
      await assertRunWrite(
        env.DB.prepare(
          `UPDATE documents SET source_url = ?, parent_source_page_id = ?, title = ?,
         breadcrumb_json = ?, last_edited_at = ?, metadata_json = ?, index_status = 'indexed',
         last_synced_at = ?, last_sync_error_code = NULL, last_sync_error_message = NULL,
         updated_at = ? WHERE id = ?`,
        )
          .bind(
            source.sourceUrl,
            source.parentSourcePageId,
            source.title,
            JSON.stringify(source.breadcrumb),
            source.lastEditedAt,
            JSON.stringify(source.metadata),
            now,
            now,
            documentId,
          )
          .run(),
      );
      await recordOutcome(
        env.DB,
        params.runId,
        documentId,
        source,
        "skipped",
        now,
      );
      counts.skipped += 1;
      continue;
    }

    const chunks = await chunkDocument({
      documentId,
      sourcePageId: source.sourcePageId,
      title: source.title,
      breadcrumb: source.breadcrumb,
      markdown: source.contentMarkdown,
      createdAt: now,
    });
    if (counts.chunks + chunks.length > 2_000) {
      if (existing === null) {
        await assertRunWrite(
          env.DB.prepare(
            `INSERT INTO documents (
              id, knowledge_space_id, source_page_id, source_url,
              parent_source_page_id, title, breadcrumb_json, last_edited_at,
              checksum, index_status, last_synced_at, created_at, updated_at,
              metadata_json, last_sync_error_code, last_sync_error_message
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', 'failed', NULL, ?, ?, ?, 'chunk_limit', ?)`,
          )
            .bind(
              documentId,
              params.knowledgeSpaceId,
              source.sourcePageId,
              source.sourceUrl,
              source.parentSourcePageId,
              source.title,
              JSON.stringify(source.breadcrumb),
              source.lastEditedAt,
              now,
              now,
              JSON.stringify(source.metadata),
              "The synchronization chunk limit was reached.",
            )
            .run(),
        );
      } else {
        await assertRunWrite(
          env.DB.prepare(
            `UPDATE documents SET index_status = 'stale',
             last_sync_error_code = 'chunk_limit', last_sync_error_message = ?,
             updated_at = ? WHERE id = ?`,
          )
            .bind(
              "The synchronization chunk limit was reached.",
              now,
              documentId,
            )
            .run(),
        );
      }
      await recordOutcome(
        env.DB,
        params.runId,
        documentId,
        source,
        "failed",
        now,
        "chunk_limit",
        "The synchronization chunk limit was reached.",
      );
      counts.failed += 1;
      continue;
    }
    const statements = [
      env.DB.prepare(
        `INSERT INTO documents (
          id, knowledge_space_id, source_page_id, source_url, parent_source_page_id,
          title, breadcrumb_json, last_edited_at, checksum, index_status,
          last_synced_at, created_at, updated_at, metadata_json,
          last_sync_error_code, last_sync_error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'indexed', ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(knowledge_space_id, source_page_id) DO UPDATE SET
          source_url = excluded.source_url, parent_source_page_id = excluded.parent_source_page_id,
          title = excluded.title, breadcrumb_json = excluded.breadcrumb_json,
          last_edited_at = excluded.last_edited_at, checksum = excluded.checksum,
          index_status = 'indexed', last_synced_at = excluded.last_synced_at,
          updated_at = excluded.updated_at, metadata_json = excluded.metadata_json,
          last_sync_error_code = NULL, last_sync_error_message = NULL`,
      ).bind(
        documentId,
        params.knowledgeSpaceId,
        source.sourcePageId,
        source.sourceUrl,
        source.parentSourcePageId,
        source.title,
        JSON.stringify(source.breadcrumb),
        source.lastEditedAt,
        documentChecksum,
        now,
        now,
        now,
        JSON.stringify(source.metadata),
      ),
      env.DB.prepare("DELETE FROM document_chunks WHERE document_id = ?").bind(
        documentId,
      ),
      ...chunks.map((chunk) =>
        env.DB.prepare(
          `INSERT INTO document_chunks (id, document_id, ordinal, content, token_count, checksum, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          chunk.id,
          chunk.documentId,
          chunk.ordinal,
          chunk.content,
          chunk.tokenCount,
          chunk.checksum,
          chunk.createdAt,
        ),
      ),
    ];
    const results = await env.DB.batch(statements);
    for (const result of results) await assertRunWrite(Promise.resolve(result));
    await recordOutcome(
      env.DB,
      params.runId,
      documentId,
      source,
      "indexed",
      now,
    );
    counts.indexed += 1;
    counts.chunks += chunks.length;
  }

  if (discoveryComplete && counts.failed === 0) {
    const current = await env.DB.prepare(
      "SELECT id, source_page_id, title, source_url FROM documents WHERE knowledge_space_id = ?",
    )
      .bind(params.knowledgeSpaceId)
      .all<{
        id: string;
        source_page_id: string;
        title: string;
        source_url: string | null;
      }>();
    for (const document of current.results) {
      if (seen.has(document.source_page_id)) continue;
      await recordDeletedOutcome(env.DB, params.runId, document, now);
      await assertRunWrite(
        env.DB.prepare("DELETE FROM documents WHERE id = ?")
          .bind(document.id)
          .run(),
      );
      counts.deleted += 1;
    }
  }

  const partial = !discoveryComplete || counts.failed > 0;
  const status = partial ? "partial" : "completed";
  const summary = !discoveryComplete
    ? "The 50-document synchronization limit was reached."
    : counts.failed > 0
      ? "Some documents could not be synchronized."
      : null;
  await assertRunWrite(
    env.DB.prepare(
      `UPDATE sync_runs SET status = ?, completed_at = ?, discovered_count = ?,
     indexed_count = ?, skipped_count = ?, failed_count = ?, deleted_count = ?,
     discovery_complete = ?, error_code = ?, error_summary = ? WHERE id = ?`,
    )
      .bind(
        status,
        now,
        selected.length + discovery.failures.length,
        counts.indexed,
        counts.skipped,
        counts.failed,
        counts.deleted,
        discoveryComplete ? 1 : 0,
        partial ? "partial_sync" : null,
        summary,
        params.runId,
      )
      .run(),
  );
  if (!partial) {
    await assertRunWrite(
      env.DB.prepare(
        "UPDATE knowledge_spaces SET last_successful_sync_at = ?, updated_at = ? WHERE id = ?",
      )
        .bind(now, now, params.knowledgeSpaceId)
        .run(),
    );
  }
  console.log(
    JSON.stringify({
      event: "sync.completed",
      status,
      discoveredCount: selected.length + discovery.failures.length,
      ...counts,
    }),
  );
  return { status, ...counts };
}

async function recordOutcome(
  database: D1Database,
  runId: string,
  documentId: string | null,
  source: { sourcePageId: string; title: string; sourceUrl: string | null },
  outcome: "indexed" | "skipped" | "failed" | "deleted",
  now: string,
  errorCode: string | null = null,
  errorMessage: string | null = null,
) {
  const id = await stableUuid(`sync-result:${runId}:${source.sourcePageId}`);
  await assertRunWrite(
    database
      .prepare(
        `INSERT INTO sync_run_documents (
      id, sync_run_id, document_id, source_page_id, title, source_url,
      outcome, error_code, error_message, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sync_run_id, source_page_id) DO UPDATE SET
      document_id = excluded.document_id, title = excluded.title,
      source_url = excluded.source_url, outcome = excluded.outcome,
      error_code = excluded.error_code, error_message = excluded.error_message`,
      )
      .bind(
        id,
        runId,
        documentId,
        source.sourcePageId,
        source.title,
        source.sourceUrl,
        outcome,
        errorCode,
        errorMessage,
        now,
      )
      .run(),
  );
}

async function recordDeletedOutcome(
  database: D1Database,
  runId: string,
  document: {
    id: string;
    source_page_id: string;
    title: string;
    source_url: string | null;
  },
  now: string,
) {
  await recordOutcome(
    database,
    runId,
    document.id,
    {
      sourcePageId: document.source_page_id,
      title: document.title,
      sourceUrl: document.source_url,
    },
    "deleted",
    now,
  );
}

async function assertRunWrite(resultPromise: Promise<D1Result>) {
  const result = await resultPromise;
  if (!result.success) throw new Error("D1 write failed.");
}

function safeErrorMessage(error: unknown): string {
  if (
    error instanceof NonRetryableError &&
    error.message.includes("configured")
  ) {
    return "The live Notion source is not configured.";
  }
  if (
    error instanceof SourceAdapterError &&
    (error.code === "access_denied" || error.code === "not_found")
  ) {
    return "The configured Notion root was not found or is not shared with the connection.";
  }
  if (error instanceof SourceAdapterError && error.code === "rate_limited") {
    return "Notion rate limiting prevented synchronization. Try again later.";
  }
  return "Notion synchronization failed. Verify that the configured root is shared with the connection.";
}

function safeErrorCode(error: unknown): string {
  if (
    error instanceof NonRetryableError &&
    error.message.includes("configured")
  ) {
    return "source_configuration_error";
  }
  if (error instanceof SourceAdapterError) {
    if (error.code === "access_denied" || error.code === "not_found") {
      return "notion_access_denied";
    }
    if (error.code === "rate_limited") return "notion_rate_limited";
  }
  return "notion_unavailable";
}

export { normalizeNotionId };
