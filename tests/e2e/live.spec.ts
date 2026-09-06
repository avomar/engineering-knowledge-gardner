import { expect, test } from "@playwright/test";

const runId = "60000000-0000-4000-8000-000000000001";
const spaceId = "60000000-0000-4000-8000-000000000002";
const documentId = "60000000-0000-4000-8000-000000000003";
const now = "2026-09-05T08:00:00.000Z";

test.beforeEach(async ({ page }) => {
  await page.route("http://127.0.0.1:5173/api/health", async (route) => {
    await route.fulfill({
      json: {
        status: "ok",
        mode: "live",
        checks: { database: "ok", sourceConfiguration: "ok" },
      },
    });
  });
});

test("starts a live sync and renders completed counts", async ({ page }) => {
  let overviewRequests = 0;
  await page.route("http://127.0.0.1:5173/api/sync", async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ json: { run: syncRun("queued"), reused: false } });
      return;
    }
    overviewRequests += 1;
    await route.fulfill({
      json:
        overviewRequests === 1
          ? { knowledgeSpace: null, runs: [] }
          : overview(syncRun("completed")),
    });
  });
  await page.route(`http://127.0.0.1:5173/api/sync/${runId}`, async (route) => {
    await route.fulfill({ json: { run: syncRun("completed"), documents: [] } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "sync", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Keep the source garden current." }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start sync" }).click();
  await expect(
    page.getByText("completed", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Discovered", { exact: true }).locator("..").getByText("3"),
  ).toBeVisible();
});

test("browses fresh live Notion sources through safe links", async ({
  page,
}) => {
  await page.route("http://127.0.0.1:5173/api/sync", async (route) => {
    await route.fulfill({ json: overview(syncRun("completed")) });
  });
  await page.route(`http://127.0.0.1:5173/api/sync/${runId}`, async (route) => {
    await route.fulfill({ json: { run: syncRun("completed"), documents: [] } });
  });
  await page.route(
    /http:\/\/127\.0\.0\.1:5173\/api\/documents\/search.*/u,
    async (route) => {
      await route.fulfill({
        json: {
          items: [
            {
              id: documentId,
              sourcePageId: "70000000-0000-4000-8000-000000000001",
              title: "Deployment Runbook",
              breadcrumb: ["Engineering", "Runbooks", "Deployment Runbook"],
              sourceUrl:
                "https://www.notion.so/70000000000040008000000000000001",
              excerpt:
                "Deploy with Wrangler and validate staging before promotion.",
              lastEditedAt: now,
              lastSyncedAt: now,
              indexStatus: "indexed",
              errorMessage: null,
            },
          ],
          nextCursor: null,
        },
      });
    },
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Sources" }).click();
  const source = page.getByRole("link", { name: "Deployment Runbook" });
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute("target", "_blank");
  await expect(page.getByText("indexed", { exact: true })).toBeVisible();
  await expect(page.getByText(/Deploy with Wrangler/u)).toBeVisible();
});

test("requires typed confirmation before resetting the live source index", async ({
  page,
}) => {
  await page.route("http://127.0.0.1:5173/api/sync", async (route) => {
    await route.fulfill({ json: overview(syncRun("completed")) });
  });
  await page.route(`http://127.0.0.1:5173/api/sync/${runId}`, async (route) => {
    await route.fulfill({ json: { run: syncRun("completed"), documents: [] } });
  });
  let resetBody: unknown;
  await page.route(
    "http://127.0.0.1:5173/api/maintenance/index-reset",
    async (route) => {
      resetBody = route.request().postDataJSON();
      await route.fulfill({
        json: {
          deletedDocuments: 3,
          queuedVectors: 7,
          pendingVectorCleanup: false,
        },
      });
    },
  );

  await page.goto("/");
  await page.getByRole("button", { name: "sync", exact: true }).click();
  const reset = page.getByRole("button", { name: "Reset index" });
  await expect(reset).toBeDisabled();
  await page.getByLabel("Type RESET INDEX to confirm").fill("RESET INDEX");
  await reset.click();
  await expect(
    page.getByText(/Existing chats and drafts were preserved/u),
  ).toBeVisible();
  expect(resetBody).toEqual({ confirmation: "RESET INDEX" });
});

test("edits draft assumptions and explicitly publishes frozen evidence", async ({
  page,
}) => {
  await page.route("http://127.0.0.1:5173/api/sync", async (route) => {
    await route.fulfill({ json: overview(syncRun("completed")) });
  });
  await page.route(`http://127.0.0.1:5173/api/sync/${runId}`, async (route) => {
    await route.fulfill({ json: { run: syncRun("completed"), documents: [] } });
  });
  let draft = publicDraft();
  let editBody: Record<string, unknown> | null = null;
  let publishBody: Record<string, unknown> | null = null;
  await page.route("http://127.0.0.1:5173/api/drafts", async (route) => {
    await route.fulfill({ json: { items: [draft], nextCursor: null } });
  });
  await page.route(
    `http://127.0.0.1:5173/api/drafts/${draft.id}`,
    async (route) => {
      editBody = route.request().postDataJSON() as Record<string, unknown>;
      draft = {
        ...draft,
        assumptions: editBody.assumptions as string[],
        version: 2,
        wasEdited: true,
      };
      await route.fulfill({ json: draft });
    },
  );
  await page.route(
    `http://127.0.0.1:5173/api/drafts/${draft.id}/publish`,
    async (route) => {
      publishBody = route.request().postDataJSON() as Record<string, unknown>;
      draft = {
        ...draft,
        status: "published",
        publishState: "published",
        notionPageId: "60000000-0000-4000-8000-000000000009",
        notionUrl: "https://www.notion.so/60000000000040008000000000000009",
        publishedAt: now,
      };
      await route.fulfill({ json: { draft, reused: false } });
    },
  );

  await page.goto("/");
  await page.getByRole("button", { name: "drafts", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Review before Notion sees it." }),
  ).toBeVisible();
  await expect(page.getByText("Frozen source evidence")).toBeVisible();
  await page
    .getByLabel("Assumptions, one per line")
    .fill("Confirm the owner\nVerify the rollback window");
  await page.getByRole("button", { name: "Save review" }).click();
  expect(editBody).toMatchObject({
    assumptions: ["Confirm the owner", "Verify the rollback window"],
    version: 1,
  });

  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Publish to Notion" }).click();
  await expect(
    page.getByRole("link", { name: "Open published Notion page" }),
  ).toBeVisible();
  expect(publishBody).toEqual({ version: 2, confirmed: true });
});

function syncRun(status: "queued" | "completed") {
  return {
    id: runId,
    knowledgeSpaceId: spaceId,
    workflowInstanceId: runId,
    status,
    startedAt: status === "queued" ? null : now,
    completedAt: status === "completed" ? now : null,
    discoveredCount: status === "completed" ? 3 : 0,
    indexedCount: status === "completed" ? 3 : 0,
    skippedCount: 0,
    failedCount: 0,
    deletedCount: 0,
    errorSummary: null,
    errorCode: null,
    discoveryComplete: status === "completed",
    createdAt: now,
  };
}

function overview(run: ReturnType<typeof syncRun>) {
  return {
    knowledgeSpace: {
      id: spaceId,
      name: "Notion Engineering Knowledge",
      freshness: "fresh",
      lastSuccessfulSyncAt: now,
    },
    runs: [run],
  };
}

function publicDraft() {
  return {
    id: "60000000-0000-4000-8000-000000000004",
    knowledgeSpaceId: spaceId,
    ownerSessionId: "60000000-0000-4000-8000-000000000005",
    sourceMessageId: "60000000-0000-4000-8000-000000000006",
    generationInstruction: null,
    title: "Incident follow-up",
    contentMarkdown: "## Mitigation\n\nDisable the fictional export path.",
    sources: [
      {
        chunkId: "60000000-0000-4000-8000-000000000007",
        documentId,
        sourcePageId: "70000000-0000-4000-8000-000000000001",
        title: "Connection incident",
        breadcrumb: ["Engineering", "Incidents", "Connection incident"],
        sourceUrl: "https://www.notion.so/70000000000040008000000000000001",
        quote: "The export path was disabled with a feature flag.",
        sourceState: "current",
        lastSyncedAt: now,
        checksum: "fictional-checksum",
      },
    ],
    assumptions: ["Confirm the owner before adoption."],
    targetParentId: "60000000-0000-4000-8000-000000000008",
    status: "pending",
    version: 1,
    wasEdited: false,
    publishState: "idle",
    publishAttemptCount: 0,
    notionPageId: null,
    notionUrl: null,
    createdAt: now,
    updatedAt: now,
    publishedAt: null,
    feedback: null,
  };
}
