import {
  draftSchema,
  type Draft,
  type DraftSource,
} from "@knowledge-gardener/domain";
import type { RetrievedChunk } from "./chat-repository";

interface DraftRow {
  id: string;
  knowledge_space_id: string;
  owner_session_id: string | null;
  source_message_id: string | null;
  generation_instruction: string | null;
  title: string;
  content_markdown: string;
  source_json: string;
  assumptions_json: string;
  target_parent_id: string | null;
  status: string;
  version: number;
  was_edited: number;
  publish_state: string;
  publish_attempt_count: number;
  publish_started_at: string | null;
  publish_lease_expires_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  idempotency_key: string | null;
  notion_page_id: string | null;
  notion_url: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
}

export interface DraftOrigin {
  question: string;
  answer: string;
  citations: { chunkId: string; quote: string }[];
}

export class DraftRepository {
  constructor(private readonly database: D1Database) {}

  async findOrigin(
    ownerSessionId: string,
    knowledgeSpaceId: string,
    messageId: string,
  ): Promise<DraftOrigin | null> {
    const assistant = await this.database
      .prepare(
        `SELECT m.content, m.citation_json, m.conversation_id FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id = ? AND m.role = 'assistant' AND c.owner_session_id = ? AND c.knowledge_space_id = ?`,
      )
      .bind(messageId, ownerSessionId, knowledgeSpaceId)
      .first<{
        content: string;
        citation_json: string;
        conversation_id: string;
      }>();
    if (assistant === null) return null;
    const question = await this.database
      .prepare(
        `SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' AND rowid <
       (SELECT rowid FROM messages WHERE id = ?) ORDER BY rowid DESC LIMIT 1`,
      )
      .bind(assistant.conversation_id, messageId)
      .first<{ content: string }>();
    let citations: { chunkId: string; quote: string }[];
    try {
      citations = JSON.parse(assistant.citation_json) as {
        chunkId: string;
        quote: string;
      }[];
    } catch {
      return null;
    }
    if (question === null || citations.length === 0) return null;
    return { question: question.content, answer: assistant.content, citations };
  }

  async hydrateSources(
    knowledgeSpaceId: string,
    citations: readonly { chunkId: string; quote: string }[],
  ): Promise<{ sources: RetrievedChunk[]; snapshots: DraftSource[] }> {
    if (citations.length === 0) return { sources: [], snapshots: [] };
    const ids = citations.map((item) => item.chunkId);
    const rows = await this.database
      .prepare(
        `SELECT c.id chunk_id, c.content, c.checksum, d.id document_id, d.source_page_id, d.title,
              d.breadcrumb_json, d.source_url, d.last_edited_at, d.last_synced_at, d.index_status
       FROM document_chunks c JOIN documents d ON d.id = c.document_id
       WHERE d.knowledge_space_id = ? AND c.id IN (${ids.map(() => "?").join(",")})`,
      )
      .bind(knowledgeSpaceId, ...ids)
      .all<{
        chunk_id: string;
        content: string;
        checksum: string;
        document_id: string;
        source_page_id: string;
        title: string;
        breadcrumb_json: string;
        source_url: string | null;
        last_edited_at: string;
        last_synced_at: string | null;
        index_status: string;
      }>();
    const byId = new Map(rows.results.map((row) => [row.chunk_id, row]));
    const sources: RetrievedChunk[] = [];
    const snapshots: DraftSource[] = [];
    for (const citation of citations) {
      const row = byId.get(citation.chunkId);
      if (
        !row ||
        row.index_status === "failed" ||
        row.index_status === "pending" ||
        row.source_url === null ||
        !row.content.includes(citation.quote)
      )
        continue;
      const breadcrumb = JSON.parse(row.breadcrumb_json) as string[];
      const sourceState = row.index_status === "stale" ? "stale" : "current";
      sources.push({
        chunkId: row.chunk_id,
        content: row.content,
        source: {
          documentId: row.document_id,
          sourcePageId: row.source_page_id,
          title: row.title,
          breadcrumb,
          sourceUrl: row.source_url,
          lastEditedAt: row.last_edited_at,
          lastSyncedAt: row.last_synced_at,
          sourceState,
        },
      });
      snapshots.push({
        chunkId: row.chunk_id,
        documentId: row.document_id,
        sourcePageId: row.source_page_id,
        title: row.title,
        breadcrumb,
        sourceUrl: row.source_url,
        quote: citation.quote,
        sourceState,
        lastSyncedAt: row.last_synced_at,
        checksum: row.checksum,
      });
    }
    return { sources, snapshots };
  }

