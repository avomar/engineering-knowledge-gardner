import type { DocumentChunk } from "@knowledge-gardener/domain";

const namespace = "77902f23-8ec3-5c25-a03e-2f91222980d1";
export const CHUNKING_VERSION = 2;
const targetTokens = 360;
const maximumTokens = 400;
const overlapTokens = 60;
const maximumPrefixTokens = 48;

export async function checksum(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return hex(new Uint8Array(digest));
}

export async function stableUuid(name: string): Promise<string> {
  const namespaceBytes = uuidBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(namespaceBytes.length + nameBytes.length);
  input.set(namespaceBytes);
  input.set(nameBytes, namespaceBytes.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const bytes = hash.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export async function chunkDocument(input: {
  documentId: string;
  sourcePageId: string;
  title: string;
  breadcrumb: string[];
  markdown: string;
  createdAt: string;
}): Promise<DocumentChunk[]> {
  const prefix = boundedPrefix(input.title, input.breadcrumb);
  const prefixTokenCount = estimateTokens(prefix);
  const maximumBodyTokens = Math.max(1, maximumTokens - prefixTokenCount);
  const targetBodyTokens = Math.max(1, targetTokens - prefixTokenCount);
  const words = input.markdown.trim().split(/\s+/u).filter(Boolean);
  const chunks: string[] = [];
  for (let start = 0; start < words.length;) {
    const end = findEnd(words, start, targetBodyTokens, maximumBodyTokens);
    chunks.push(`${prefix}${words.slice(start, end).join(" ")}`.trim());
    if (end === words.length) break;
    start = Math.max(start + 1, end - overlapTokens);
  }
  if (chunks.length === 0) chunks.push(prefix.trim());
  return await Promise.all(
    chunks.map(async (content, ordinal) => {
      const chunkChecksum = await checksum(content);
      return {
        id: await stableUuid(
          `notion:chunk:v${CHUNKING_VERSION}:${input.sourcePageId}:${ordinal}:${chunkChecksum}`,
        ),
        documentId: input.documentId,
        ordinal,
        content,
        tokenCount: estimateTokens(content),
        checksum: chunkChecksum,
        createdAt: input.createdAt,
      };
    }),
  );
}

function boundedPrefix(title: string, breadcrumb: string[]): string {
  const candidates = [`Source: ${title}`, `Path: ${breadcrumb.join(" / ")}`];
  const words = candidates.join("\n").split(/\s+/u);
  return `${words.slice(0, maximumPrefixTokens).join(" ")}\n\n`;
}

function findEnd(
  words: readonly string[],
  start: number,
  target: number,
  maximum: number,
): number {
  const hardEnd = Math.min(words.length, start + maximum);
  const preferredEnd = Math.min(hardEnd, start + target);
  for (let end = preferredEnd; end > start + Math.min(20, target); end -= 1) {
    if (/[.!?]$/u.test(words[end - 1] ?? "")) return end;
  }
  return preferredEnd;
}

export function estimateTokens(value: string): number {
  return (
    value.normalize("NFKC").match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)?.length ??
    0
  );
}

function uuidBytes(value: string): Uint8Array {
  const compact = value.replaceAll("-", "");
  return new Uint8Array(
    compact.match(/.{2}/gu)!.map((part) => Number.parseInt(part, 16)),
  );
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}
