import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { app } from "../src/index";

let miniflare: Miniflare;
let environment: Env;

beforeAll(async () => {
  miniflare = new Miniflare({
    compatibilityDate: "2026-05-21",
    d1Databases: ["DB"],
    modules: true,
    script: "export default { fetch: () => new Response('ok') }",
  });
  environment = {
    DB: await miniflare.getD1Database("DB"),
    AI: {} as Ai,
    CHAT_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    } as RateLimit,
    APP_ALLOWED_ORIGIN: "http://localhost:5173",
    APP_MODE: "demo",
  };
});

afterAll(async () => {
  await miniflare.dispose();
});

async function request(url: string, origin?: string): Promise<Response> {
  return app.request(
    url,
    origin === undefined ? {} : { headers: { Origin: origin } },
    environment,
  );
}

describe("GET /health", () => {
  it("reports D1 readiness without internal details", async () => {
    const response = await request(
      "https://api.example.invalid/health",
      environment.APP_ALLOWED_ORIGIN,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      environment.APP_ALLOWED_ORIGIN,
    );
    expect(await response.json()).toEqual({
      status: "ok",
      mode: "demo",
      checks: { database: "ok" },
    });
  });

  it("does not grant CORS to another origin", async () => {
    const response = await request(
      "https://api.example.invalid/health",
      "https://untrusted.example.invalid",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("fails closed when the database check throws", async () => {
    const failingEnvironment: Env = {
      ...environment,
      DB: {
        prepare: () => {
          throw new Error("sensitive database detail");
        },
      } as unknown as D1Database,
    };
    const response = await app.request(
      "https://api.example.invalid/health",
      {},
      failingEnvironment,
    );

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      status: "degraded",
      mode: "demo",
      checks: { database: "error" },
    });
    expect(body).not.toContain("sensitive database detail");
  });
});
