export const EMBEDDING_MODEL = "@cf/baai/bge-small-en-v1.5" as const;
export const EMBEDDING_POOLING = "cls" as const;
export const EMBEDDING_DIMENSIONS = 384;
export const EMBEDDING_VERSION = "bge-small-en-v1.5:cls:chunk-v2" as const;
export const EMBEDDING_BATCH_SIZE = 32;

export class EmbeddingUnavailableError extends Error {
  override readonly name = "EmbeddingUnavailableError";
}

export class InvalidEmbeddingResponseError extends Error {
  override readonly name = "InvalidEmbeddingResponseError";
}

export async function embedTexts(
  ai: Ai,
  texts: readonly string[],
  log: (record: Record<string, unknown>) => void = (record) =>
    console.log(JSON.stringify(record)),
): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBEDDING_BATCH_SIZE);
    const began = Date.now();
    let response: unknown;
    try {
      response = await ai.run(EMBEDDING_MODEL, {
        text: batch,
        pooling: EMBEDDING_POOLING,
      });
    } catch (cause) {
      log({
        event: "embedding.failed",
        model: EMBEDDING_MODEL,
        batchSize: batch.length,
        category: "unavailable",
      });
      throw new EmbeddingUnavailableError(
        "Workers AI embeddings are unavailable.",
        {
          cause,
        },
      );
    }
    const output = embeddingArray(response);
    if (output.length !== batch.length || !output.every(validVector)) {
      log({
        event: "embedding.failed",
        model: EMBEDDING_MODEL,
        batchSize: batch.length,
        category: "invalid_response",
      });
      throw new InvalidEmbeddingResponseError(
        "Workers AI returned invalid embeddings.",
      );
    }
    log({
      event: "embedding.completed",
      model: EMBEDDING_MODEL,
      batchSize: batch.length,
      durationMs: Date.now() - began,
    });
    vectors.push(...output);
  }
  return vectors;
}

function embeddingArray(value: unknown): number[][] {
  if (Array.isArray(value)) return value as number[][];
  if (typeof value !== "object" || value === null) return [];
  const data = (value as Record<string, unknown>).data;
  return Array.isArray(data) ? (data as number[][]) : [];
}

function validVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSIONS &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}
