import {
  documentSearchResponseSchema,
  syncDetailResponseSchema,
  syncOverviewResponseSchema,
  syncRunSchema,
  syncRunDocumentSchema,
  type DocumentSearchResponse,
  type KnowledgeFreshness,
  type SyncDetailResponse,
  type SyncOverviewResponse,
  type SyncRun,
} from "@knowledge-gardener/domain";

interface SyncRunRow {
  id: string;
  knowledge_space_id: string;
  workflow_instance_id: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  discovered_count: number;
  indexed_count: number;
  skipped_count: number;
  failed_count: number;
  deleted_count: number;
  error_summary: string | null;
  error_code: string | null;
  discovery_complete: number;
  created_at: string;
}

interface SyncDocumentRow {
  id: string;
  sync_run_id: string;
  document_id: string | null;
  source_page_id: string;
  title: string;
  source_url: string | null;
  outcome: string;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
}

export class SyncRepository {
  constructor(private readonly database: D1Database) {}

  async ensureKnowledgeSpace(input: {
    id: string;
    rootId: string;
    now: string;
    name?: string;
  }): Promise<string> {
    const result = await this.database
      .prepare(
        `INSERT INTO knowledge_spaces (
        id, name, source_type, source_root_id, mode,
        last_successful_sync_at, created_at, updated_at
      ) VALUES (?, ?, 'notion', ?, 'live', NULL, ?, ?)
      ON CONFLICT(source_type, source_root_id) DO UPDATE SET
        name = excluded.name, mode = 'live', updated_at = excluded.updated_at`,
      )
      .bind(
        input.id,
        input.name ?? "Notion Engineering Knowledge",
        input.rootId,
        input.now,
        input.now,
      )
      .run();
    assertWrite(result);
    const row = await this.database
      .prepare(
        "SELECT id FROM knowledge_spaces WHERE source_type = 'notion' AND source_root_id = ?",
      )
      .bind(input.rootId)
      .first<{ id: string }>();
    if (row === null) throw new Error("Knowledge space was not created.");
    return row.id;
  }

  async findActive(spaceId: string): Promise<SyncRun | null> {
    const row = await this.database
      .prepare(
        "SELECT * FROM sync_runs WHERE knowledge_space_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1",
      )
      .bind(spaceId)
      .first<SyncRunRow>();
    return row === null ? null : mapRun(row);
  }

  async createRun(input: {
    id: string;
    spaceId: string;
    now: string;
  }): Promise<SyncRun> {
    const result = await this.database
      .prepare(
        `INSERT INTO sync_runs (
        id, knowledge_space_id, workflow_instance_id, status, created_at
      ) VALUES (?, ?, ?, 'queued', ?)`,
      )
      .bind(input.id, input.spaceId, input.id, input.now)
      .run();
    assertWrite(result);
    const run = await this.findRun(input.id, input.spaceId);
    if (run === null) throw new Error("Sync run was not created.");
    return run;
  }

  async markWorkflowStartFailed(runId: string, now: string): Promise<void> {
    assertWrite(
      await this.database
        .prepare(
          `UPDATE sync_runs SET status = 'failed', completed_at = ?,
       error_code = 'workflow_unavailable', error_summary = 'Synchronization could not be started.'
       WHERE id = ? AND status = 'queued'`,
        )
        .bind(now, runId)
        .run(),
    );
  }

