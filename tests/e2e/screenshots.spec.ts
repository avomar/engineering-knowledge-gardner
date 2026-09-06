import { expect, test } from "@playwright/test";

const enabled = process.env.UPDATE_SCREENSHOTS === "1";
const now = "2026-09-05T08:00:00.000Z";
const conversationId = "75000000-0000-4000-8000-000000000001";
const userMessageId = "75000000-0000-4000-8000-000000000002";
const assistantMessageId = "75000000-0000-4000-8000-000000000003";
const chunkId = "75000000-0000-4000-8000-000000000004";
const documentId = "75000000-0000-4000-8000-000000000005";

test.skip(!enabled, "Run with UPDATE_SCREENSHOTS=1 via yarn screenshots.");

test("captures public-safe demo chat and garden screenshots", async ({
  page,
}) => {
  await page.route("http://127.0.0.1:5173/api/health", async (route) => {
    await route.fulfill({
      json: { status: "ok", mode: "demo", checks: { database: "ok" } },
    });
  });
  await page.route("http://127.0.0.1:5173/api/chat", async (route) => {
    await route.fulfill({ json: chatResponse() });
  });
  await page.route(
    /http:\/\/127\.0\.0\.1:5173\/api\/garden(?:\?.*)?$/u,
    async (route) => {
      await route.fulfill({ json: gardenOverview() });
    },
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Why did we choose D1?" }).click();
  await expect(
    page.getByText("D1 owns structured, relational, persistent data."),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/images/demo-grounded-chat.png",
    fullPage: true,
  });

  await page.getByRole("button", { name: "Garden" }).click();
  await expect(
    page.getByRole("heading", { name: "Document may need a freshness review" }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/images/demo-garden.png",
    fullPage: true,
  });
});

function chatResponse() {
  return {
    conversationId,
    userMessage: {
      id: userMessageId,
      conversationId,
      role: "user",
      content: "Why did we choose D1?",
      citations: [],
      confidence: null,
      unansweredQuestions: [],
      createdAt: now,
    },
    assistantMessage: {
      id: assistantMessageId,
      conversationId,
      role: "assistant",
      content: "D1 owns structured, relational, persistent data.",
      citations: [
        {
          chunkId,
          quote: "D1 is the primary store for structured data.",
          source: {
            documentId,
            sourcePageId: "storage-adr",
            title: "ADR: Storage Responsibilities",
            breadcrumb: [
              "Engineering Knowledge",
              "ADR: Storage Responsibilities",
            ],
            sourceUrl: "demo://documents/storage-adr",
            lastEditedAt: now,
          },
        },
      ],
      confidence: "high",
      unansweredQuestions: [],
      feedback: null,
      createdAt: now,
    },
  };
}

function gardenOverview() {
  return {
    policy: {
      staleAfterDays: 90,
      requiredMetadataKeys: ["status", "tags"],
      obsoleteTerms: [
        { term: "Node.js 24", replacement: "the supported runtime" },
      ],
    },
    latestScan: {
      id: chunkId,
      status: "completed",
      aiStatus: "degraded",
      findingCount: 1,
      aiEnrichedCount: 0,
      errorCode: null,
      startedAt: now,
      completedAt: "2026-09-05T08:00:01.000Z",
    },
    counts: { open: 1, dismissed: 0, resolved: 0 },
    items: [
      {
        id: documentId,
        fingerprint: "a".repeat(64),
        signalType: "stale_document",
        severity: "medium",
        status: "open",
        version: 1,
        title: "Document may need a freshness review",
        reason: "Last edited more than 90 days ago.",
        recommendation: "Review whether this guidance is still current.",
        evidence: [
          {
            documentId,
            sourcePageId: "storage-adr",
            title: "ADR: Storage Responsibilities",
            sourceUrl: "demo://documents/storage-adr",
            lastEditedAt: "2026-01-01T00:00:00.000Z",
            detail: "Last edited more than 90 days ago.",
          },
        ],
        aiEnriched: false,
        firstDetectedAt: now,
        lastDetectedAt: now,
        dismissedAt: null,
        resolvedAt: null,
        updatedAt: now,
      },
    ],
    nextCursor: null,
  };
}