  async create(input: {
    id: string;
    knowledgeSpaceId: string;
    ownerSessionId: string;
    sourceMessageId: string;
    instruction: string | null;
    title: string;
    contentMarkdown: string;
    assumptions: string[];
    sources: DraftSource[];
    targetParentId: string;
    now: string;
  }): Promise<Draft> {
    const idempotencyKey = `draft:${input.id}`;
    const result = await this.database
      .prepare(
        `INSERT INTO drafts (id, knowledge_space_id, owner_session_id, source_message_id, generation_instruction, title, content_markdown, source_json, assumptions_json, target_parent_id, status, idempotency_key, version, was_edited, publish_state, publish_attempt_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 1, 0, 'idle', 0, ?, ?)`,
      )
      .bind(
        input.id,
        input.knowledgeSpaceId,
        input.ownerSessionId,
        input.sourceMessageId,
        input.instruction,
        input.title,
        input.contentMarkdown,
        JSON.stringify(input.sources),
        JSON.stringify(input.assumptions),
        input.targetParentId,
        idempotencyKey,
        input.now,
        input.now,
      )
      .run();
    if (!result.success) throw new Error("D1 draft write failed.");
    await this.audit(
      input.knowledgeSpaceId,
      input.id,
      "draft.generated",
      "success",
      { sourceCount: input.sources.length },
      input.now,
    );
    const draft = await this.find(
      input.id,
      input.ownerSessionId,
      input.knowledgeSpaceId,
    );
    if (!draft) throw new Error("Draft could not be reloaded.");
    return draft;
  }

  async find(
    id: string,
    ownerSessionId: string,
    knowledgeSpaceId: string,
  ): Promise<Draft | null> {
    const row = await this.database
      .prepare(
        "SELECT * FROM drafts WHERE id = ? AND owner_session_id = ? AND knowledge_space_id = ?",
      )
      .bind(id, ownerSessionId, knowledgeSpaceId)
      .first<DraftRow>();
    return row ? mapDraft(row) : null;
  }

