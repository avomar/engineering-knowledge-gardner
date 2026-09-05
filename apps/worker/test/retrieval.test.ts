import { describe, expect, it } from "vitest";

import type { RetrievedChunk } from "../src/chat-repository";
import { retrieveChunks } from "../src/retrieval";

const chunks: RetrievedChunk[] = [
  chunk(
    "10000000-0000-4000-8000-000000000201",
    "connection-incident",
    "Connection Exhaustion Incident",
    "The incident was mitigated with the bulk-export-v2 feature flag.",
  ),
  chunk(
    "10000000-0000-4000-8000-000000000202",
    "local-setup",
    "Local Development Setup",
    "Run yarn dev for the local application.",
  ),
  chunk(
    "10000000-0000-4000-8000-000000000203",
    "storage-adr",
    "ADR: Storage Responsibilities",
    "D1 is the primary store for structured relational persistent data.",
  ),
];

describe("fixture lexical retrieval", () => {
  it.each([
    ["Why did we choose D1?", "storage-adr"],
    ["How was the connection incident mitigated?", "connection-incident"],
    ["How do I run this project locally?", "local-setup"],
  ])("ranks the expected fixture for %s", (question, sourcePageId) => {
    expect(retrieveChunks(question, chunks)[0]?.source.sourcePageId).toBe(
      sourcePageId,
    );
  });

  it("returns no evidence for an undocumented Kubernetes decision", () => {
    expect(
      retrieveChunks("What did we decide about Kubernetes?", chunks),
    ).toEqual([]);
  });

  it("uses a stable title tie-break and result cap", () => {
    const repeated = Array.from({ length: 8 }, (_, index) =>
      chunk(
        `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        `source-${index}`,
        `Local ${String.fromCharCode(65 + index)}`,
        "local run instructions",
      ),
    );
    const result = retrieveChunks("run locally", repeated, 6);
    expect(result).toHaveLength(6);
    expect(result.map(({ source }) => source.title)).toEqual([
      "Local A",
      "Local B",
      "Local C",
      "Local D",
      "Local E",
      "Local F",
    ]);
  });
});

function chunk(
  chunkId: string,
  sourcePageId: string,
  title: string,
  content: string,
): RetrievedChunk {
  return {
    chunkId,
    content,
    source: {
      documentId: chunkId.replace(/2(?=\d{2}$)/u, "1"),
      sourcePageId,
      title,
      breadcrumb: ["Engineering Knowledge", title],
      sourceUrl: `demo://documents/${sourcePageId}`,
      lastEditedAt: "2026-09-05T00:00:00.000Z",
    },
  };
}
