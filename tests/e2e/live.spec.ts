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
