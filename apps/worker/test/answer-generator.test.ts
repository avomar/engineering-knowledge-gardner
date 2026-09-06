import { describe, expect, it, vi } from "vitest";

import {
  ANSWER_MODEL,
  AiUnavailableError,
  InvalidAiResponseError,
  WorkersAiAnswerGenerator,
  type GenerateAnswerInput,
} from "../src/answer-generator";

const input: GenerateAnswerInput = {
  question: "Why D1?",
  history: [],
  sources: [
    {
      chunkId: "60000000-0000-4000-8000-000000000001",
      content: "D1 stores structured data.",
      source: {
        documentId: "60000000-0000-4000-8000-000000000002",
        sourcePageId: "storage-adr",
        title: "Storage ADR",
        breadcrumb: ["Engineering Knowledge", "Storage ADR"],
        sourceUrl: "demo://documents/storage-adr",
        lastEditedAt: "2026-09-05T00:00:00.000Z",
        lastSyncedAt: "2026-09-05T00:00:00.000Z",
        sourceState: "current",
      },
    },
  ],
};

describe("Workers AI answer generator", () => {
  it("requests bounded JSON-schema output and reports usage", async () => {
    const answer = {
      answer: "D1 stores structured data.",
      confidence: "high",
      citations: [
        {
          chunkId: input.sources[0]?.chunkId,
          quote: "D1 stores structured data.",
        },
      ],
      unansweredQuestions: [],
    };
    const run = vi.fn().mockResolvedValue({
      response: answer,
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    });
    const log = vi.fn();
    const generator = new WorkersAiAnswerGenerator(
      { run } as unknown as Ai,
      log,
    );

    await expect(generator.generate(input)).resolves.toEqual(answer);
    expect(run).toHaveBeenCalledWith(
      ANSWER_MODEL,
      expect.objectContaining({
        max_tokens: 768,
        temperature: 0,
        response_format: expect.objectContaining({ type: "json_schema" }),
      }),
    );
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai.completed",
        usage: expect.anything(),
      }),
    );
  });

  it("parses string responses for compatibility", async () => {
    const answer = {
      answer: "D1 stores structured data.",
      confidence: "high",
      citations: [],
      unansweredQuestions: [],
    };
    const generator = new WorkersAiAnswerGenerator({
      run: vi.fn().mockResolvedValue({ response: JSON.stringify(answer) }),
    } as unknown as Ai);

    await expect(generator.generate(input)).resolves.toEqual(answer);
  });

  it("adds corrective instructions to a retry attempt", async () => {
    const answer = {
      answer: "D1 stores structured data.",
      confidence: "high",
      citations: [],
      unansweredQuestions: [],
    };
    const run = vi.fn().mockResolvedValue({
      response: answer,
      usage: { neurons: 2 },
    });
    const log = vi.fn();
    const generator = new WorkersAiAnswerGenerator(
      { run } as unknown as Ai,
      log,
    );

    await expect(
      generator.generate({ ...input, retry: true }),
    ).resolves.toEqual(answer);
    expect(run).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai.completed",
        attempt: 2,
        usage: { neurons: 2 },
      }),
    );
    expect(JSON.stringify(run.mock.calls[0]?.[1])).toContain(
      "previous response failed validation",
    );
  });

  it("classifies invalid JSON separately from upstream failure", async () => {
    const invalidRun = vi.fn().mockResolvedValue({ response: "not json" });
    const invalid = new WorkersAiAnswerGenerator({
      run: invalidRun,
    } as unknown as Ai);
    await expect(invalid.generate(input)).rejects.toBeInstanceOf(
      InvalidAiResponseError,
    );
    expect(invalidRun).toHaveBeenCalledOnce();

    const unavailableRun = vi
      .fn()
      .mockRejectedValue(new Error("private upstream detail"));
    const unavailable = new WorkersAiAnswerGenerator({
      run: unavailableRun,
    } as unknown as Ai);
    await expect(unavailable.generate(input)).rejects.toBeInstanceOf(
      AiUnavailableError,
    );
    expect(unavailableRun).toHaveBeenCalledOnce();
  });

  it("rejects responses without a structured payload", async () => {
    const generator = new WorkersAiAnswerGenerator({
      run: vi.fn().mockResolvedValue({ usage: { total_tokens: 1 } }),
    } as unknown as Ai);

    await expect(generator.generate(input)).rejects.toBeInstanceOf(
      InvalidAiResponseError,
    );
  });
});
