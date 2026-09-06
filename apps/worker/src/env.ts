import type { AppMode } from "@knowledge-gardener/domain";

import type { SyncWorkflowParams } from "./sync-workflow";

export interface Env {
  DB: D1Database;
  AI: Ai;
  CHAT_RATE_LIMITER: RateLimit;
  APP_MODE: AppMode;
  KNOWLEDGE_SYNC?: Workflow<SyncWorkflowParams>;
  NOTION_TOKEN?: string;
  NOTION_ROOT_PAGE_ID?: string;
  KNOWLEDGE_INDEX?: VectorizeIndex;
}
