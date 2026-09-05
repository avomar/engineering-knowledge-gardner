import type { AppMode } from "@knowledge-gardener/domain";

export interface Env {
  DB: D1Database;
  AI: Ai;
  CHAT_RATE_LIMITER: RateLimit;
  APP_MODE: AppMode;
  APP_ALLOWED_ORIGIN: string;
}
