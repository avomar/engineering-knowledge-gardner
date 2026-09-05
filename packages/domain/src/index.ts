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
export const confidenceSchema = z.enum(["high", "medium", "low"]);
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

const messageBaseSchema = z.object({
  id: idSchema,
  conversationId: idSchema,
  content: z.string().min(1),
  createdAt: isoDateTimeSchema,
});

export const messageSchema = z.discriminatedUnion("role", [
  messageBaseSchema.extend({
    role: z.literal("user"),
    citations: z.array(citationSchema).max(0),
    confidence: z.null(),
    unansweredQuestions: z.array(z.string()).max(0),
  }),
  messageBaseSchema.extend({
    role: z.literal("assistant"),
    citations: z.array(citationSchema).max(6),
    confidence: confidenceSchema,
    unansweredQuestions: z.array(z.string().trim().min(1).max(500)).max(6),
  }),
]);

export const groundedAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(4_000),
  confidence: confidenceSchema,
  citations: z.array(citationSchema).max(6),
  unansweredQuestions: z.array(z.string().trim().min(1).max(500)).max(6),
});

export const sourceCardSchema = z.object({
  documentId: idSchema,
  sourcePageId: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  breadcrumb: z.array(z.string().trim().min(1).max(500)),
  sourceUrl: z.string().url().nullable(),
  lastEditedAt: isoDateTimeSchema,
});

export const chatCitationSchema = citationSchema.extend({
  source: sourceCardSchema,
});

export const chatMessageSchema = z.discriminatedUnion("role", [
  messageBaseSchema.extend({
    role: z.literal("user"),
    citations: z.array(chatCitationSchema).max(0),
    confidence: z.null(),
    unansweredQuestions: z.array(z.string()).max(0),
  }),
  messageBaseSchema.extend({
    role: z.literal("assistant"),
    citations: z.array(chatCitationSchema).max(6),
    confidence: confidenceSchema,
    unansweredQuestions: z.array(z.string().trim().min(1).max(500)).max(6),
  }),
]);

export const chatRequestSchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  conversationId: idSchema.optional(),
});

export const chatResponseSchema = z.object({
  conversationId: idSchema,
  userMessage: chatMessageSchema,
  assistantMessage: chatMessageSchema,
});

export const conversationMessagesResponseSchema = z.object({
  conversationId: idSchema,
  messages: z.array(chatMessageSchema),
});

export const apiErrorCodeSchema = z.enum([
  "validation_error",
  "conversation_not_found",
  "rate_limited",
  "invalid_ai_response",
  "ai_unavailable",
  "database_unavailable",
  "mode_unavailable",
  "not_found",
]);

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
  }),
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
export type Confidence = z.infer<typeof confidenceSchema>;
export type DraftStatus = z.infer<typeof draftStatusSchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type KnowledgeSpace = z.infer<typeof knowledgeSpaceSchema>;
export type Document = z.infer<typeof documentSchema>;
export type DocumentChunk = z.infer<typeof documentChunkSchema>;
export type SyncRun = z.infer<typeof syncRunSchema>;
export type Conversation = z.infer<typeof conversationSchema>;
export type Message = z.infer<typeof messageSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type GroundedAnswer = z.infer<typeof groundedAnswerSchema>;
export type SourceCard = z.infer<typeof sourceCardSchema>;
export type ChatCitation = z.infer<typeof chatCitationSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatResponse = z.infer<typeof chatResponseSchema>;
export type ConversationMessagesResponse = z.infer<
  typeof conversationMessagesResponseSchema
>;
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type Feedback = z.infer<typeof feedbackSchema>;
