import type { RetrievedChunk } from "./chat-repository";
import {
  embedTexts,
  EmbeddingUnavailableError,
  InvalidEmbeddingResponseError,
} from "./embedding";

export const LEXICAL_CANDIDATE_LIMIT = 8;
export const SEMANTIC_CANDIDATE_LIMIT = 8;
export const FINAL_SOURCE_LIMIT = 6;
export const SEMANTIC_MINIMUM_SCORE = 0.72;
export const RRF_K = 60;
const stalePenalty = 0.8;

const ignoredTokens = new Set([
  "a",
  "about",
  "an",
  "and",
  "are",
  "choose",
  "decide",
  "did",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "our",
  "project",
  "the",
  "this",
  "to",
  "was",
  "we",
  "what",
  "when",
  "where",
  "why",
  "with",
]);

const aliases: Readonly<Record<string, string>> = {
  connections: "connection",
  locally: "local",
  mitigated: "mitigate",
  mitigation: "mitigate",
};

export interface RankedChunk extends RetrievedChunk {
  score: number;
}

export interface HybridCandidate extends RetrievedChunk {
  lexicalRank?: number;
  semanticRank?: number;
  semanticScore?: number;
}

export interface HybridRepository {
  listLexicalChunks(
    knowledgeSpaceId: string,
    question: string,
    limit: number,
  ): Promise<RetrievedChunk[]>;
  hydrateChunks(
    knowledgeSpaceId: string,
    chunkIds: readonly string[],
  ): Promise<RetrievedChunk[]>;
}

export interface HybridRetrievalResult {
  chunks: RetrievedChunk[];
  diagnostics: {
    lexicalCount: number;
    semanticCount: number;
    hydratedCount: number;
    selectedCount: number;
    staleCount: number;
    semanticAvailable: boolean;
  };
}

export class RetrievalUnavailableError extends Error {
  override readonly name = "RetrievalUnavailableError";
}

export class HybridRetriever {
  constructor(
    private readonly repository: HybridRepository,
    private readonly ai: Ai,
    private readonly index: VectorizeIndex | undefined,
  ) {}

  async retrieve(
    question: string,
    knowledgeSpaceId: string,
  ): Promise<HybridRetrievalResult> {
    let lexical: RetrievedChunk[];
    try {
      lexical = await this.repository.listLexicalChunks(
        knowledgeSpaceId,
        question,
        LEXICAL_CANDIDATE_LIMIT,
      );
    } catch (cause) {
      throw new RetrievalUnavailableError("Lexical retrieval is unavailable.", {
        cause,
      });
    }

    if (this.index === undefined) {
      return resultFromCandidates(lexical, [], [], false);
    }
    try {
      const [questionVector] = await embedTexts(this.ai, [question]);
      if (questionVector === undefined)
        throw new Error("Missing question embedding.");
      const response = await this.index.query(questionVector, {
        topK: SEMANTIC_CANDIDATE_LIMIT,
        namespace: knowledgeSpaceId,
        returnValues: false,
        returnMetadata: "none",
      });
      const semanticMatches = response.matches
        .filter((match) => (match.score ?? 0) >= SEMANTIC_MINIMUM_SCORE)
        .slice(0, SEMANTIC_CANDIDATE_LIMIT);
      const semanticIds = semanticMatches.map((match) => match.id);
      const hydrated = await this.repository.hydrateChunks(
        knowledgeSpaceId,
        semanticIds,
      );
      const semanticById = new Map(
        semanticMatches.map((match, index) => [
          match.id,
          { rank: index + 1, score: match.score ?? 0 },
        ]),
      );
      return resultFromCandidates(lexical, hydrated, semanticById, true);
    } catch (cause) {
      if (lexical.length > 0)
        return resultFromCandidates(lexical, [], [], false);
      if (
        cause instanceof EmbeddingUnavailableError ||
        cause instanceof InvalidEmbeddingResponseError
      ) {
        throw new RetrievalUnavailableError(
          "Semantic retrieval is unavailable.",
          {
            cause,
          },
        );
      }
      throw new RetrievalUnavailableError(
        "Semantic retrieval is unavailable.",
        {
          cause,
        },
      );
    }
  }
}

