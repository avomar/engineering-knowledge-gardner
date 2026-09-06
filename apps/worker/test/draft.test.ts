import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { publicDraftSchema } from "@knowledge-gardener/domain";
import { Miniflare } from "miniflare";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { DraftGenerator } from "../src/draft-generator";
import { DraftService } from "../src/draft-service";
import type { Env } from "../src/env";
import { createApp } from "../src/index";

const directory = path.dirname(fileURLToPath(import.meta.url));
const now = "2026-09-06T00:00:00.000Z";
const rootId = "74000000-0000-4000-8000-000000000001";
const parentId = "74000000-0000-4000-8000-000000000002";
const spaceId = "74000000-0000-4000-8000-000000000003";
const documentId = "74000000-0000-4000-8000-000000000004";
const chunkId = "74000000-0000-4000-8000-000000000005";
const conversationId = "74000000-0000-4000-8000-000000000006";
const userMessageId = "74000000-0000-4000-8000-000000000007";
const assistantMessageId = "74000000-0000-4000-8000-000000000008";
const owner = "74000000-0000-4000-8000-000000000009";
const firstDraftId = "74000000-0000-4000-8000-000000000010";
const secondDraftId = "74000000-0000-4000-8000-000000000011";

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
  await seedOrigin();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await miniflare.dispose();
});

describe("safe draft lifecycle", () => {
  it("generates, edits, publishes once, reuses the result, and redacts internal controls", async () => {
    const service = draftService(firstDraftId);
    const generated = await service.generate(owner, {
      sourceMessageId: assistantMessageId,
      instruction: "Turn this into an operational note.",
    });
    expect(generated.sources).toHaveLength(1);
    expect(generated.status).toBe("pending");
    expect(generated.generationInstruction).toContain("operational note");

    const edited = await service.edit(owner, generated.id, {
      title: "Reviewed incident note",
      contentMarkdown: "## Mitigation\n\nDisable the fictional export path.",
      assumptions: ["Confirm the owner before adoption."],
      version: generated.version,
    });
    expect(edited.version).toBe(2);
    expect(edited.wasEdited).toBe(true);
    await expect(
      service.edit(owner, generated.id, {
        title: "Stale edit",
        contentMarkdown: "Stale",
        assumptions: [],
        version: 1,
      }),
    ).rejects.toMatchObject({ code: "draft_conflict" });

    const notionCalls: string[] = [];
    vi.stubGlobal("scheduler", { wait: async () => undefined });
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input);
      notionCalls.push(url);
      if (url.includes(`/pages/${parentId}`)) {
        return notionResponse(page(parentId, { page_id: rootId }));
      }
      if (url.includes(`/blocks/${parentId}/children`)) {
        return notionResponse({
          results: [],
          has_more: false,
          next_cursor: null,
        });
      }
      if (url.endsWith("/pages")) {
        return notionResponse(
          page("74000000-0000-4000-8000-000000000012", {
            page_id: parentId,
          }),
        );
      }
      throw new Error(`Unexpected Notion request: ${url}`);
    });

    const published = await service.publish(owner, edited.id, edited.version);
    expect(published.reused).toBe(false);
    expect(published.draft.status).toBe("published");
    const callCount = notionCalls.length;
    const repeated = await service.publish(owner, edited.id, edited.version);
    expect(repeated.reused).toBe(true);
    expect(notionCalls).toHaveLength(callCount);

    const api = createApp({
      accessVerifier: { verify: async () => "access-owner" },
    });
    const response = await api.request(
      `https://api.invalid/api/drafts/${edited.id}`,
      {
        headers: {
          "X-Client-Session-Id": owner,
          "Cf-Access-Jwt-Assertion": "test-token",
        },
      },
      environment(),
    );
    expect(response.status).toBe(200);
    const raw = (await response.json()) as Record<string, unknown>;
    expect(publicDraftSchema.parse(raw).status).toBe("published");
    expect(raw).not.toHaveProperty("idempotencyKey");
    expect(raw).not.toHaveProperty("publishLeaseExpiresAt");
    expect(raw).not.toHaveProperty("lastErrorMessage");
    expect(
      await database
        .prepare("SELECT action FROM audit_events WHERE resource_id = ?")
        .bind(firstDraftId)
        .all<{ action: string }>(),
    ).toMatchObject({
      results: expect.arrayContaining([
        { action: "draft.generated" },
        { action: "draft.edited" },
        { action: "draft.publish_started" },
        { action: "draft.published" },
      ]),
    });
  });

  it("discards an owned pending draft and rejects cross-session access", async () => {
    const service = draftService(secondDraftId);
    const generated = await service.generate(owner, {
      sourceMessageId: assistantMessageId,
    });
    await expect(
      service.get("74000000-0000-4000-8000-000000000099", generated.id),
    ).rejects.toMatchObject({ code: "draft_not_found" });
    const discarded = await service.discard(
      owner,
      generated.id,
      generated.version,
    );
    expect(discarded.status).toBe("discarded");
  });
});

