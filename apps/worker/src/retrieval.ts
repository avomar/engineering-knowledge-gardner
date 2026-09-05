import type { RetrievedChunk } from "./chat-repository";

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

function substantiveTokens(value: string): Set<string> {
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
