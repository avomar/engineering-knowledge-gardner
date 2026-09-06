import { expect, test } from "@playwright/test";

const conversationId = "50000000-0000-4000-8000-000000000001";
const userMessageId = "50000000-0000-4000-8000-000000000002";
const assistantMessageId = "50000000-0000-4000-8000-000000000003";
const chunkId = "50000000-0000-4000-8000-000000000004";
const documentId = "50000000-0000-4000-8000-000000000005";
const sessionId = "50000000-0000-4000-8000-000000000006";

test.beforeEach(async ({ page }) => {
  await page.route("http://127.0.0.1:5173/api/health", async (route) => {
    await route.fulfill({
      json: { status: "ok", mode: "demo", checks: { database: "ok" } },
    });
  });
});

test("asks a starter question and renders grounded evidence", async ({
  page,
}) => {
  await page.route("http://127.0.0.1:5173/api/chat", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({ json: chatResponse() });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Why did we choose D1?" }).click();
  await expect(page.getByText("Searching the demo sources…")).toBeVisible();
  await expect(
    page.getByText("D1 owns structured, relational, persistent data."),
  ).toBeVisible();
  await expect(page.getByText("high confidence")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "ADR: Storage Responsibilities" }),
  ).toBeVisible();
  await expect(page.getByText("Fictional", { exact: true })).toBeVisible();
});

test("restores one active conversation and starts a new chat", async ({
  page,
}) => {
  await page.addInitScript(
    ({ activeConversationId, browserSessionId }) => {
      localStorage.setItem(
        "knowledge-gardener.active-conversation-id",
        activeConversationId,
      );
      localStorage.setItem(
        "knowledge-gardener.demo-session-id",
        browserSessionId,
      );
    },
    { activeConversationId: conversationId, browserSessionId: sessionId },
  );
  await page.route(
    `http://127.0.0.1:5173/api/conversations/${conversationId}/messages`,
    async (route) => {
      const response = chatResponse();
      await route.fulfill({
        json: {
          conversationId,
          messages: [response.userMessage, response.assistantMessage],
        },
      });
    },
  );
  await page.goto("/");
  await expect(
    page.getByText("D1 owns structured, relational, persistent data."),
  ).toBeVisible();
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Ask what the engineering docs actually say.",
    }),
  ).toBeVisible();
  await expect(
    page.evaluate(() =>
      localStorage.getItem("knowledge-gardener.active-conversation-id"),
    ),
  ).resolves.toBeNull();
});

test("retains a failed question and retries it", async ({ page }) => {
  let attempts = 0;
  await page.route("http://127.0.0.1:5173/api/chat", async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        json: {
          error: {
            code: "ai_unavailable",
            message: "The answer service is temporarily unavailable.",
            retryable: true,
          },
        },
      });
      return;
    }
    await route.fulfill({ json: chatResponse() });
  });
  await page.goto("/");
  const composer = page.getByLabel("Ask the engineering knowledge base");
  await composer.fill("Why did we choose D1?");
  await composer.press("Shift+Enter");
  await expect(composer).toHaveValue("Why did we choose D1?\n");
  await composer.press("Enter");
  await expect(
    page.getByText("The answer service is temporarily unavailable."),
  ).toBeVisible();
  await expect(composer).toHaveValue("Why did we choose D1?");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText("D1 owns structured, relational, persistent data."),
  ).toBeVisible();
  expect(attempts).toBe(2);
});

test("shows an explicit insufficient-evidence answer", async ({ page }) => {
  await page.route("http://127.0.0.1:5173/api/chat", async (route) => {
    const response = chatResponse();
    response.userMessage.content = "What did we decide about Kubernetes?";
    response.assistantMessage.content =
      "The indexed knowledge base does not contain enough evidence to answer that question.";
    response.assistantMessage.confidence = "low";
    response.assistantMessage.citations = [];
    response.assistantMessage.unansweredQuestions = [
      "What source should be added to cover this topic?",
    ];
    await route.fulfill({ json: response });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "What did we decide about Kubernetes?" })
    .click();
  await expect(page.getByText("low confidence")).toBeVisible();
  await expect(page.getByText("Still unanswered")).toBeVisible();
  await expect(
    page.getByText("What source should be added to cover this topic?"),
  ).toBeVisible();
});

