import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  documentSearchResponseSchema,
  syncDetailResponseSchema,
  syncOverviewResponseSchema,
  syncStartResponseSchema,
} from "@knowledge-gardener/domain";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { createApp } from "../src/index";

const directory = path.dirname(fileURLToPath(import.meta.url));
const rootId = "99999999-9999-4999-8999-999999999999";
let miniflare: Miniflare;
let database: D1Database;
let workflowCreates = 0;

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
  ]) {
    const sql = await readFile(
      path.join(directory, "../migrations", filename),
      "utf8",
    );
    const statements = sql
      .split(";")
      .map((value) => value.trim())
      .filter((value) => value && !value.startsWith("PRAGMA foreign_keys"))
      .map((value) => database.prepare(value));
    await database.batch(statements);
  }
});

afterAll(async () => {
  await miniflare.dispose();
});

describe("live sync API", () => {
  it("starts one Workflow and reuses the active run", async () => {
    const first = await request("/api/sync", { method: "POST" });
    expect(first.status).toBe(202);
    const created = syncStartResponseSchema.parse(await first.json());
    expect(created.reused).toBe(false);
    expect(created.run.status).toBe("queued");

    const second = await request("/api/sync", { method: "POST" });
    const reused = syncStartResponseSchema.parse(await second.json());
    expect(reused.reused).toBe(true);
    expect(reused.run.id).toBe(created.run.id);
    expect(workflowCreates).toBe(1);

    const overview = syncOverviewResponseSchema.parse(
      await (await request("/api/sync")).json(),
    );
    expect(overview.knowledgeSpace?.freshness).toBe("syncing");
    expect(overview.runs).toHaveLength(1);

    const detail = syncDetailResponseSchema.parse(
      await (await request(`/api/sync/${created.run.id}`)).json(),
    );
    expect(detail.documents).toEqual([]);
  });

  it("returns safe configuration and lookup failures", async () => {
    const missing = await createApp().request(
      "https://api.invalid/api/sync",
      { method: "POST" },
      { ...environment(), NOTION_TOKEN: undefined },
    );
    expect(missing.status).toBe(503);
    expect(
      ((await missing.json()) as { error: { code: string } }).error.code,
    ).toBe("source_configuration_error");

    const unknown = await request(
      "/api/sync/88888888-8888-4888-8888-888888888888",
    );
    expect(unknown.status).toBe(404);
  });

  it("searches indexed documents and rejects invalid cursors", async () => {
    const space = await database
      .prepare("SELECT id FROM knowledge_spaces WHERE source_root_id = ?")
      .bind(rootId)
      .first<{ id: string }>();
    expect(space).not.toBeNull();
    await database
      .prepare(
        `INSERT INTO documents (
        id, knowledge_space_id, source_page_id, source_url, title,
        breadcrumb_json, last_edited_at, checksum, index_status,
        last_synced_at, created_at, updated_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'indexed', ?, ?, ?, '{}')`,
      )
      .bind(
        "77777777-7777-4777-8777-777777777777",
        space!.id,
        "66666666-6666-4666-8666-666666666666",
        "https://www.notion.so/66666666666646668666666666666666",
        "Deployment Runbook",
        JSON.stringify(["Engineering", "Deployment Runbook"]),
        "2026-09-01T00:00:00.000Z",
        "checksum",
        "2026-09-05T00:00:00.000Z",
        "2026-09-05T00:00:00.000Z",
        "2026-09-05T00:00:00.000Z",
      )
      .run();
    await database
      .prepare(
        "INSERT INTO document_chunks (id, document_id, ordinal, content, token_count, checksum, created_at) VALUES (?, ?, 0, ?, 3, ?, ?)",
      )
      .bind(
        "55555555-5555-4555-8555-555555555555",
        "77777777-7777-4777-8777-777777777777",
        "Deploy with Wrangler",
        "chunk",
        "2026-09-05T00:00:00.000Z",
      )
      .run();

    const response = await request("/api/documents/search?q=Wrangler");
    const body = documentSearchResponseSchema.parse(await response.json());
    expect(body.items[0]?.title).toBe("Deployment Runbook");
    expect(body.items[0]?.excerpt).toContain("Wrangler");
    expect((await request("/api/documents/search?cursor=invalid")).status).toBe(
      400,
    );
  });
});

function environment(): Env {
  return {
    DB: database,
    AI: {} as Ai,
    CHAT_RATE_LIMITER: {} as RateLimit,
    APP_MODE: "live",
    NOTION_TOKEN: "test-token",
    NOTION_ROOT_PAGE_ID: rootId,
    KNOWLEDGE_SYNC: {
      create: async () => {
        workflowCreates += 1;
        return { id: "workflow" };
      },
    } as unknown as Workflow,
  };
}

async function request(pathname: string, init: RequestInit = {}) {
  return await createApp().request(
    `https://api.invalid${pathname}`,
    init,
    environment(),
  );
}
