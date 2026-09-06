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
  NOTION_DRAFTS_PARENT_ID?: string;
  KNOWLEDGE_INDEX?: VectorizeIndex;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  GARDEN_STALE_AFTER_DAYS?: string;
  GARDEN_REQUIRED_METADATA_KEYS?: string;
  GARDEN_OBSOLETE_TERMS?: string;
  DEMO_RETENTION_DAYS?: string;
}
