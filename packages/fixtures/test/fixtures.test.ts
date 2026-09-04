import { describe, expect, it } from "vitest";

import { SourceAdapterError } from "@knowledge-gardener/source";

import { fixtureManifest, FixtureSourceAdapter } from "../src/index";

const adapter = new FixtureSourceAdapter();

describe("fictional fixtures", () => {
  it("contains four stable, unique documents", () => {
    expect(
      fixtureManifest.documents.map(({ sourcePageId }) => sourcePageId),
    ).toEqual([
      "connection-incident",
      "local-setup",
      "storage-adr",
      "worker-deploy-runbook",
    ]);
    expect(
      new Set(fixtureManifest.documents.map(({ sourcePageId }) => sourcePageId))
        .size,
    ).toBe(4);
  });

  it("paginates deterministically", async () => {
    const first = await adapter.discoverPages({
      rootId: fixtureManifest.rootId,
      pageSize: 2,
    });
    if (first.nextCursor === null) {
      throw new Error("Expected another fixture page.");
    }
    const second = await adapter.discoverPages({
      rootId: fixtureManifest.rootId,
      pageSize: 2,
      cursor: first.nextCursor,
    });

    expect(first.pages).toHaveLength(2);
    expect(first.nextCursor).toBe("2");
    expect(second.pages).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });

  it.each([
    ["storage-adr", ["D1", "KV", "R2", "structured"]],
    ["worker-deploy-runbook", ["Wrangler", "staging", "rollback"]],
    [
      "connection-incident",
      ["connection pool", "feature flag", "bulk-export-v2"],
    ],
    ["local-setup", ["corepack enable", "yarn dev", "yarn test"]],
  ])("contains required facts in %s", async (pageId, facts) => {
    const document = await adapter.fetchPage({
      rootId: fixtureManifest.rootId,
      pageId,
    });

    for (const fact of facts) {
      expect(document.contentMarkdown).toContain(fact);
    }
  });

  it("contains no obvious credentials or personal identifiers", async () => {
    for (const { sourcePageId } of fixtureManifest.documents) {
      const document = await adapter.fetchPage({
        rootId: fixtureManifest.rootId,
        pageId: sourcePageId,
      });
      expect(document.contentMarkdown).not.toMatch(/secret_[a-z0-9]+/i);
      expect(document.contentMarkdown).not.toMatch(
        /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i,
      );
      expect(document.contentMarkdown).not.toContain("notion.so");
    }
  });

  it.each([
    [{ rootId: "another-root", pageSize: 1 }, "access_denied"],
    [
      { rootId: fixtureManifest.rootId, pageSize: 1, cursor: "bad" },
      "invalid_configuration",
    ],
  ])("rejects an invalid discovery request", async (input, code) => {
    await expect(adapter.discoverPages(input)).rejects.toMatchObject({
      code,
    });
  });

  it("returns a typed not-found error", async () => {
    await expect(
      adapter.fetchPage({
        rootId: fixtureManifest.rootId,
        pageId: "missing",
      }),
    ).rejects.toBeInstanceOf(SourceAdapterError);
  });
});