  async markOrphanedRunFailed(runId: string, now: string): Promise<void> {
    assertWrite(
      await this.database
        .prepare(
          `UPDATE sync_runs SET status = 'failed', completed_at = ?,
           error_code = 'workflow_unavailable',
           error_summary = 'The synchronization Workflow ended before finalizing its run.'
           WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .bind(now, runId)
        .run(),
    );
  }

  async findRun(runId: string, spaceId?: string): Promise<SyncRun | null> {
    const sql =
      spaceId === undefined
        ? "SELECT * FROM sync_runs WHERE id = ?"
        : "SELECT * FROM sync_runs WHERE id = ? AND knowledge_space_id = ?";
    const row = await this.database
      .prepare(sql)
      .bind(runId, ...(spaceId === undefined ? [] : [spaceId]))
      .first<SyncRunRow>();
    return row === null ? null : mapRun(row);
  }

  async overview(
    spaceId: string | null,
    limit = 10,
  ): Promise<SyncOverviewResponse> {
    if (spaceId === null)
      return syncOverviewResponseSchema.parse({
        knowledgeSpace: null,
        runs: [],
      });
    const space = await this.database
      .prepare(
        "SELECT id, name, last_successful_sync_at FROM knowledge_spaces WHERE id = ?",
      )
      .bind(spaceId)
      .first<{
        id: string;
        name: string;
        last_successful_sync_at: string | null;
      }>();
    if (space === null)
      return syncOverviewResponseSchema.parse({
        knowledgeSpace: null,
        runs: [],
      });
    const result = await this.database
      .prepare(
        "SELECT * FROM sync_runs WHERE knowledge_space_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .bind(spaceId, limit)
      .all<SyncRunRow>();
    const runs = result.results.map(mapRun);
    return syncOverviewResponseSchema.parse({
      knowledgeSpace: {
        id: space.id,
        name: space.name,
        freshness: freshness(runs[0], space.last_successful_sync_at),
        lastSuccessfulSyncAt: space.last_successful_sync_at,
      },
      runs,
    });
  }

  async detail(
    runId: string,
    spaceId: string,
  ): Promise<SyncDetailResponse | null> {
    const run = await this.findRun(runId, spaceId);
    if (run === null) return null;
    const result = await this.database
      .prepare(
        "SELECT * FROM sync_run_documents WHERE sync_run_id = ? ORDER BY created_at, source_page_id",
      )
      .bind(runId)
      .all<SyncDocumentRow>();
    return syncDetailResponseSchema.parse({
      run,
      documents: result.results.map(mapSyncDocument),
    });
  }

  async findSpaceId(
    mode: "demo" | "live",
    rootId?: string,
  ): Promise<string | null> {
    const row =
      mode === "live" && rootId !== undefined
        ? await this.database
            .prepare(
              "SELECT id FROM knowledge_spaces WHERE mode = 'live' AND source_root_id = ?",
            )
            .bind(rootId)
            .first<{ id: string }>()
        : await this.database
            .prepare(
              "SELECT id FROM knowledge_spaces WHERE mode = ? ORDER BY created_at LIMIT 1",
            )
            .bind(mode)
            .first<{ id: string }>();
    return row?.id ?? null;
  }

  async searchDocuments(input: {
    spaceId: string;
    query: string;
    status?: string;
    offset: number;
    limit: number;
  }): Promise<DocumentSearchResponse> {
    const clauses = ["d.knowledge_space_id = ?"];
    const bindings: unknown[] = [input.spaceId];
    if (input.status !== undefined) {
      clauses.push("d.index_status = ?");
      bindings.push(input.status);
    }
    if (input.query !== "") {
      clauses.push(
        "(d.title LIKE ? ESCAPE '\\' OR d.breadcrumb_json LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM document_chunks sc WHERE sc.document_id = d.id AND sc.content LIKE ? ESCAPE '\\'))",
      );
      const pattern = `%${escapeLike(input.query)}%`;
      bindings.push(pattern, pattern, pattern);
    }
    bindings.push(input.limit + 1, input.offset);
    const result = await this.database
      .prepare(
        `SELECT d.id, d.source_page_id, d.title, d.breadcrumb_json, d.source_url,
              d.last_edited_at, d.last_synced_at, d.index_status,
              d.last_sync_error_message,
              (SELECT substr(c.content, 1, 500) FROM document_chunks c
               WHERE c.document_id = d.id ORDER BY c.ordinal LIMIT 1) AS excerpt
       FROM documents d WHERE ${clauses.join(" AND ")}
       ORDER BY d.updated_at DESC, d.id LIMIT ? OFFSET ?`,
      )
      .bind(...bindings)
      .all<Record<string, unknown>>();
    const hasMore = result.results.length > input.limit;
    const items = result.results.slice(0, input.limit).map((row) => ({
      id: row.id,
      sourcePageId: row.source_page_id,
      title: row.title,
      breadcrumb: JSON.parse(String(row.breadcrumb_json)) as unknown,
      sourceUrl: row.source_url,
      excerpt: row.excerpt,
      lastEditedAt: row.last_edited_at,
      lastSyncedAt: row.last_synced_at,
      indexStatus: row.index_status,
      errorMessage: row.last_sync_error_message,
    }));
    return documentSearchResponseSchema.parse({
      items,
      nextCursor: hasMore ? String(input.offset + input.limit) : null,
    });
  }
}

function mapRun(row: SyncRunRow): SyncRun {
  return syncRunSchema.parse({
    id: row.id,
    knowledgeSpaceId: row.knowledge_space_id,
    workflowInstanceId: row.workflow_instance_id,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    discoveredCount: row.discovered_count,
    indexedCount: row.indexed_count,
    skippedCount: row.skipped_count,
    failedCount: row.failed_count,
    deletedCount: row.deleted_count,
    errorSummary: row.error_summary,
    errorCode: row.error_code,
    discoveryComplete: row.discovery_complete === 1,
    createdAt: row.created_at,
  });
}

function mapSyncDocument(row: SyncDocumentRow) {
  return syncRunDocumentSchema.parse({
    id: row.id,
    syncRunId: row.sync_run_id,
    documentId: row.document_id,
    sourcePageId: row.source_page_id,
    title: row.title,
    sourceUrl: row.source_url,
    outcome: row.outcome,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
  });
}

function freshness(
  run: SyncRun | undefined,
  lastSuccessful: string | null,
): KnowledgeFreshness {
  if (run?.status === "queued" || run?.status === "running") return "syncing";
  if (run?.status === "partial") return "partially_stale";
  if (run?.status === "failed") return "failed";
  return lastSuccessful === null ? "never_synced" : "fresh";
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function assertWrite(result: D1Result): void {
  if (!result.success) throw new Error("D1 write failed.");
}
