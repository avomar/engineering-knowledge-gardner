import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { SourceAdapterError } from "@knowledge-gardener/source";

import {
  checksum,
  CHUNKING_VERSION,
  chunkDocument,
  stableUuid,
} from "./chunking";
import { EMBEDDING_MODEL, EMBEDDING_VERSION, embedTexts } from "./embedding";
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
  const counts = {
    indexed: 0,
    skipped: 0,
    failed: 0,
    deleted: 0,
    chunks: 0,
    embeddedChunks: 0,
  };
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
      const existingChunks = await env.DB.prepare(
        `SELECT id, content FROM document_chunks
         WHERE document_id = ? AND (embedding_version IS NULL OR embedding_version != ?)`,
      )
        .bind(documentId, EMBEDDING_VERSION)
        .all<{ id: string; content: string }>();
      if (existingChunks.results.length > 0) {
        try {
          await upsertChunkVectors(
            env,
            params.knowledgeSpaceId,
            existingChunks.results,
          );
          await assertRunWrite(
            env.DB.prepare(
              `UPDATE document_chunks SET embedding_model = ?, embedding_version = ?,
               vector_upserted_at = ? WHERE document_id = ?`,
            )
              .bind(EMBEDDING_MODEL, EMBEDDING_VERSION, now, documentId)
              .run(),
          );
          counts.embeddedChunks += existingChunks.results.length;
        } catch {
          await markStale(env.DB, documentId, now, "embedding_unavailable");
          await recordOutcome(
            env.DB,
            params.runId,
            documentId,
            source,
            "failed",
            now,
            "embedding_unavailable",
            "Embeddings could not be created for this source.",
          );
          counts.failed += 1;
          continue;
        }
      }
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
    let oldVectorIds: string[] = [];
    try {
      oldVectorIds = (
        await env.DB.prepare(
          "SELECT id FROM document_chunks WHERE document_id = ?",
        )
          .bind(documentId)
          .all<{ id: string }>()
      ).results.map((row) => row.id);
      await upsertChunkVectors(env, params.knowledgeSpaceId, chunks);
    } catch {
      if (existing !== null)
        await markStale(env.DB, documentId, now, "embedding_unavailable");
      await recordOutcome(
        env.DB,
        params.runId,
        existing?.id ?? null,
        source,
        "failed",
        now,
        "embedding_unavailable",
        "Embeddings could not be created for this source.",
      );
      counts.failed += 1;
      continue;
    }
    const statements = [
      env.DB.prepare(
        `INSERT INTO documents (
          id, knowledge_space_id, source_page_id, source_url, parent_source_page_id,
          title, breadcrumb_json, last_edited_at, checksum, index_status,
          last_synced_at, created_at, updated_at, metadata_json, chunking_version,
          last_sync_error_code, last_sync_error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'indexed', ?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(knowledge_space_id, source_page_id) DO UPDATE SET
          source_url = excluded.source_url, parent_source_page_id = excluded.parent_source_page_id,
          title = excluded.title, breadcrumb_json = excluded.breadcrumb_json,
          last_edited_at = excluded.last_edited_at, checksum = excluded.checksum,
          index_status = 'indexed', last_synced_at = excluded.last_synced_at,
          updated_at = excluded.updated_at, metadata_json = excluded.metadata_json,
          chunking_version = excluded.chunking_version,
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
        CHUNKING_VERSION,
      ),
      env.DB.prepare(
        "DELETE FROM document_chunks_fts WHERE rowid IN (SELECT rowid FROM document_chunks WHERE document_id = ?)",
      ).bind(documentId),
      env.DB.prepare("DELETE FROM document_chunks WHERE document_id = ?").bind(
        documentId,
      ),
      ...chunks.map((chunk) =>
        env.DB.prepare(
          `INSERT INTO document_chunks (
            id, document_id, ordinal, content, token_count, checksum, created_at,
            embedding_model, embedding_version, vector_upserted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          chunk.id,
          chunk.documentId,
          chunk.ordinal,
          chunk.content,
          chunk.tokenCount,
          chunk.checksum,
          chunk.createdAt,
          EMBEDDING_MODEL,
          EMBEDDING_VERSION,
          now,
        ),
      ),
      env.DB.prepare(
        `INSERT INTO document_chunks_fts(rowid, content)
         SELECT rowid, content FROM document_chunks WHERE document_id = ?`,
      ).bind(documentId),
      ...oldVectorIds
        .filter((id) => !chunks.some((chunk) => chunk.id === id))
        .map((id) =>
          env.DB.prepare(
            `INSERT INTO vector_deletion_queue (knowledge_space_id, vector_id, enqueued_at)
             VALUES (?, ?, ?) ON CONFLICT(knowledge_space_id, vector_id) DO NOTHING`,
          ).bind(params.knowledgeSpaceId, id, now),
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
    counts.embeddedChunks += chunks.length;
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
      const vectors = await env.DB.prepare(
        "SELECT id FROM document_chunks WHERE document_id = ?",
      )
        .bind(document.id)
        .all<{ id: string }>();
      const deletes = vectors.results.map((row) =>
        env.DB.prepare(
          `INSERT INTO vector_deletion_queue (knowledge_space_id, vector_id, enqueued_at)
           VALUES (?, ?, ?) ON CONFLICT(knowledge_space_id, vector_id) DO NOTHING`,
        ).bind(params.knowledgeSpaceId, row.id, now),
      );
      await recordDeletedOutcome(env.DB, params.runId, document, now);
      await env.DB.batch([
        ...deletes,
        env.DB.prepare(
          "DELETE FROM document_chunks_fts WHERE rowid IN (SELECT rowid FROM document_chunks WHERE document_id = ?)",
        ).bind(document.id),
        env.DB.prepare("DELETE FROM documents WHERE id = ?").bind(document.id),
      ]);
      counts.deleted += 1;
    }
  }

  if (env.KNOWLEDGE_INDEX !== undefined) {
    await drainVectorDeletionQueue(env, params.knowledgeSpaceId, now);
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
     indexed_count = ?, skipped_count = ?, failed_count = ?, deleted_count = ?, embedded_chunk_count = ?,
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
        counts.embeddedChunks,
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

async function upsertChunkVectors(
  env: Env,
  knowledgeSpaceId: string,
  chunks: readonly { id: string; content: string }[],
): Promise<void> {
  if (env.KNOWLEDGE_INDEX === undefined) {
    throw new Error("The live semantic index is not configured.");
  }
  const vectors = await embedTexts(
    env.AI,
    chunks.map((chunk) => chunk.content),
  );
  await env.KNOWLEDGE_INDEX.upsert(
    chunks.map((chunk, index) => ({
      id: chunk.id,
      values: vectors[index]!,
      namespace: knowledgeSpaceId,
      metadata: { knowledgeSpaceId, chunkId: chunk.id },
    })),
  );
}

async function markStale(
  database: D1Database,
  documentId: string,
  now: string,
  code: string,
): Promise<void> {
  await assertRunWrite(
    database
      .prepare(
        `UPDATE documents SET index_status = 'stale', last_sync_error_code = ?,
       last_sync_error_message = 'Embeddings could not be created for this source.', updated_at = ?
       WHERE id = ?`,
      )
      .bind(code, now, documentId)
      .run(),
  );
}

async function drainVectorDeletionQueue(
  env: Env,
  knowledgeSpaceId: string,
  now: string,
): Promise<void> {
  const pending = await env.DB.prepare(
    `SELECT vector_id FROM vector_deletion_queue
     WHERE knowledge_space_id = ? ORDER BY enqueued_at LIMIT 100`,
  )
    .bind(knowledgeSpaceId)
    .all<{ vector_id: string }>();
  if (pending.results.length === 0 || env.KNOWLEDGE_INDEX === undefined) return;
  const ids = pending.results.map((row) => row.vector_id);
  try {
    await env.KNOWLEDGE_INDEX.deleteByIds(ids);
    await assertRunWrite(
      env.DB.prepare(
        `DELETE FROM vector_deletion_queue WHERE knowledge_space_id = ?
         AND vector_id IN (${ids.map(() => "?").join(", ")})`,
      )
        .bind(knowledgeSpaceId, ...ids)
        .run(),
    );
  } catch {
    await assertRunWrite(
      env.DB.prepare(
        `UPDATE vector_deletion_queue SET attempt_count = attempt_count + 1,
         last_attempt_at = ?, last_error_code = 'vector_delete_unavailable'
         WHERE knowledge_space_id = ?`,
      )
        .bind(now, knowledgeSpaceId)
        .run(),
    );
  }
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