  async list(
    ownerSessionId: string,
    knowledgeSpaceId: string,
    offset: number,
    limit: number,
    status?: string,
  ): Promise<{ items: Draft[]; nextCursor: string | null }> {
    const condition = status ? " AND status = ?" : "";
    const statement = this.database.prepare(
      `SELECT * FROM drafts WHERE owner_session_id = ? AND knowledge_space_id = ?${condition} ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    );
    const result = status
      ? await statement
          .bind(ownerSessionId, knowledgeSpaceId, status, limit + 1, offset)
          .all<DraftRow>()
      : await statement
          .bind(ownerSessionId, knowledgeSpaceId, limit + 1, offset)
          .all<DraftRow>();
    return {
      items: result.results.slice(0, limit).map(mapDraft),
      nextCursor: result.results.length > limit ? String(offset + limit) : null,
    };
  }

  async edit(
    id: string,
    owner: string,
    space: string,
    input: {
      title: string;
      contentMarkdown: string;
      assumptions: string[];
      version: number;
      now: string;
    },
  ): Promise<"ok" | "missing" | "conflict"> {
    const result = await this.database
      .prepare(
        `UPDATE drafts SET title = ?, content_markdown = ?, assumptions_json = ?, version = version + 1, was_edited = 1, updated_at = ?
       WHERE id = ? AND owner_session_id = ? AND knowledge_space_id = ? AND status = 'pending' AND version = ? AND publish_state != 'publishing'`,
      )
      .bind(
        input.title,
        input.contentMarkdown,
        JSON.stringify(input.assumptions),
        input.now,
        id,
        owner,
        space,
        input.version,
      )
      .run();
    if (result.meta.changes === 1) {
      await this.audit(space, id, "draft.edited", "success", {}, input.now);
      return "ok";
    }
    return (await this.find(id, owner, space)) === null
      ? "missing"
      : "conflict";
  }

  async discard(
    id: string,
    owner: string,
    space: string,
    version: number,
    now: string,
  ): Promise<"ok" | "missing" | "conflict"> {
    const result = await this.database
      .prepare(
        "UPDATE drafts SET status = 'discarded', updated_at = ? WHERE id = ? AND owner_session_id = ? AND knowledge_space_id = ? AND status = 'pending' AND version = ? AND publish_state != 'publishing'",
      )
      .bind(now, id, owner, space, version)
      .run();
    if (result.meta.changes === 1) {
      await this.audit(space, id, "draft.discarded", "success", {}, now);
      return "ok";
    }
    return (await this.find(id, owner, space)) === null
      ? "missing"
      : "conflict";
  }

  async claim(
    id: string,
    owner: string,
    space: string,
    version: number,
    now: string,
    lease: string,
  ): Promise<"claimed" | "published" | "missing" | "conflict" | "in_progress"> {
    const draft = await this.find(id, owner, space);
    if (!draft) return "missing";
    if (draft.status === "published") return "published";
    if (draft.status !== "pending" || draft.version !== version)
      return "conflict";
    if (
      draft.publishState === "publishing" &&
      draft.publishLeaseExpiresAt !== null &&
      draft.publishLeaseExpiresAt > now
    )
      return "in_progress";
    const result = await this.database
      .prepare(
        "UPDATE drafts SET publish_state = 'publishing', publish_attempt_count = publish_attempt_count + 1, publish_started_at = ?, publish_lease_expires_at = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE id = ? AND owner_session_id = ? AND knowledge_space_id = ? AND status = 'pending' AND version = ? AND (publish_state != 'publishing' OR publish_lease_expires_at <= ?)",
      )
      .bind(now, lease, now, id, owner, space, version, now)
      .run();
    if (result.meta.changes === 1) {
      await this.audit(space, id, "draft.publish_started", "success", {}, now);
      return "claimed";
    }
    return "conflict";
  }

  async publishResult(
    id: string,
    owner: string,
    space: string,
    pageId: string,
    url: string,
    now: string,
    recovered: boolean,
  ): Promise<void> {
    await this.database
      .prepare(
        "UPDATE drafts SET status = 'published', publish_state = 'published', notion_page_id = ?, notion_url = ?, published_at = ?, publish_lease_expires_at = NULL, updated_at = ? WHERE id = ? AND owner_session_id = ? AND knowledge_space_id = ?",
      )
      .bind(pageId, url, now, now, id, owner, space)
      .run();
    await this.audit(
      space,
      id,
      "draft.published",
      "success",
      { recovered },
      now,
    );
  }

  async publishFailure(
    id: string,
    owner: string,
    space: string,
    state: "failed" | "uncertain",
    code: string,
    message: string,
    now: string,
  ): Promise<void> {
    await this.database
      .prepare(
        "UPDATE drafts SET publish_state = ?, publish_lease_expires_at = NULL, last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = ? AND owner_session_id = ? AND knowledge_space_id = ?",
      )
      .bind(state, code, message.slice(0, 500), now, id, owner, space)
      .run();
    await this.audit(
      space,
      id,
      state === "uncertain"
        ? "draft.publish_uncertain"
        : "draft.publish_failed",
      state,
      { code },
      now,
    );
  }

  private async audit(
    space: string,
    draftId: string,
    action: string,
    outcome: string,
    metadata: Record<string, unknown>,
    now: string,
  ): Promise<void> {
    await this.database
      .prepare(
        "INSERT INTO audit_events (id, knowledge_space_id, action, resource_type, resource_id, outcome, metadata_json, created_at) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        space,
        action,
        draftId,
        outcome,
        JSON.stringify(metadata),
        now,
      )
      .run();
  }
}

function mapDraft(row: DraftRow): Draft {
  return draftSchema.parse({
    id: row.id,
    knowledgeSpaceId: row.knowledge_space_id,
    ownerSessionId: row.owner_session_id,
    sourceMessageId: row.source_message_id,
    generationInstruction: row.generation_instruction,
    title: row.title,
    contentMarkdown: row.content_markdown,
    sources: JSON.parse(row.source_json),
    assumptions: JSON.parse(row.assumptions_json),
    targetParentId: row.target_parent_id,
    status: row.status,
    version: row.version,
    wasEdited: row.was_edited === 1,
    publishState: row.publish_state,
    publishAttemptCount: row.publish_attempt_count,
    publishStartedAt: row.publish_started_at,
    publishLeaseExpiresAt: row.publish_lease_expires_at,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    idempotencyKey: row.idempotency_key,
    notionPageId: row.notion_page_id,
    notionUrl: row.notion_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  });
}
