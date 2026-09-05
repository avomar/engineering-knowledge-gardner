import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  apiErrorResponseSchema,
  chatResponseSchema,
  conversationMessagesResponseSchema,
  type GroundedAnswer,
} from "@knowledge-gardener/domain";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AiUnavailableError,
  type AnswerGenerator,
  type GenerateAnswerInput,
} from "../src/answer-generator";
import type { Env } from "../src/env";
import { createApp } from "../src/index";

const directory = path.dirname(fileURLToPath(import.meta.url));
const sessionId = "30000000-0000-4000-8000-000000000001";
const otherSessionId = "30000000-0000-4000-8000-000000000002";

let miniflare: Miniflare;
let database: D1Database;

beforeAll(async () => {
  miniflare = new Miniflare({
    compatibilityDate: "2026-05-21",
    d1Databases: ["DB"],
    modules: true,
    script: "export default { fetch: () => new Response('ok') }",
  });
  database = await miniflare.getD1Database("DB");
  await applyMigrations(database);
});

afterAll(async () => {
  await miniflare.dispose();
});

describe("demo grounded chat", () => {
  it.each([
    [
      "Why did we choose D1?",
      "storage-adr",
      "structured, relational, persistent application data",
    ],
    [
      "How was the connection incident mitigated?",
      "connection-incident",
      "bulk-export-v2",
    ],
    ["How do I run this project locally?", "local-setup", "yarn dev"],
  ])(
    "answers and cites the required fixture for %s",
    async (question, expectedSource, expectedFact) => {
      const generator = new FixtureAnswerGenerator();
      const response = await chatRequest(generator, sessionId, { question });
      expect(response.status).toBe(200);
      const body = chatResponseSchema.parse(await response.json());
      expect(body.assistantMessage.content).toContain(expectedFact);
      expect(body.assistantMessage.confidence).toBe("high");
      expect(body.assistantMessage.citations[0]?.source.sourcePageId).toBe(
        expectedSource,
      );
      expect(body.assistantMessage.citations[0]?.source.sourceUrl).toMatch(
        /^demo:\/\//u,
      );
    },
  );

  it("refuses an undocumented question without calling Workers AI", async () => {
    const generator = new FixtureAnswerGenerator();
    const response = await chatRequest(generator, otherSessionId, {
      question: "What did we decide about Kubernetes?",
    });
    expect(response.status).toBe(200);
    const body = chatResponseSchema.parse(await response.json());
    expect(body.assistantMessage.content).toContain("enough evidence");
    expect(body.assistantMessage.confidence).toBe("low");
    expect(body.assistantMessage.citations).toEqual([]);
    expect(generator.calls).toHaveLength(0);
  });

  it("restores history only for the owning browser session", async () => {
    const generator = new FixtureAnswerGenerator();
    const created = chatResponseSchema.parse(
      await (
        await chatRequest(generator, sessionId, {
          question: "Why did we choose D1?",
        })
      ).json(),
    );
    const app = testApp(generator);
    const restored = await app.request(
      `https://api.example.invalid/api/conversations/${created.conversationId}/messages`,
      { headers: requestHeaders(sessionId) },
      environment(),
    );
    expect(restored.status).toBe(200);
    const history = conversationMessagesResponseSchema.parse(
      await restored.json(),
    );
    expect(history.messages).toHaveLength(2);
    expect(history.messages[1]?.citations[0]?.source.sourcePageId).toBe(
      "storage-adr",
    );

    const hidden = await app.request(
      `https://api.example.invalid/api/conversations/${created.conversationId}/messages`,
      { headers: requestHeaders(otherSessionId) },
      environment(),
    );
    expect(hidden.status).toBe(404);
    expect(apiErrorResponseSchema.parse(await hidden.json()).error.code).toBe(
      "conversation_not_found",
    );
  });

  it("passes at most the previous four pairs to continued chat", async () => {
    const generator = new FixtureAnswerGenerator();
    const first = chatResponseSchema.parse(
      await (
        await chatRequest(generator, otherSessionId, {
          question: "Why did we choose D1?",
        })
      ).json(),
    );
    const continued = await chatRequest(generator, otherSessionId, {
      question: "How was the connection incident mitigated?",
      conversationId: first.conversationId,
    });
    expect(continued.status).toBe(200);
    expect(generator.calls.at(-1)?.history).toHaveLength(2);
  });

  it("rejects an unknown citation and persists no partial turn", async () => {
    const before = await messageCount();
    const generator: AnswerGenerator = {
      generate: async () => ({
        answer: "Unsupported citation",
        confidence: "high",
        citations: [
          {
            chunkId: "40000000-0000-4000-8000-000000000001",
            quote: "not in the source",
          },
        ],
        unansweredQuestions: [],
      }),
    };
    const response = await chatRequest(generator, sessionId, {
      question: "Why did we choose D1?",
    });
    expect(response.status).toBe(502);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "invalid_ai_response",
    );
    expect(await messageCount()).toBe(before);
  });

  it.each([
    { answer: "missing fields" },
    {
      answer: "A citation-free supported answer.",
      confidence: "high",
      citations: [],
      unansweredQuestions: [],
    },
  ])("rejects malformed or ungrounded model output", async (output) => {
    const response = await chatRequest(
      { generate: async () => output },
      sessionId,
      { question: "Why did we choose D1?" },
    );
    expect(response.status).toBe(502);
  });

  it("rejects a fabricated quote from an otherwise valid source", async () => {
    const generator: AnswerGenerator = {
      generate: async (input) => ({
        answer: "D1 stores everything.",
        confidence: "high",
        citations: [
          {
            chunkId: input.sources[0]?.chunkId,
            quote: "This sentence does not occur in the fixture.",
          },
        ],
        unansweredQuestions: [],
      }),
    };
    const response = await chatRequest(generator, sessionId, {
      question: "Why did we choose D1?",
    });
    expect(response.status).toBe(502);
  });

  it("retries one rejected answer with corrective generation context", async () => {
    const calls: GenerateAnswerInput[] = [];
    const generator: AnswerGenerator = {
      generate: async (input) => {
        calls.push(input);
        return {
          answer: "D1 stores structured relational data.",
          confidence: "high",
          citations: [
            {
              chunkId: input.sources[0]?.chunkId,
              quote:
                calls.length === 1
                  ? "This sentence does not occur in the fixture."
                  : "D1 is the primary store for structured, relational, persistent application data.",
            },
          ],
          unansweredQuestions: [],
        };
      },
    };

    const response = await chatRequest(generator, sessionId, {
      question: "Why did we choose D1?",
    });

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.retry).toBeUndefined();
    expect(calls[1]?.retry).toBe(true);
  });

  it("returns a safe AI-unavailable error", async () => {
    const response = await chatRequest(
      {
        generate: async () => {
          throw new AiUnavailableError("private upstream detail");
        },
      },
      sessionId,
      { question: "Why did we choose D1?" },
    );
    const text = await response.text();
    expect(response.status).toBe(503);
    expect(apiErrorResponseSchema.parse(JSON.parse(text)).error.code).toBe(
      "ai_unavailable",
    );
    expect(text).not.toContain("private upstream detail");
  });

  it("validates input and enforces the AI rate limit", async () => {
    const invalid = await chatRequest(new FixtureAnswerGenerator(), sessionId, {
      question: "x".repeat(2_001),
    });
    expect(invalid.status).toBe(400);

    const denied = await chatRequest(
      new FixtureAnswerGenerator(),
      sessionId,
      { question: "Why did we choose D1?" },
      { limit: async () => ({ success: false }) } as RateLimit,
    );
    expect(denied.status).toBe(429);
    expect(denied.headers.get("Retry-After")).toBe("60");
  });

  it("fails closed outside demo mode", async () => {
    const response = await testApp(new FixtureAnswerGenerator()).request(
      "https://api.example.invalid/api/chat",
      {
        method: "POST",
        headers: requestHeaders(sessionId),
        body: JSON.stringify({ question: "Why did we choose D1?" }),
      },
      { ...environment(), APP_MODE: "live" },
    );
    expect(response.status).toBe(503);
    expect(apiErrorResponseSchema.parse(await response.json()).error.code).toBe(
      "mode_unavailable",
    );
  });
});

