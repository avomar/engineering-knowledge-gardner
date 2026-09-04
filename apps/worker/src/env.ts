import type { AppMode } from "@knowledge-gardener/domain";

export interface Env {
  DB: D1Database;
  APP_MODE: AppMode;
  APP_ALLOWED_ORIGIN: string;
}
