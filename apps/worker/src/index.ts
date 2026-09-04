import {
  healthResponseSchema,
  type HealthResponse,
} from "@knowledge-gardener/domain";
import { Hono } from "hono";

import type { Env } from "./env";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (context, next) => {
  const origin = context.req.header("Origin");

  if (context.req.method === "OPTIONS") {
    if (origin !== context.env.APP_ALLOWED_ORIGIN) {
      return context.body(null, 403);
    }
    return context.body(null, 204, {
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
    });
  }

  await next();
  if (origin === context.env.APP_ALLOWED_ORIGIN) {
    context.header("Access-Control-Allow-Origin", origin);
    context.header("Vary", "Origin");
  }
});

app.get("/health", async (context) => {
  try {
    const result =
      await context.env.DB.prepare("SELECT 1 AS ok").first<number>("ok");
    if (result !== 1) throw new Error("Database readiness query failed.");

    const response: HealthResponse = {
      status: "ok",
      mode: context.env.APP_MODE,
      checks: { database: "ok" },
    };
    return context.json(healthResponseSchema.parse(response), 200);
  } catch {
    const response: HealthResponse = {
      status: "degraded",
      mode: context.env.APP_MODE,
      checks: { database: "error" },
    };
    return context.json(healthResponseSchema.parse(response), 503);
  }
});

app.notFound((context) => context.json({ error: "Not found" }, 404));

export { app };
export default app;
