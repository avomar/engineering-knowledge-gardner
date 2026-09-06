import { describe, expect, it } from "vitest";

import { PublicDemoSourceAdapter, publicDemoManifest } from "../src/index";

const adapter = new PublicDemoSourceAdapter();

describe("public demo corpus", () => {
  it("contains only the allowlisted README sources and project ADRs", () => {
    expect(
      publicDemoManifest.documents.map(({ sourcePageId }) => sourcePageId),
    ).toEqual([
      "readme-product-and-architecture",
      "readme-demo-and-api",
      "readme-deployment-and-operations",
      "adr-0001-foundation-architecture",
      "adr-0002-grounded-demo-chat",
      "adr-0003-live-notion-sync",
      "adr-0004-unified-worker-assets",
      "adr-0005-hybrid-retrieval",
      "adr-0006-safe-draft-publishing",
      "adr-0007-garden-findings",
      "adr-0008-demo-live-boundaries",
      "adr-0009-public-project-docs",
    ]);
    expect(
      publicDemoManifest.documents.every(({ sourceUrl }) =>
        sourceUrl.startsWith("demo://project/"),
      ),
    ).toBe(true);
  });

  it("includes project decisions while excluding non-public repository material", async () => {
    const access = await adapter.fetchPage({
      rootId: publicDemoManifest.rootId,
      pageId: "adr-0008-demo-live-boundaries",
    });
    expect(access.contentMarkdown).toContain("Cf-Access-Jwt-Assertion");

    for (const document of publicDemoManifest.documents) {
      expect(document.contentMarkdown).not.toContain("PROMPT_HISTORY.md");
      expect(document.contentMarkdown).not.toMatch(/secret_[a-z0-9]+/i);
      expect(document.contentMarkdown).not.toContain("notion.so");
    }
  });

  it("paginates and rejects roots outside the explicit public corpus", async () => {
    const first = await adapter.discoverPages({
      rootId: publicDemoManifest.rootId,
      pageSize: 10,
    });
    expect(first.pages).toHaveLength(10);
    expect(first.nextCursor).toBe("10");
    await expect(
      adapter.discoverPages({ rootId: "all-repository-files", pageSize: 1 }),
    ).rejects.toMatchObject({ code: "access_denied" });
  });
});
