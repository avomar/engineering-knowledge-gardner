import { describe, expect, it } from "vitest";

import { chunkDocument, stableUuid } from "../src/chunking";
import {
  discoverNotionDocuments,
  normalizeNotionId,
  normalizePageMarkdown,
  NotionClient,
  type BlockTree,
} from "../src/notion";

const ids = {
  root: "11111111-1111-4111-8111-111111111111",
  child: "22222222-2222-4222-8222-222222222222",
  database: "33333333-3333-4333-8333-333333333333",
  row: "44444444-4444-4444-8444-444444444444",
  dataSource: "55555555-5555-4555-8555-555555555555",
};

describe("Notion source", () => {
  it("normalizes compact page IDs", () => {
    expect(normalizeNotionId(ids.root.replaceAll("-", ""))).toBe(ids.root);
    expect(() => normalizeNotionId("not-a-page")).toThrow("invalid");
  });

  it("honors Retry-After and sends the current API headers", async () => {
    const waits: number[] = [];
    const requests: Request[] = [];
    let attempt = 0;
    const client = new NotionClient("private-token", {
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      random: () => 0,
      fetcher: async (input, init) => {
        requests.push(new Request(input, init));
        attempt += 1;
        if (attempt === 1)
          return Response.json(
            {},
            { status: 429, headers: { "Retry-After": "2" } },
          );
        return Response.json(page(ids.root, "Engineering"));
      },
    });
    await expect(client.retrievePage(ids.root)).resolves.toMatchObject({
      id: ids.root,
    });
    expect(waits).toContain(2_000);
    expect(requests[0]?.headers.get("Notion-Version")).toBe("2026-03-11");
    expect(requests[0]?.headers.get("Authorization")).toBe(
      "Bearer private-token",
    );
  });

  it("bounds and safely logs failed outbound requests", async () => {
    const logs: Record<string, unknown>[] = [];
    const client = new NotionClient("private-token", {
      wait: async () => undefined,
      fetcher: async (_input, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        throw new TypeError("network unavailable");
      },
      log: (record) => logs.push(record),
    });

    await expect(client.retrievePage(ids.root)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(logs).toContainEqual({
      event: "notion.request_failed",
      attempt: 1,
      errorName: "TypeError",
      errorMessage: "network unavailable",
    });
  });

  it("retains the Worker fetch receiver when using the default fetcher", async () => {
    const originalFetch = globalThis.fetch;
    let calledWithGlobalReceiver = false;
    globalThis.fetch = function (this: typeof globalThis) {
      calledWithGlobalReceiver = this === globalThis;
      return Promise.resolve(Response.json(page(ids.root, "Engineering")));
    } as typeof fetch;
    try {
      const client = new NotionClient("private-token");
      await expect(client.retrievePage(ids.root)).resolves.toMatchObject({
        id: ids.root,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calledWithGlobalReceiver).toBe(true);
  });

  it("discovers the root, child pages, and descendant database rows", async () => {
    const calls: string[] = [];
    const client = new NotionClient("token", {
      wait: async () => undefined,
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        calls.push(`${request.method} ${url.pathname}`);
        if (url.pathname.endsWith(`/pages/${ids.root}`))
          return Response.json(page(ids.root, "Engineering"));
        if (url.pathname.endsWith(`/pages/${ids.child}`))
          return Response.json(page(ids.child, "Runbook"));
        if (url.pathname.endsWith(`/pages/${ids.row}`))
          return Response.json(page(ids.row, "ADR 1", true));
        if (url.pathname.endsWith(`/blocks/${ids.root}/children`)) {
          return Response.json(
            list([
              block(ids.child, "child_page", { title: "Runbook" }),
              block(ids.database, "child_database", { title: "Decisions" }),
            ]),
          );
        }
        if (url.pathname.endsWith(`/blocks/${ids.child}/children`)) {
          return Response.json(
            list([
              block("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "paragraph", {
                rich_text: rich("Deploy with Wrangler"),
              }),
            ]),
          );
        }
        if (url.pathname.endsWith(`/blocks/${ids.row}/children`))
          return Response.json(list([]));
        if (url.pathname.endsWith(`/databases/${ids.database}`)) {
          return Response.json({
            object: "database",
            id: ids.database,
            title: rich("Decisions"),
            data_sources: [{ id: ids.dataSource, name: "ADRs" }],
          });
        }
        if (url.pathname.endsWith(`/data_sources/${ids.dataSource}/query`)) {
          return Response.json({
            ...list([page(ids.row, "ADR 1", true)]),
            type: "page_or_data_source",
          });
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const result = await discoverNotionDocuments(client, ids.root);
    expect(result.complete).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.documents.map((document) => document.title)).toEqual([
      "Engineering",
      "Runbook",
      "ADR 1",
    ]);
    expect(result.documents[2]?.breadcrumb).toEqual([
      "Engineering",
      "Decisions",
      "ADR 1",
    ]);
    expect(result.documents[2]?.metadata).toMatchObject({ Status: "Accepted" });
    expect(calls).toContain(`POST /v1/data_sources/${ids.dataSource}/query`);
  });

  it("accepts Notion's current notion.com page URLs", async () => {
    const currentUrl = `https://www.notion.com/Engineering-${ids.root.replaceAll("-", "")}`;
    const client = new NotionClient("token", {
      wait: async () => undefined,
      fetcher: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith(`/pages/${ids.root}`))
          return Response.json(
            page(ids.root, "Engineering", false, currentUrl),
          );
        if (path.endsWith(`/blocks/${ids.root}/children`))
          return Response.json(list([]));
        throw new Error(`Unexpected request: ${String(input)}`);
      },
    });

    const result = await discoverNotionDocuments(client, ids.root);
    expect(result.documents[0]?.sourceUrl).toBe(`${currentUrl}`);
  });

  it("retains a safe partial result when a descendant becomes inaccessible", async () => {
    const client = new NotionClient("token", {
      wait: async () => undefined,
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path.endsWith(`/pages/${ids.root}`)) {
          return Response.json(page(ids.root, "Engineering"));
        }
        if (path.endsWith(`/pages/${ids.child}`)) {
          return Response.json({}, { status: 403 });
        }
        if (path.endsWith(`/blocks/${ids.root}/children`)) {
          return Response.json(
            list([
              block(ids.child, "child_page", { title: "Private runbook" }),
            ]),
          );
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    const result = await discoverNotionDocuments(client, ids.root);
    expect(result.complete).toBe(false);
    expect(result.documents.map(({ title }) => title)).toEqual(["Engineering"]);
    expect(result.failures).toEqual([
      expect.objectContaining({
        sourcePageId: ids.child,
        title: "Private runbook",
        errorCode: "access_denied",
      }),
    ]);
    expect(result.failures[0]?.errorMessage).not.toContain(ids.child);
  });

  it("normalizes supported blocks and creates stable overlapping chunks", async () => {
    const trees: BlockTree[] = [
      {
        ...block(ids.child, "heading_2", { rich_text: rich("Deploy") }),
        children: [],
      },
      {
        ...block(ids.row, "to_do", {
          rich_text: rich("Validate staging"),
          checked: true,
        }),
        children: [],
      },
    ];
    const markdown = normalizePageMarkdown(
      "Runbook",
      { Status: "Current" },
      trees,
    );
    expect(markdown).toContain("## Properties");
    expect(markdown).toContain("## Deploy");
    expect(markdown).toContain("- [x] Validate staging");

    const source = Array.from(
      { length: 1_200 },
      (_, index) => `word${index}`,
    ).join(" ");
    const chunks = await chunkDocument({
      documentId: ids.root,
      sourcePageId: ids.child,
      title: "Long guide",
      breadcrumb: ["Engineering", "Long guide"],
      markdown: source,
      createdAt: "2026-09-05T00:00:00.000Z",
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      Math.max(...chunks.map((chunk) => chunk.tokenCount)),
    ).toBeLessThanOrEqual(700);
    await expect(stableUuid("same")).resolves.toBe(await stableUuid("same"));
  });
});

function page(
  id: string,
  title: string,
  databaseRow = false,
  url = `https://www.notion.so/${id.replaceAll("-", "")}`,
) {
  return {
    object: "page",
    id,
    url,
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-09-01T00:00:00.000Z",
    in_trash: false,
    parent: databaseRow
      ? { type: "data_source_id", data_source_id: ids.dataSource }
      : { type: "page_id", page_id: ids.root },
    properties: {
      Name: { id: "title", type: "title", title: rich(title) },
      ...(databaseRow
        ? {
            Status: {
              id: "status",
              type: "status",
              status: { name: "Accepted" },
            },
          }
        : {}),
    },
  };
}

function block(id: string, type: string, value: Record<string, unknown>) {
  return {
    object: "block" as const,
    id,
    type,
    has_children: false,
    in_trash: false,
    [type]: value,
  };
}

function list(results: unknown[]) {
  return { object: "list", results, has_more: false, next_cursor: null };
}

function rich(text: string) {
  return [{ plain_text: text, href: null, annotations: {} }];
}