export function fuseCandidates(
  lexical: readonly RetrievedChunk[],
  semantic: readonly RetrievedChunk[],
  semanticRanks: ReadonlyMap<
    string,
    { rank: number; score: number }
  > = new Map(),
): RetrievedChunk[] {
  const candidates = new Map<string, HybridCandidate>();
  for (const [index, chunk] of lexical.entries()) {
    candidates.set(chunk.chunkId, { ...chunk, lexicalRank: index + 1 });
  }
  for (const chunk of semantic) {
    const semanticMatch = semanticRanks.get(chunk.chunkId);
    if (semanticMatch === undefined) continue;
    const current = candidates.get(chunk.chunkId);
    candidates.set(chunk.chunkId, {
      ...(current ?? chunk),
      semanticRank: semanticMatch.rank,
      semanticScore: semanticMatch.score,
    });
  }
  const ordered = [...candidates.values()].sort((left, right) => {
    const score = fusionScore(right) - fusionScore(left);
    if (score !== 0) return score;
    const stale =
      sourceIsStale(left) === sourceIsStale(right)
        ? 0
        : sourceIsStale(left)
          ? 1
          : -1;
    if (stale !== 0) return stale;
    return (
      (left.lexicalRank ?? Infinity) - (right.lexicalRank ?? Infinity) ||
      (left.semanticRank ?? Infinity) - (right.semanticRank ?? Infinity) ||
      left.source.title.localeCompare(right.source.title) ||
      left.chunkId.localeCompare(right.chunkId)
    );
  });
  const perDocument = new Map<string, number>();
  return ordered
    .filter((chunk) => {
      const count = perDocument.get(chunk.source.documentId) ?? 0;
      if (count >= 2) return false;
      perDocument.set(chunk.source.documentId, count + 1);
      return true;
    })
    .slice(0, FINAL_SOURCE_LIMIT);
}

function resultFromCandidates(
  lexical: readonly RetrievedChunk[],
  semantic: readonly RetrievedChunk[],
  semanticRanks: ReadonlyMap<string, { rank: number; score: number }> | [],
  semanticAvailable: boolean,
): HybridRetrievalResult {
  const chunks = fuseCandidates(
    lexical,
    semantic,
    semanticRanks instanceof Map ? semanticRanks : new Map(),
  );
  return {
    chunks,
    diagnostics: {
      lexicalCount: lexical.length,
      semanticCount: semantic.length,
      hydratedCount: semantic.length,
      selectedCount: chunks.length,
      staleCount: chunks.filter(sourceIsStale).length,
      semanticAvailable,
    },
  };
}

function fusionScore(chunk: HybridCandidate): number {
  const score =
    (chunk.lexicalRank === undefined ? 0 : 1 / (RRF_K + chunk.lexicalRank)) +
    (chunk.semanticRank === undefined ? 0 : 1 / (RRF_K + chunk.semanticRank));
  return sourceIsStale(chunk) ? score * stalePenalty : score;
}

function sourceIsStale(chunk: RetrievedChunk): boolean {
  return chunk.source.sourceState === "stale";
}

export function retrieveChunks(
  question: string,
  chunks: readonly RetrievedChunk[],
  limit = 6,
): RankedChunk[] {
  const queryTokens = substantiveTokens(question);
  if (queryTokens.size === 0) return [];

  return chunks
    .map((chunk) => scoreChunk(queryTokens, chunk))
    .filter((candidate): candidate is RankedChunk => candidate !== null)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.source.title.localeCompare(right.source.title) ||
        left.chunkId.localeCompare(right.chunkId),
    )
    .slice(0, limit);
}

function scoreChunk(
  queryTokens: ReadonlySet<string>,
  chunk: RetrievedChunk,
): RankedChunk | null {
  const title = tokenSet(chunk.source.title);
  const breadcrumb = tokenSet(chunk.source.breadcrumb.join(" "));
  const content = tokenSet(chunk.content);
  const titleMatches = intersectionCount(queryTokens, title);
  const breadcrumbMatches = intersectionCount(queryTokens, breadcrumb);
  const contentMatches = intersectionCount(queryTokens, content);
  const identifierMatch = [...queryTokens].some(
    (token) => /\d/u.test(token) && content.has(token),
  );
  if (titleMatches === 0 && contentMatches < 2 && !identifierMatch) return null;

  return {
    ...chunk,
    score:
      titleMatches * 12 +
      breadcrumbMatches * 5 +
      contentMatches * 2 +
      (identifierMatch ? 6 : 0),
  };
}

export function substantiveTokens(value: string): Set<string> {
  const tokens = tokenSet(value);
  for (const token of tokens) {
    if (ignoredTokens.has(token)) tokens.delete(token);
  }
  return tokens;
}

function tokenSet(value: string): Set<string> {
  const matches = value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu);
  return new Set((matches ?? []).map((token) => aliases[token] ?? token));
}

function intersectionCount(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}
