import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { Draft } from "@knowledge-gardener/domain";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import {
  cleanupDemoData,
  MaintenanceService,
  toPublicDraft,
} from "../src/feedback-maintenance";

const directory = path.dirname(fileURLToPath(import.meta.url));
const now = "2026-09-06T00:00:00.000Z";
const spaceId = "73000000-0000-4000-8000-000000000001";
const documentId = "73000000-0000-4000-8000-000000000002";
const chunkId = "73000000-0000-4000-8000-000000000003";
const rootId = "73000000-0000-4000-8000-000000000004";

let miniflare: Miniflare;
let database: D1Database;

beforeAll(async () => {
  miniflare = new Miniflare({
    compatibilityDate: "2026-05-21",
    d1Databases: ["DB"],
    modules: true,
    script: "export default { fetch: () => new Response('ok') }",
  });
  database = await miniflare.getD1Database("DB");
  for (const filename of [
    "0001_initial.sql",
    "0002_chat_answer_metadata.sql",
    "0003_live_notion_sync.sql",
    "0004_hybrid_retrieval.sql",
    "0005_safe_draft_publishing.sql",
    "0006_garden_feedback_hardening.sql",
  ]) {
    const sql = await readFile(
      path.join(directory, "../migrations", filename),
      "utf8",
    );
    await database.batch(
      sql
        .split(";")
        .map((value) => value.trim())
        .filter((value) => value && !value.startsWith("PRAGMA foreign_keys"))
        .map((value) => database.prepare(value)),
    );
  }
  await database
    .prepare(
      `INSERT INTO knowledge_spaces
       (id, name, source_type, source_root_id, mode, last_successful_sync_at, created_at, updated_at)
       VALUES (?, 'Live test', 'notion', ?, 'live', ?, ?, ?)`,
    )
    .bind(spaceId, rootId, now, now, now)
    .run();
});

afterAll(async () => {
  await miniflare.dispose();
});

describe("index maintenance", () => {
  it("clears source/index state while preserving product records and audits the reset", async () => {
    await database
      .prepare(
        `INSERT INTO documents
         (id, knowledge_space_id, source_page_id, source_url, title, breadcrumb_json,
          last_edited_at, checksum, index_status, last_synced_at, created_at, updated_at, metadata_json)
         VALUES (?, ?, 'source', 'https://www.notion.so/source', 'Source', '[]',
          ?, 'document-checksum', 'indexed', ?, ?, ?, '{}')`,
      )
      .bind(documentId, spaceId, now, now, now, now)
      .run();
    const inserted = await database
      .prepare(
        `INSERT INTO document_chunks
         (id, document_id, ordinal, content, token_count, checksum, created_at,
          embedding_model, embedding_version, vector_upserted_at)
         VALUES (?, ?, 0, 'Indexed source body', 3, 'chunk-checksum', ?,
          'test-model', 'v1', ?)`,
      )
      .bind(chunkId, documentId, now, now)
      .run();
    await database
      .prepare("INSERT INTO document_chunks_fts(rowid, content) VALUES (?, ?)")
      .bind(inserted.meta.last_row_id, "Indexed source body")
      .run();
    await database
      .prepare(
        `INSERT INTO conversations
         (id, knowledge_space_id, owner_session_id, created_at, updated_at)
         VALUES ('73000000-0000-4000-8000-000000000005', ?, 'owner', ?, ?)`,
      )
      .bind(spaceId, now, now)
      .run();
    await database
      .prepare(
        `INSERT INTO drafts
         (id, knowledge_space_id, title, content_markdown, source_json, assumptions_json,
          status, idempotency_key, owner_session_id, version, publish_state,
          publish_attempt_count, created_at, updated_at)
         VALUES ('73000000-0000-4000-8000-000000000006', ?, 'Draft', 'Body', '[]',
          '[]', 'pending', 'private-key', 'owner', 1, 'idle', 0, ?, ?)`,
      )
      .bind(spaceId, now, now)
      .run();

    const deletedIds: string[][] = [];
    const result = await new MaintenanceService(
      {
        ...environment("live"),
        KNOWLEDGE_INDEX: {
          deleteByIds: async (ids: string[]) => {
            deletedIds.push(ids);
            return { count: ids.length };
          },
        } as unknown as VectorizeIndex,
      },
      () => now,
    ).resetIndex();

    expect(result).toEqual({
      deletedDocuments: 1,
      queuedVectors: 1,
      pendingVectorCleanup: false,
    });
    expect(deletedIds).toEqual([[chunkId]]);
    await expect(count("documents")).resolves.toBe(0);
    await expect(count("document_chunks_fts")).resolves.toBe(0);
    await expect(count("vector_deletion_queue")).resolves.toBe(0);
    await expect(count("conversations")).resolves.toBe(1);
    await expect(count("drafts")).resolves.toBe(1);
    await expect(count("audit_events", "action = 'index.reset'")).resolves.toBe(
      1,
    );
  });

  it("retains queued vector cleanup when the remote delete fails", async () => {
    const nextDocument = "73000000-0000-4000-8000-000000000007";
    const nextChunk = "73000000-0000-4000-8000-000000000008";
    await database
      .prepare(
        `INSERT INTO documents
         (id, knowledge_space_id, source_page_id, source_url, title, breadcrumb_json,
          last_edited_at, checksum, index_status, created_at, updated_at, metadata_json)
         VALUES (?, ?, 'next-source', 'https://www.notion.so/next', 'Next', '[]',
          ?, 'next-document', 'indexed', ?, ?, '{}')`,
      )
      .bind(nextDocument, spaceId, now, now, now)
      .run();
    await database
      .prepare(
        `INSERT INTO document_chunks
         (id, document_id, ordinal, content, token_count, checksum, created_at)
         VALUES (?, ?, 0, 'Next body', 2, 'next-chunk', ?)`,
      )
      .bind(nextChunk, nextDocument, now)
      .run();
    const result = await new MaintenanceService({
      ...environment("live"),
      KNOWLEDGE_INDEX: {
        deleteByIds: async () =>
          Promise.reject(new Error("remote unavailable")),
      } as unknown as VectorizeIndex,
    }).resetIndex();
    expect(result.pendingVectorCleanup).toBe(true);
    await expect(count("vector_deletion_queue")).resolves.toBe(1);

    const retriedIds: string[][] = [];
    const retried = await new MaintenanceService({
      ...environment("live"),
      KNOWLEDGE_INDEX: {
        deleteByIds: async (ids: string[]) => {
          retriedIds.push(ids);
          return { count: ids.length };
        },
      } as unknown as VectorizeIndex,
    }).resetIndex();
    expect(retried).toEqual({
      deletedDocuments: 0,
      queuedVectors: 0,
      pendingVectorCleanup: false,
    });
    expect(retriedIds).toEqual([[nextChunk]]);
    await expect(count("vector_deletion_queue")).resolves.toBe(0);
  });

  it("blocks an index reset while a synchronization is active", async () => {
    await database
      .prepare(
        `INSERT INTO sync_runs
         (id, knowledge_space_id, status, created_at)
         VALUES ('73000000-0000-4000-8000-000000000009', ?, 'queued', ?)`,
      )
      .bind(spaceId, now)
      .run();
    await expect(
      new MaintenanceService(environment("live")).resetIndex(),
    ).rejects.toMatchObject({ code: "maintenance_conflict" });
    await database
      .prepare("DELETE FROM sync_runs WHERE knowledge_space_id = ?")
      .bind(spaceId)
      .run();
  });
});

