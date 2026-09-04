import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DocumentChunkRepository,
  DocumentRepository,
  KnowledgeSpaceRepository,
} from "../src/repositories";

const now = "2026-09-05T00:00:00.000Z";
const spaceId = "11111111-1111-4111-8111-111111111111";
const documentId = "22222222-2222-4222-8222-222222222222";

let miniflare: Miniflare;
let database: D1Database;
const directory = path.dirname(fileURLToPath(import.meta.url));

beforeAll(async () => {
  miniflare = new Miniflare({
    compatibilityDate: "2026-05-21",
    d1Databases: ["DB"],
    modules: true,
    script: "export default { fetch: () => new Response('ok') }",
  });
  database = await miniflare.getD1Database("DB");
  const migration = await readFile(
    path.join(directory, "../migrations/0001_initial.sql"),
    "utf8",
  );
  const statements = migration
    .split(";")
    .map((statement) => statement.trim())
    .filter(
      (statement) =>
        statement !== "" && !statement.startsWith("PRAGMA foreign_keys"),
    )
    .map((statement) => database.prepare(statement));
  await database.batch(statements);
});

afterAll(async () => {
  await miniflare.dispose();
});

describe("D1 foundation", () => {
  it("creates the full initial table and index set", async () => {
    const tables = await database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all<{ name: string }>();
    const tableNames = tables.results.map(({ name }) => name);

    expect(tableNames).toEqual(
      expect.arrayContaining([
        "audit_events",
        "conversations",
        "document_chunks",
        "documents",
        "drafts",
        "feedback",
        "knowledge_spaces",
        "messages",
        "sync_runs",
      ]),
    );

    const indexes = await database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
      )
      .all<{ name: string }>();
    expect(indexes.results.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "documents_status_idx",
        "document_chunks_document_idx",
        "messages_conversation_created_idx",
        "sync_runs_knowledge_space_started_idx",
      ]),
    );
  });

  it("round-trips the Phase 0 repository aggregates", async () => {
    const spaces = new KnowledgeSpaceRepository(database);
    const documents = new DocumentRepository(database);
    const chunks = new DocumentChunkRepository(database);

    await spaces.create({
      id: spaceId,
      name: "Demo Engineering Knowledge",
      sourceType: "fixture",
      sourceRootId: "engineering-knowledge",
      mode: "demo",
      lastSuccessfulSyncAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await documents.create({
      id: documentId,
      knowledgeSpaceId: spaceId,
      sourcePageId: "storage-adr",
      sourceUrl: "demo://documents/storage-adr",
      parentSourcePageId: null,
      title: "ADR: Storage Responsibilities",
      breadcrumb: ["Engineering Knowledge", "ADR: Storage Responsibilities"],
      lastEditedAt: now,
      checksum: "document-checksum",
      indexStatus: "pending",
      lastSyncedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await chunks.replaceForDocument(documentId, [
      {
        id: "33333333-3333-4333-8333-333333333333",
        documentId,
        ordinal: 0,
        content: "D1 owns structured data.",
        tokenCount: 5,
        checksum: "chunk-checksum",
        createdAt: now,
      },
    ]);

    await expect(spaces.findById(spaceId)).resolves.toMatchObject({
      sourceRootId: "engineering-knowledge",
    });
    await expect(documents.findById(documentId)).resolves.toMatchObject({
      breadcrumb: ["Engineering Knowledge", "ADR: Storage Responsibilities"],
    });
    await expect(chunks.listByDocument(documentId)).resolves.toHaveLength(1);
  });

  it("enforces document and chunk uniqueness", async () => {
    await expect(
      database
        .prepare(
          `INSERT INTO documents (
            id, knowledge_space_id, source_page_id, title, last_edited_at,
            checksum, index_status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "44444444-4444-4444-8444-444444444444",
          spaceId,
          "storage-adr",
          "Duplicate",
          now,
          "duplicate",
          "pending",
          now,
          now,
        )
        .run(),
    ).rejects.toThrow();

    await expect(
      database
        .prepare(
          `INSERT INTO document_chunks (
            id, document_id, ordinal, content, token_count, checksum, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          "55555555-5555-4555-8555-555555555555",
          documentId,
          0,
          "Duplicate ordinal",
          2,
          "duplicate",
          now,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("enforces draft idempotency", async () => {
    const insert = database.prepare(
      `INSERT INTO drafts (
        id, knowledge_space_id, title, content_markdown, status,
        idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    await insert
      .bind(
        "66666666-6666-4666-8666-666666666666",
        spaceId,
        "First draft",
        "Draft body",
        "pending",
        "publish-once",
        now,
        now,
      )
      .run();
    await expect(
      insert
        .bind(
          "77777777-7777-4777-8777-777777777777",
          spaceId,
          "Second draft",
          "Draft body",
          "pending",
          "publish-once",
          now,
          now,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("enforces feedback target and rating constraints", async () => {
    await expect(
      database
        .prepare(
          "INSERT INTO feedback (id, rating, created_at) VALUES (?, ?, ?)",
        )
        .bind("88888888-8888-4888-8888-888888888888", 0, now)
        .run(),
    ).rejects.toThrow();
  });

  it("cascades owned documents and chunks", async () => {
    await database
      .prepare("DELETE FROM knowledge_spaces WHERE id = ?")
      .bind(spaceId)
      .run();
    const documents = await database
      .prepare(
        "SELECT COUNT(*) AS count FROM documents WHERE knowledge_space_id = ?",
      )
      .bind(spaceId)
      .first<number>("count");
    const chunks = await database
      .prepare(
        "SELECT COUNT(*) AS count FROM document_chunks WHERE document_id = ?",
      )
      .bind(documentId)
      .first<number>("count");
    expect(documents).toBe(0);
    expect(chunks).toBe(0);
  });
});
