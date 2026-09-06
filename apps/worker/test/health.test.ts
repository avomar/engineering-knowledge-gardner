import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiErrorResponseSchema } from "@knowledge-gardener/domain";

import type { Env } from "../src/env";
import { app, createApp } from "../src/index";

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
  it("reports D1 readiness without internal details or CORS headers", async () => {
    const response = await request(
      "https://api.example.invalid/api/health",
      "https://untrusted.example.invalid",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(await response.json()).toEqual({
      status: "ok",
      mode: "demo",
      checks: { database: "ok", sourceConfiguration: "not_applicable" },
    });
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
      "https://api.example.invalid/api/health",
      {},
      failingEnvironment,
    );

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      status: "degraded",
      mode: "demo",
      checks: { database: "error", sourceConfiguration: "not_applicable" },
    });
    expect(body).not.toContain("sensitive database detail");
  });

  it("returns the API JSON error contract for an unknown API route", async () => {
    const response = await request(
      "https://api.example.invalid/api/not-a-route",
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "not_found",
    );
  });

  it("reports missing live Access configuration as degraded", async () => {
    const response = await createApp().request(
      "https://api.example.invalid/api/health",
      {},
      { ...environment, APP_MODE: "live" },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "degraded",
      checks: { accessValidation: "error" },
    });
  });

  it("fails closed for protected live routes and accepts verified assertions", async () => {
    const live: Env = {
      ...environment,
      APP_MODE: "live",
      ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
      ACCESS_AUD: "test-audience",
    };
    const protectedApp = createApp({
      accessVerifier: { verify: async () => "verified-subject" },
    });
    const missing = await protectedApp.request(
      "https://api.example.invalid/api/not-a-route",
      {},
      live,
    );
    expect(missing.status).toBe(401);

    const accepted = await protectedApp.request(
      "https://api.example.invalid/api/not-a-route",
      { headers: { "Cf-Access-Jwt-Assertion": "signed-token" } },
      live,
    );
    expect(accepted.status).toBe(404);

    const rejected = await createApp({
      accessVerifier: {
        verify: async () => Promise.reject(new Error("bad signature")),
      },
    }).request(
      "https://api.example.invalid/api/not-a-route",
      { headers: { "Cf-Access-Jwt-Assertion": "invalid-token" } },
      live,
    );
    expect(rejected.status).toBe(401);
    expect(await rejected.text()).not.toContain("bad signature");
  });

  it("does not require an Access assertion in public demo mode", async () => {
    const response = await createApp().request(
      "https://api.example.invalid/api/not-a-route",
      {},
      environment,
    );
    expect(response.status).toBe(404);
  });
});
