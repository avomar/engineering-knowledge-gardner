import {
  syncStartResponseSchema,
  type SyncStartResponse,
} from "@knowledge-gardener/domain";

import { stableUuid } from "./chunking";
import type { Env } from "./env";
import { normalizeNotionId } from "./notion";
import { SyncRepository } from "./sync-repository";

export class SyncServiceError extends Error {
  constructor(
    readonly code:
      | "source_configuration_error"
      | "workflow_unavailable"
      | "sync_not_found"
      | "invalid_cursor",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class SyncService {
  private readonly repository: SyncRepository;

  constructor(
    private readonly env: Env,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly createId: () => string = () => crypto.randomUUID(),
  ) {
    this.repository = new SyncRepository(env.DB);
  }

  async start(): Promise<SyncStartResponse> {
    const rootId = configuredRoot(this.env);
    const spaceId = await this.repository.ensureKnowledgeSpace({
      id: await stableUuid(`notion:space:${rootId}`),
      rootId,
      now: this.now(),
    });
    const active = await this.repository.findActive(spaceId);
    if (active !== null) {
      if (await this.isTerminalWorkflow(active.id)) {
        await this.repository.markOrphanedRunFailed(active.id, this.now());
      } else {
        return syncStartResponseSchema.parse({ run: active, reused: true });
      }
    }
    const runId = this.createId();
    let run;
    try {
      run = await this.repository.createRun({
        id: runId,
        spaceId,
        now: this.now(),
      });
    } catch {
      const raced = await this.repository.findActive(spaceId);
      if (raced !== null)
        return syncStartResponseSchema.parse({ run: raced, reused: true });
      throw new SyncServiceError(
        "workflow_unavailable",
        "Synchronization could not be started.",
        true,
      );
    }
    try {
      if (this.env.KNOWLEDGE_SYNC === undefined)
        throw new Error("Missing Workflow binding.");
      await this.env.KNOWLEDGE_SYNC.create({
        id: runId,
        params: { runId, knowledgeSpaceId: spaceId, rootId },
      });
    } catch {
      await this.repository.markWorkflowStartFailed(runId, this.now());
      throw new SyncServiceError(
        "workflow_unavailable",
        "Synchronization could not be started.",
        true,
      );
    }
    return syncStartResponseSchema.parse({ run, reused: false });
  }

  async overview(limit = 10) {
    const rootId = optionalRoot(this.env);
    const spaceId =
      rootId === null
        ? null
        : await this.repository.findSpaceId("live", rootId);
    return await this.repository.overview(spaceId, limit);
  }

  async detail(runId: string) {
    const rootId = configuredRoot(this.env);
    const spaceId = await this.repository.findSpaceId("live", rootId);
    if (spaceId === null)
      throw new SyncServiceError(
        "sync_not_found",
        "Synchronization run not found.",
        false,
      );
    const result = await this.repository.detail(runId, spaceId);
    if (result === null)
      throw new SyncServiceError(
        "sync_not_found",
        "Synchronization run not found.",
        false,
      );
    return result;
  }

  private async isTerminalWorkflow(instanceId: string): Promise<boolean> {
    const workflow = this.env.KNOWLEDGE_SYNC;
    if (workflow === undefined || typeof workflow.get !== "function") {
      return false;
    }
    try {
      const instance = await workflow.get(instanceId);
      const status = await instance.status();
      return ["complete", "errored", "terminated"].includes(status.status);
    } catch {
      return false;
    }
  }
}

export function optionalRoot(env: Env): string | null {
  if (!env.NOTION_TOKEN || !env.NOTION_ROOT_PAGE_ID) return null;
  try {
    return normalizeNotionId(env.NOTION_ROOT_PAGE_ID);
  } catch {
    return null;
  }
}

function configuredRoot(env: Env): string {
  const root = optionalRoot(env);
  if (root === null) {
    throw new SyncServiceError(
      "source_configuration_error",
      "The live Notion source is not configured.",
      false,
    );
  }
  return root;
}