test("saves answer feedback and clears only after confirmation", async ({
  page,
}) => {
  await page.route("http://127.0.0.1:5173/api/chat", async (route) => {
    await route.fulfill({ json: chatResponse() });
  });
  let feedbackBody: unknown;
  await page.route("http://127.0.0.1:5173/api/feedback", async (route) => {
    feedbackBody = route.request().postDataJSON();
    await route.fulfill({
      json: { feedback: { rating: 1, correction: null } },
    });
  });
  let cleared = false;
  await page.route("http://127.0.0.1:5173/api/conversations", async (route) => {
    cleared = true;
    await route.fulfill({ json: { deletedConversations: 1 } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Why did we choose D1?" }).click();
  await page.getByRole("button", { name: "Useful" }).click();
  await expect(page.getByRole("button", { name: "Useful" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(feedbackBody).toMatchObject({
    messageId: assistantMessageId,
    rating: 1,
  });

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Clear history" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Ask what the engineering docs actually say.",
    }),
  ).toBeVisible();
  expect(cleared).toBe(true);
});

test("runs the demo garden and dismisses an evidence-linked finding", async ({
  page,
}) => {
  let scanned = false;
  let dismissed = false;
  await page.route(
    /http:\/\/127\.0\.0\.1:5173\/api\/garden(?:\?.*)?$/u,
    async (route) => {
      await route.fulfill({ json: gardenOverview(scanned, dismissed) });
    },
  );
  await page.route("http://127.0.0.1:5173/api/garden/scans", async (route) => {
    scanned = true;
    await route.fulfill({
      json: { scan: gardenScan(), reused: false },
    });
  });
  await page.route(
    `http://127.0.0.1:5173/api/garden/findings/${documentId}`,
    async (route) => {
      dismissed = true;
      await route.fulfill({ json: gardenFinding("dismissed") });
    },
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Garden" }).click();
  await expect(
    page.getByRole("heading", { name: "Review the knowledge garden." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Scan garden" }).click();
  await expect(
    page.getByRole("heading", { name: "Document may need a freshness review" }),
  ).toBeVisible();
  await expect(page.getByText("Review suggestion")).toBeVisible();
  await page.getByRole("button", { name: "Dismiss" }).click();
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
});

function chatResponse() {
  const createdAt = "2026-09-05T08:00:00.000Z";
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
      createdAt,
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
            lastEditedAt: createdAt,
          },
        },
      ],
      confidence: "high",
      unansweredQuestions: [],
      createdAt,
    },
  };
}

function gardenScan() {
  return {
    id: chunkId,
    status: "completed",
    aiStatus: "degraded",
    findingCount: 1,
    aiEnrichedCount: 0,
    errorCode: null,
    startedAt: "2026-09-05T08:00:00.000Z",
    completedAt: "2026-09-05T08:00:01.000Z",
  };
}

function gardenFinding(status: "open" | "dismissed") {
  const timestamp = "2026-09-05T08:00:01.000Z";
  return {
    id: documentId,
    fingerprint: "a".repeat(64),
    signalType: "stale_document",
    severity: "medium",
    status,
    version: status === "open" ? 1 : 2,
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
    firstDetectedAt: timestamp,
    lastDetectedAt: timestamp,
    dismissedAt: status === "dismissed" ? timestamp : null,
    resolvedAt: null,
    updatedAt: timestamp,
  };
}

function gardenOverview(scanned: boolean, dismissed: boolean) {
  return {
    policy: {
      staleAfterDays: 90,
      requiredMetadataKeys: ["status", "tags"],
      obsoleteTerms: [
        { term: "Node.js 24", replacement: "the supported runtime" },
      ],
    },
    latestScan: scanned ? gardenScan() : null,
    counts: {
      open: scanned && !dismissed ? 1 : 0,
      dismissed: dismissed ? 1 : 0,
      resolved: 0,
    },
    items: scanned ? [gardenFinding(dismissed ? "dismissed" : "open")] : [],
    nextCursor: null,
  };
}