describe("retention and public boundaries", () => {
  it("deletes only expired demo conversations", async () => {
    await database
      .prepare(
        "UPDATE knowledge_spaces SET mode = 'demo', source_type = 'fixture'",
      )
      .run();
    await database
      .prepare(
        `INSERT INTO conversations
         (id, knowledge_space_id, owner_session_id, created_at, updated_at)
         VALUES ('73000000-0000-4000-8000-000000000010', ?, 'old', ?, ?),
                ('73000000-0000-4000-8000-000000000011', ?, 'current', ?, ?)`,
      )
      .bind(
        spaceId,
        "2026-08-20T00:00:00.000Z",
        "2026-08-20T00:00:00.000Z",
        spaceId,
        now,
        now,
      )
      .run();
    await cleanupDemoData(
      { ...environment("demo"), DEMO_RETENTION_DAYS: "7" },
      new Date(now),
    );
    expect(
      await database
        .prepare(
          "SELECT owner_session_id FROM conversations ORDER BY owner_session_id",
        )
        .all<{ owner_session_id: string }>(),
    ).toMatchObject({
      results: expect.arrayContaining([
        { owner_session_id: "current" },
        { owner_session_id: "owner" },
      ]),
    });
    await expect(
      database
        .prepare("SELECT id FROM conversations WHERE owner_session_id = 'old'")
        .first(),
    ).resolves.toBeNull();
  });

  it("removes internal publication controls from public drafts", () => {
    const draft: Draft = {
      id: "73000000-0000-4000-8000-000000000012",
      knowledgeSpaceId: spaceId,
      ownerSessionId: "owner",
      sourceMessageId: "73000000-0000-4000-8000-000000000013",
      generationInstruction: null,
      title: "Safe draft",
      contentMarkdown: "Body",
      sources: [
        {
          chunkId,
          documentId,
          sourcePageId: "source",
          title: "Source",
          breadcrumb: ["Source"],
          sourceUrl: "https://www.notion.so/source",
          quote: "Source quote",
          sourceState: "current",
          lastSyncedAt: now,
          checksum: "checksum",
        },
      ],
      assumptions: [],
      targetParentId: "73000000000040008000000000000014",
      status: "pending",
      version: 1,
      wasEdited: false,
      publishState: "idle",
      publishAttemptCount: 0,
      publishStartedAt: null,
      publishLeaseExpiresAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      idempotencyKey: "private-idempotency-key",
      notionPageId: null,
      notionUrl: null,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    };
    const result = toPublicDraft(draft);
    expect(result).not.toHaveProperty("idempotencyKey");
    expect(result).not.toHaveProperty("publishLeaseExpiresAt");
    expect(result).not.toHaveProperty("lastErrorMessage");
  });
});

function environment(mode: "demo" | "live"): Env {
  return {
    DB: database,
    AI: {} as Ai,
    CHAT_RATE_LIMITER: {} as RateLimit,
    APP_MODE: mode,
    NOTION_TOKEN: "test-token",
    NOTION_ROOT_PAGE_ID: rootId,
  };
}

async function count(table: string, where = "1 = 1"): Promise<number> {
  return (
    (await database
      .prepare(`SELECT COUNT(*) count FROM ${table} WHERE ${where}`)
      .first<number>("count")) ?? 0
  );
}
