import {
  feedbackRequestSchema,
  feedbackResponseSchema,
  indexResetResponseSchema,
  publicDraftSchema,
  type Draft,
  type FeedbackSummary,
  type PublicDraft,
} from "@knowledge-gardener/domain";

import { ChatRepository } from "./chat-repository";
import { DemoCorpusService } from "./demo-corpus";
import type { Env } from "./env";
import { optionalRoot } from "./sync-service";

export type FeedbackMaintenanceErrorCode =
  | "feedback_target_not_found"
  | "knowledge_not_ready"
  | "maintenance_conflict"
  | "database_unavailable";

export class FeedbackMaintenanceError extends Error {
  constructor(
    readonly code: FeedbackMaintenanceErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class FeedbackService {
  constructor(
    private readonly env: Env,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async save(ownerSessionId: string, input: unknown) {
    const parsed = feedbackRequestSchema.parse(input);
    const spaceId = await resolveSpace(this.env);
    const target =
      parsed.messageId === undefined
        ? await this.ownedDraft(parsed.draftId!, ownerSessionId, spaceId)
        : await this.ownedAssistantMessage(
            parsed.messageId,
            ownerSessionId,
            spaceId,
          );
    if (!target) {
      throw new FeedbackMaintenanceError(
        "feedback_target_not_found",
        "Feedback target not found.",
        false,
      );
    }
    const correction = parsed.rating === 1 ? null : (parsed.correction ?? null);
    const now = this.now();
    const existing = await this.env.DB.prepare(
      parsed.messageId === undefined
        ? "SELECT id, created_at FROM feedback WHERE owner_session_id = ? AND draft_id = ?"
        : "SELECT id, created_at FROM feedback WHERE owner_session_id = ? AND message_id = ?",
    )
      .bind(ownerSessionId, parsed.messageId ?? parsed.draftId)
      .first<{ id: string; created_at: string }>();
    if (existing === null) {
      await this.env.DB.prepare(
        `INSERT INTO feedback
         (id, message_id, draft_id, rating, correction, owner_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          parsed.messageId ?? null,
          parsed.draftId ?? null,
          parsed.rating,
          correction,
          ownerSessionId,
          now,
          now,
        )
        .run();
    } else {
      await this.env.DB.prepare(
        "UPDATE feedback SET rating = ?, correction = ?, updated_at = ? WHERE id = ?",
      )
        .bind(parsed.rating, correction, now, existing.id)
        .run();
    }
    return feedbackResponseSchema.parse({
      feedback: { rating: parsed.rating, correction },
    });
  }

  async forDrafts(
    ownerSessionId: string,
    drafts: readonly Draft[],
  ): Promise<PublicDraft[]> {
    if (drafts.length === 0) return [];
    const ids = drafts.map((draft) => draft.id);
    const result = await this.env.DB.prepare(
      `SELECT draft_id, rating, correction FROM feedback
       WHERE owner_session_id = ? AND draft_id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(ownerSessionId, ...ids)
      .all<{ draft_id: string; rating: number; correction: string | null }>();
    const feedback = new Map(
      result.results.map((row) => [
        row.draft_id,
        { rating: row.rating, correction: row.correction } as FeedbackSummary,
      ]),
    );
    return drafts.map((draft) =>
      toPublicDraft(draft, feedback.get(draft.id) ?? null),
    );
  }

  async forDraft(ownerSessionId: string, draft: Draft): Promise<PublicDraft> {
    return (await this.forDrafts(ownerSessionId, [draft]))[0]!;
  }

  private async ownedAssistantMessage(
    id: string,
    owner: string,
    space: string,
  ): Promise<boolean> {
    const row = await this.env.DB.prepare(
      `SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = ? AND m.role = 'assistant' AND c.owner_session_id = ? AND c.knowledge_space_id = ?`,
    )
      .bind(id, owner, space)
      .first();
    return row !== null;
  }

  private async ownedDraft(
    id: string,
    owner: string,
    space: string,
  ): Promise<boolean> {
    const row = await this.env.DB.prepare(
      "SELECT id FROM drafts WHERE id = ? AND owner_session_id = ? AND knowledge_space_id = ?",
    )
      .bind(id, owner, space)
      .first();
    return row !== null;
  }
}

export function toPublicDraft(
  draft: Draft,
  feedback: FeedbackSummary | null = null,
): PublicDraft {
  return publicDraftSchema.parse({ ...draft, feedback });
}

export class MaintenanceService {
  constructor(
    private readonly env: Env,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async clearConversations(ownerSessionId: string) {
    const result = await this.env.DB.prepare(
      "DELETE FROM conversations WHERE owner_session_id = ?",
    )
      .bind(ownerSessionId)
      .run();
    return { deletedConversations: result.meta.changes ?? 0 };
  }

  async resetIndex() {
    const spaceId = await resolveSpace(this.env);
    const active = await this.env.DB.prepare(
      "SELECT id FROM sync_runs WHERE knowledge_space_id = ? AND status IN ('queued', 'running') LIMIT 1",
    )
      .bind(spaceId)
      .first();
    if (active !== null) {
      throw new FeedbackMaintenanceError(
        "maintenance_conflict",
        "Wait for synchronization to finish before resetting the index.",
        true,
      );
    }
    const rows = await this.env.DB.prepare(
      `SELECT c.id FROM document_chunks c JOIN documents d ON d.id = c.document_id
       WHERE d.knowledge_space_id = ?`,
    )
      .bind(spaceId)
      .all<{ id: string }>();
    const documentCount =
      (await this.env.DB.prepare(
        "SELECT COUNT(*) count FROM documents WHERE knowledge_space_id = ?",
      )
        .bind(spaceId)
        .first<number>("count")) ?? 0;
    const now = this.now();
    const queueStatements = rows.results.map((row) =>
      this.env.DB.prepare(
        `INSERT INTO vector_deletion_queue (knowledge_space_id, vector_id, enqueued_at)
         VALUES (?, ?, ?) ON CONFLICT(knowledge_space_id, vector_id) DO NOTHING`,
      ).bind(spaceId, row.id, now),
    );
    for (let index = 0; index < queueStatements.length; index += 100) {
      await this.env.DB.batch(queueStatements.slice(index, index + 100));
    }
    await this.env.DB.batch([
      this.env.DB.prepare(
        `DELETE FROM document_chunks_fts WHERE rowid IN
         (SELECT c.rowid FROM document_chunks c JOIN documents d ON d.id = c.document_id
          WHERE d.knowledge_space_id = ?)`,
      ).bind(spaceId),
      this.env.DB.prepare(
        "DELETE FROM garden_scans WHERE knowledge_space_id = ?",
      ).bind(spaceId),
      this.env.DB.prepare(
        "DELETE FROM sync_runs WHERE knowledge_space_id = ?",
      ).bind(spaceId),
      this.env.DB.prepare(
        "DELETE FROM documents WHERE knowledge_space_id = ?",
      ).bind(spaceId),
      this.env.DB.prepare(
        "UPDATE knowledge_spaces SET last_successful_sync_at = NULL, updated_at = ? WHERE id = ?",
      ).bind(now, spaceId),
      this.env.DB.prepare(
        `INSERT INTO audit_events
         (id, knowledge_space_id, action, resource_type, resource_id, outcome, metadata_json, created_at)
         VALUES (?, ?, 'index.reset', 'knowledge_space', ?, 'success', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        spaceId,
        spaceId,
        JSON.stringify({
          deletedDocuments: documentCount,
          queuedVectors: rows.results.length,
        }),
        now,
      ),
    ]);

    const queued = await this.env.DB.prepare(
      "SELECT vector_id FROM vector_deletion_queue WHERE knowledge_space_id = ? ORDER BY enqueued_at, vector_id",
    )
      .bind(spaceId)
      .all<{ vector_id: string }>();
    let pendingVectorCleanup = queued.results.length > 0;
    if (this.env.KNOWLEDGE_INDEX !== undefined) {
      try {
        for (let index = 0; index < queued.results.length; index += 1_000) {
          const ids = queued.results
            .slice(index, index + 1_000)
            .map((row) => row.vector_id);
          if (ids.length > 0) await this.env.KNOWLEDGE_INDEX.deleteByIds(ids);
        }
        await this.env.DB.prepare(
          "DELETE FROM vector_deletion_queue WHERE knowledge_space_id = ?",
        )
          .bind(spaceId)
          .run();
        pendingVectorCleanup = false;
      } catch {
        pendingVectorCleanup = true;
      }
    }
    return indexResetResponseSchema.parse({
      deletedDocuments: documentCount,
      queuedVectors: rows.results.length,
      pendingVectorCleanup,
    });
  }
}

export async function cleanupDemoData(
  env: Env,
  now = new Date(),
): Promise<void> {
  if (env.APP_MODE !== "demo") return;
  const configured = Number(env.DEMO_RETENTION_DAYS ?? "7");
  const days =
    Number.isInteger(configured) && configured >= 1 && configured <= 30
      ? configured
      : 7;
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM conversations WHERE updated_at < ?").bind(
      cutoff,
    ),
    env.DB.prepare("DELETE FROM garden_scans WHERE created_at < ?").bind(
      cutoff,
    ),
  ]);
}

async function resolveSpace(env: Env): Promise<string> {
  if (env.APP_MODE === "demo")
    return new DemoCorpusService(env.DB).ensureReady();
  const root = optionalRoot(env);
  const id =
    root === null
      ? null
      : await new ChatRepository(env.DB).findLiveKnowledgeSpace(root);
  if (id === null) {
    throw new FeedbackMaintenanceError(
      "knowledge_not_ready",
      "Complete a synchronization first.",
      false,
    );
  }
  return id;
}
