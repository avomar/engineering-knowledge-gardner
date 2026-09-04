import {
  jsonValueSchema,
  sourceTypeSchema,
  type SourceType,
} from "@knowledge-gardener/domain";
import { z } from "zod";

export const sourcePageReferenceSchema = z.object({
  sourceType: sourceTypeSchema,
  sourcePageId: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  sourceUrl: z.string().url().nullable(),
  parentSourcePageId: z.string().trim().min(1).max(500).nullable(),
  lastEditedAt: z.string().datetime({ offset: true }),
});

export const sourcePageBatchSchema = z.object({
  pages: z.array(sourcePageReferenceSchema),
  nextCursor: z.string().min(1).nullable(),
});

export const sourceDocumentSchema = sourcePageReferenceSchema.extend({
  breadcrumb: z.array(z.string().trim().min(1).max(500)),
  metadata: z.record(z.string(), jsonValueSchema),
  contentMarkdown: z.string().min(1),
});

export type SourcePageReference = z.infer<typeof sourcePageReferenceSchema>;
export type SourcePageBatch = z.infer<typeof sourcePageBatchSchema>;
export type SourceDocument = z.infer<typeof sourceDocumentSchema>;

export interface DiscoverPagesInput {
  rootId: string;
  cursor?: string;
  pageSize: number;
}

export interface FetchPageInput {
  rootId: string;
  pageId: string;
}

export interface SourceAdapter {
  readonly sourceType: SourceType;
  discoverPages(input: DiscoverPagesInput): Promise<SourcePageBatch>;
  fetchPage(input: FetchPageInput): Promise<SourceDocument>;
}

export const sourceErrorCodes = [
  "invalid_configuration",
  "access_denied",
  "not_found",
  "rate_limited",
  "unavailable",
  "invalid_data",
] as const;

export type SourceErrorCode = (typeof sourceErrorCodes)[number];

export class SourceAdapterError extends Error {
  override readonly name = "SourceAdapterError";

  constructor(
    readonly code: SourceErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
