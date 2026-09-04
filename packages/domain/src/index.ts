import { z } from "zod";

export const appModeSchema = z.enum(["demo", "live"]);
export const sourceTypeSchema = z.enum(["fixture", "notion"]);
export const indexStatusSchema = z.enum([
  "pending",
  "indexed",
  "failed",
  "stale",
]);
export const syncStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "partial",
  "failed",
]);
export const messageRoleSchema = z.enum(["user", "assistant"]);
export const draftStatusSchema = z.enum([
  "pending",
  "published",
  "discarded",
  "failed",
]);

export const idSchema = z.string().uuid();
export const isoDateTimeSchema = z.string().datetime({ offset: true });
export const nullableIsoDateTimeSchema = isoDateTimeSchema.nullable();

export const jsonValueSchema: z.ZodType<
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const healthResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  mode: appModeSchema,
  checks: z.object({
    database: z.enum(["ok", "error"]),
  }),
});

export const knowledgeSpaceSchema = z.object({
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  sourceType: sourceTypeSchema,
  sourceRootId: z.string().trim().min(1).max(500),
  mode: appModeSchema,
  lastSuccessfulSyncAt: nullableIsoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const documentSchema = z.object({
  id: idSchema,
  knowledgeSpaceId: idSchema,
  sourcePageId: z.string().trim().min(1).max(500),
  sourceUrl: z.string().url().nullable(),
  parentSourcePageId: z.string().trim().min(1).max(500).nullable(),
  title: z.string().trim().min(1).max(500),
  breadcrumb: z.array(z.string().trim().min(1).max(500)),
  lastEditedAt: isoDateTimeSchema,
  checksum: z.string().trim().min(1).max(128),
  indexStatus: indexStatusSchema,
  lastSyncedAt: nullableIsoDateTimeSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const documentChunkSchema = z.object({
  id: idSchema,
  documentId: idSchema,
  ordinal: z.number().int().nonnegative(),
  content: z.string().min(1),
  tokenCount: z.number().int().nonnegative(),
  checksum: z.string().trim().min(1).max(128),
  createdAt: isoDateTimeSchema,
});

export const syncRunSchema = z.object({
  id: idSchema,
  knowledgeSpaceId: idSchema,
  workflowInstanceId: z.string().trim().min(1).max(500).nullable(),
  status: syncStatusSchema,
  startedAt: nullableIsoDateTimeSchema,
  completedAt: nullableIsoDateTimeSchema,
  discoveredCount: z.number().int().nonnegative(),
  indexedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  errorSummary: z.string().max(2_000).nullable(),
  createdAt: isoDateTimeSchema,
});

export const conversationSchema = z.object({
  id: idSchema,
  knowledgeSpaceId: idSchema,
  ownerSessionId: z.string().trim().min(1).max(500),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const citationSchema = z.object({
  chunkId: idSchema,
  quote: z.string().trim().min(1).max(1_000),
});

export const messageSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  role: messageRoleSchema,
  content: z.string().min(1),
  citations: z.array(citationSchema),
  createdAt: isoDateTimeSchema,
});

export const draftSchema = z.object({
  id: idSchema,
  knowledgeSpaceId: idSchema,
  title: z.string().trim().min(1).max(500),
  contentMarkdown: z.string().max(20_000),
  sources: z.array(idSchema),
  assumptions: z.array(z.string().trim().min(1).max(1_000)),
  targetParentId: z.string().trim().min(1).max(500).nullable(),
  status: draftStatusSchema,
  idempotencyKey: z.string().trim().min(1).max(500).nullable(),
  notionPageId: z.string().trim().min(1).max(500).nullable(),
  notionUrl: z.string().url().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  publishedAt: nullableIsoDateTimeSchema,
});

export const auditEventSchema = z.object({
  id: idSchema,
  knowledgeSpaceId: idSchema,
  action: z.string().trim().min(1).max(100),
  resourceType: z.string().trim().min(1).max(100),
  resourceId: z.string().trim().min(1).max(500),
  outcome: z.string().trim().min(1).max(100),
  metadata: z.record(z.string(), jsonValueSchema),
  createdAt: isoDateTimeSchema,
});

export const feedbackSchema = z
  .object({
    id: idSchema,
    messageId: idSchema.nullable(),
    draftId: idSchema.nullable(),
    rating: z.union([z.literal(-1), z.literal(1)]),
    correction: z.string().max(5_000).nullable(),
    createdAt: isoDateTimeSchema,
  })
  .refine(
    ({ messageId, draftId }) => (messageId === null) !== (draftId === null),
    { message: "Feedback must target exactly one message or draft." },
  );

export type AppMode = z.infer<typeof appModeSchema>;
export type SourceType = z.infer<typeof sourceTypeSchema>;
export type IndexStatus = z.infer<typeof indexStatusSchema>;
export type SyncStatus = z.infer<typeof syncStatusSchema>;
export type MessageRole = z.infer<typeof messageRoleSchema>;
export type DraftStatus = z.infer<typeof draftStatusSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type KnowledgeSpace = z.infer<typeof knowledgeSpaceSchema>;
export type Document = z.infer<typeof documentSchema>;
export type DocumentChunk = z.infer<typeof documentChunkSchema>;
export type SyncRun = z.infer<typeof syncRunSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type Feedback = z.infer<typeof feedbackSchema>;