class FixtureAnswerGenerator implements AnswerGenerator {
  readonly calls: GenerateAnswerInput[] = [];

  async generate(input: GenerateAnswerInput): Promise<GroundedAnswer> {
    this.calls.push(input);
    const source = input.sources[0];
    if (source === undefined) throw new Error("Expected a retrieved fixture.");
    const values: Record<string, { answer: string; quote: string }> = {
      "storage-adr": {
        answer:
          "D1 was chosen for structured, relational, persistent application data.",
        quote:
          "D1 is the primary store for structured, relational, persistent application data.",
      },
      "connection-incident": {
        answer:
          "The incident was mitigated by disabling bulk export with the bulk-export-v2 feature flag.",
        quote:
          "The on-call engineer disabled the bulk export path with the `bulk-export-v2` feature flag.",
      },
      "local-setup": {
        answer: "Use the documented command: yarn dev.",
        quote: "Run `yarn dev` to start the local application.",
      },
    };
    const value = values[source.source.sourcePageId];
    if (value === undefined) throw new Error("Unexpected fixture ranking.");
    return {
      answer: value.answer,
      confidence: "high",
      citations: [{ chunkId: source.chunkId, quote: value.quote }],
      unansweredQuestions: [],
    };
  }
}

function testApp(generator: AnswerGenerator) {
  return createApp({
    createAnswerGenerator: () => generator,
    log: () => undefined,
  });
}

function environment(rateLimiter: RateLimit = allowRateLimit()): Env {
  return {
    DB: database,
    AI: {} as Ai,
    CHAT_RATE_LIMITER: rateLimiter,
    APP_MODE: "demo",
  };
}

async function chatRequest(
  generator: AnswerGenerator,
  browserSessionId: string,
  body: unknown,
  rateLimiter: RateLimit = allowRateLimit(),
): Promise<Response> {
  return await testApp(generator).request(
    "https://api.example.invalid/api/chat",
    {
      method: "POST",
      headers: requestHeaders(browserSessionId),
      body: JSON.stringify(body),
    },
    environment(rateLimiter),
  );
}

function requestHeaders(browserSessionId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-Demo-Session-Id": browserSessionId,
  };
}

function allowRateLimit(): RateLimit {
  return { limit: async () => ({ success: true }) } as RateLimit;
}

async function messageCount(): Promise<number> {
  return (
    (await database
      .prepare("SELECT COUNT(*) AS count FROM messages")
      .first<number>("count")) ?? 0
  );
}

async function applyMigrations(target: D1Database): Promise<void> {
  const files = [
    "0001_initial.sql",
    "0002_chat_answer_metadata.sql",
    "0003_live_notion_sync.sql",
  ];
  for (const filename of files) {
    const migration = await readFile(
      path.join(directory, "../migrations", filename),
      "utf8",
    );
    const statements = migration
      .split(";")
      .map((statement) => statement.trim())
      .filter(
        (statement) =>
          statement !== "" && !statement.startsWith("PRAGMA foreign_keys"),
      )
      .map((statement) => target.prepare(statement));
    await target.batch(statements);
  }
}