function draftService(id: string) {
  const generator: DraftGenerator = {
    generate: async () => ({
      title: "Incident follow-up",
      contentMarkdown: "## Mitigation\n\nDisable the fictional export path.",
      assumptions: ["The source describes a fictional system."],
      sourceChunkIds: [chunkId],
    }),
  };
  return new DraftService(environment(), {
    generator,
    createId: () => id,
    now: () => now,
  });
}

function environment(): Env {
  return {
    DB: database,
    AI: {} as Ai,
    CHAT_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    } as RateLimit,
    APP_MODE: "live",
    NOTION_TOKEN: "test-token",
    NOTION_ROOT_PAGE_ID: rootId,
    NOTION_DRAFTS_PARENT_ID: parentId,
    ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
    ACCESS_AUD: "test-audience",
  };
}

function page(id: string, parent: Record<string, unknown>) {
  return {
    object: "page",
    id,
    url: `https://www.notion.so/${id.replaceAll("-", "")}`,
    created_time: now,
    last_edited_time: now,
    in_trash: false,
    parent,
    properties: {},
  };
}

function notionResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function seedOrigin() {
  await database.batch([
    database
      .prepare(
        `INSERT INTO knowledge_spaces
         (id, name, source_type, source_root_id, mode, last_successful_sync_at, created_at, updated_at)
         VALUES (?, 'Live test', 'notion', ?, 'live', ?, ?, ?)`,
      )
      .bind(spaceId, rootId, now, now, now),
    database
      .prepare(
        `INSERT INTO documents
         (id, knowledge_space_id, source_page_id, source_url, title, breadcrumb_json,
          last_edited_at, checksum, index_status, last_synced_at, created_at, updated_at, metadata_json)
         VALUES (?, ?, 'incident', 'https://www.notion.so/incident', 'Incident', '["Incident"]',
          ?, 'document-checksum', 'indexed', ?, ?, ?, '{}')`,
      )
      .bind(documentId, spaceId, now, now, now, now),
    database
      .prepare(
        `INSERT INTO document_chunks
         (id, document_id, ordinal, content, token_count, checksum, created_at)
         VALUES (?, ?, 0, 'The on-call engineer disabled the fictional export path.', 8,
          'chunk-checksum', ?)`,
      )
      .bind(chunkId, documentId, now),
    database
      .prepare(
        `INSERT INTO conversations
         (id, knowledge_space_id, owner_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(conversationId, spaceId, owner, now, now),
    database
      .prepare(
        `INSERT INTO messages
         (id, conversation_id, role, content, citation_json, created_at)
         VALUES (?, ?, 'user', 'How was the incident mitigated?', '[]', ?),
                (?, ?, 'assistant', 'The export path was disabled.', ?, ?)`,
      )
      .bind(
        userMessageId,
        conversationId,
        now,
        assistantMessageId,
        conversationId,
        JSON.stringify([
          {
            chunkId,
            quote: "disabled the fictional export path",
          },
        ]),
        now,
      ),
  ]);
}
