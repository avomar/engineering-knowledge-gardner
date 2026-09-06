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
export const draftPublishStateSchema = z.enum([
  "idle",
  "publishing",
  "uncertain",
  "failed",
  "published",
]);
export const gardenSignalTypeSchema = z.enum([
  "stale_document",
  "missing_metadata",
  "title_collision",
  "obsolete_keyword",
]);
export const gardenFindingStatusSchema = z.enum([
  "open",
  "dismissed",
  "resolved",
]);
export const gardenSeveritySchema = z.enum(["high", "medium", "low"]);
export const gardenScanStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
]);
export const gardenAiStatusSchema = z.enum([
  "not_requested",
  "completed",
  "degraded",
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
    sourceConfiguration: z.enum(["ok", "error", "not_applicable"]).optional(),
    semanticIndex: z.enum(["ok", "error", "not_applicable"]).optional(),
    draftPublishing: z.enum(["ok", "error", "not_applicable"]).optional(),
    accessValidation: z.enum(["ok", "error", "not_applicable"]).optional(),
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
  metadata: z.record(z.string(), jsonValueSchema).default({}),
  lastSyncErrorCode: z.string().trim().min(1).max(100).nullable().default(null),
  lastSyncErrorMessage: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .nullable()
    .default(null),
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
  deletedCount: z.number().int().nonnegative().default(0),
  embeddedChunkCount: z.number().int().nonnegative().default(0),
  errorSummary: z.string().max(2_000).nullable(),
  errorCode: z.string().trim().min(1).max(100).nullable().default(null),
  discoveryComplete: z.boolean().default(false),
  createdAt: isoDateTimeSchema,
});

export const syncDocumentOutcomeSchema = z.enum([
  "indexed",
  "skipped",
  "failed",
  "deleted",
]);

export const knowledgeFreshnessSchema = z.enum([
  "never_synced",
  "syncing",
  "fresh",
  "partially_stale",
  "failed",
]);

export const syncRunSummarySchema = syncRunSchema;

export const syncRunDocumentSchema = z.object({
  id: idSchema,
  syncRunId: idSchema,
  documentId: idSchema.nullable(),
  sourcePageId: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  sourceUrl: z.string().url().nullable(),
  outcome: syncDocumentOutcomeSchema,
  errorCode: z.string().trim().min(1).max(100).nullable(),
  errorMessage: z.string().trim().min(1).max(500).nullable(),
  createdAt: isoDateTimeSchema,
});

export const syncStartResponseSchema = z.object({
  run: syncRunSummarySchema,
  reused: z.boolean(),
});

export const syncOverviewResponseSchema = z.object({
  knowledgeSpace: z
    .object({
      id: idSchema,
      name: z.string().trim().min(1).max(200),
      freshness: knowledgeFreshnessSchema,
      lastSuccessfulSyncAt: nullableIsoDateTimeSchema,
    })
    .nullable(),
  runs: z.array(syncRunSummarySchema).max(20),
});

export const syncDetailResponseSchema = z.object({
  run: syncRunSummarySchema,
  documents: z.array(syncRunDocumentSchema),
});

export const documentSearchItemSchema = z.object({
  id: idSchema,
  sourcePageId: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  breadcrumb: z.array(z.string().trim().min(1).max(500)),
  sourceUrl: z.string().url().nullable(),
  excerpt: z.string().max(500).nullable(),
  lastEditedAt: isoDateTimeSchema,
  lastSyncedAt: nullableIsoDateTimeSchema,
  indexStatus: indexStatusSchema,
  errorMessage: z.string().trim().min(1).max(500).nullable(),
});

export const documentSearchResponseSchema = z.object({
  items: z.array(documentSearchItemSchema).max(50),
  nextCursor: z.string().regex(/^\d+$/u).nullable(),
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
  lastSyncedAt: nullableIsoDateTimeSchema.optional().default(null),
  sourceState: z
    .enum(["current", "stale", "removed"])
    .optional()
    .default("current"),
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
    feedback: z
      .object({
        rating: z.union([z.literal(-1), z.literal(1)]),
        correction: z.string().max(2_000).nullable(),
      })
      .nullable()
      .optional()
      .default(null),
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
  "knowledge_not_ready",
  "retrieval_unavailable",
  "mode_unavailable",
  "source_configuration_error",
  "notion_access_denied",
  "notion_rate_limited",
  "notion_unavailable",
  "workflow_unavailable",
  "sync_not_found",
  "invalid_cursor",
  "not_found",
  "draft_not_found",
  "draft_source_unavailable",
  "draft_conflict",
  "draft_not_publishable",
  "draft_publish_in_progress",
  "draft_publish_uncertain",
  "draft_generation_unavailable",
  "notion_write_unavailable",
  "authentication_required",
  "access_configuration_error",
  "garden_scan_in_progress",
  "garden_conflict",
  "garden_unavailable",
  "feedback_target_not_found",
  "maintenance_conflict",
]);

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string().trim().min(1).max(500),
    retryable: z.boolean(),
  }),
});

export const draftSourceSchema = z.object({
  chunkId: idSchema,
  documentId: idSchema,
  sourcePageId: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  breadcrumb: z.array(z.string().trim().min(1).max(500)),
  sourceUrl: z.string().url(),
  quote: z.string().trim().min(1).max(1_000),
  sourceState: z.enum(["current", "stale"]),
  lastSyncedAt: nullableIsoDateTimeSchema,
  checksum: z.string().trim().min(1).max(128),
});

export const draftSchema = z.object({
  id: idSchema,
  knowledgeSpaceId: idSchema,
  ownerSessionId: z.string().trim().min(1).max(500),
  sourceMessageId: idSchema,
  generationInstruction: z.string().max(1_000).nullable(),
  title: z.string().trim().min(1).max(200),
  contentMarkdown: z.string().max(20_000),
  sources: z.array(draftSourceSchema).min(1).max(6),
  assumptions: z.array(z.string().trim().min(1).max(1_000)).max(10),
  targetParentId: z.string().trim().min(1).max(500),
  status: draftStatusSchema,
  version: z.number().int().positive(),
  wasEdited: z.boolean(),
  publishState: draftPublishStateSchema,
  publishAttemptCount: z.number().int().nonnegative(),
  publishStartedAt: nullableIsoDateTimeSchema,
  publishLeaseExpiresAt: nullableIsoDateTimeSchema,
  lastErrorCode: z.string().trim().min(1).max(100).nullable(),
  lastErrorMessage: z.string().trim().min(1).max(500).nullable(),
  idempotencyKey: z.string().trim().min(1).max(500),
  notionPageId: z.string().trim().min(1).max(500).nullable(),
  notionUrl: z.string().url().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  publishedAt: nullableIsoDateTimeSchema,
});

export const feedbackSummarySchema = z.object({
  rating: z.union([z.literal(-1), z.literal(1)]),
  correction: z.string().max(2_000).nullable(),
});

export const publicDraftSchema = draftSchema
  .omit({
    idempotencyKey: true,
    publishStartedAt: true,
    publishLeaseExpiresAt: true,
    lastErrorCode: true,
    lastErrorMessage: true,
  })
  .extend({ feedback: feedbackSummarySchema.nullable().default(null) });

export const createDraftRequestSchema = z.object({
  sourceMessageId: idSchema,
  instruction: z.string().trim().min(1).max(1_000).optional(),
});
export const updateDraftRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  contentMarkdown: z.string().max(20_000),
  assumptions: z.array(z.string().trim().min(1).max(1_000)).max(10),
  version: z.number().int().positive(),
});
export const versionedDraftRequestSchema = z.object({
  version: z.number().int().positive(),
});
export const publishDraftRequestSchema = versionedDraftRequestSchema.extend({
  confirmed: z.literal(true),
});
export const draftListResponseSchema = z.object({
  items: z.array(publicDraftSchema).max(50),
  nextCursor: z.string().regex(/^\d+$/u).nullable(),
});
export const publishDraftResponseSchema = z.object({
  draft: publicDraftSchema,
  reused: z.boolean(),
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
    ownerSessionId: z.string().trim().min(1).max(500).nullable().default(null),
    createdAt: isoDateTimeSchema,
    updatedAt: nullableIsoDateTimeSchema.default(null),
  })
  .refine(
    ({ messageId, draftId }) => (messageId === null) !== (draftId === null),
    { message: "Feedback must target exactly one message or draft." },
  );

export const feedbackRequestSchema = z
  .object({
    messageId: idSchema.optional(),
    draftId: idSchema.optional(),
    rating: z.union([z.literal(-1), z.literal(1)]),
    correction: z.string().trim().min(1).max(2_000).optional(),
  })
  .refine(
    ({ messageId, draftId }) =>
      (messageId === undefined) !== (draftId === undefined),
    { message: "Feedback must target exactly one resource." },
  );

export const feedbackResponseSchema = z.object({
  feedback: feedbackSummarySchema,
});

export const gardenPolicySchema = z.object({
  staleAfterDays: z.number().int().min(1).max(3_650),
  requiredMetadataKeys: z.array(z.string().trim().min(1).max(100)).max(10),
  obsoleteTerms: z
    .array(
      z.object({
        term: z.string().trim().min(2).max(100),
        replacement: z.string().trim().min(1).max(200).optional(),
      }),
    )
    .max(10),
});

export const gardenEvidenceSchema = z.object({
  documentId: idSchema,
  sourcePageId: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  sourceUrl: z.string().url().nullable(),
  lastEditedAt: isoDateTimeSchema,
  detail: z.string().trim().min(1).max(500),
});

export const gardenScanSchema = z.object({
  id: idSchema,
  status: gardenScanStatusSchema,
  aiStatus: gardenAiStatusSchema,
  findingCount: z.number().int().nonnegative(),
  aiEnrichedCount: z.number().int().nonnegative(),
  errorCode: z.string().trim().min(1).max(100).nullable(),
  startedAt: isoDateTimeSchema,
  completedAt: nullableIsoDateTimeSchema,
});

export const gardenFindingSchema = z.object({
  id: idSchema,
  fingerprint: z.string().length(64),
  signalType: gardenSignalTypeSchema,
  severity: gardenSeveritySchema,
  status: gardenFindingStatusSchema,
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(200),
  reason: z.string().trim().min(1).max(1_000),
  recommendation: z.string().trim().min(1).max(1_000),
  evidence: z.array(gardenEvidenceSchema).min(1).max(50),
  aiEnriched: z.boolean(),
  firstDetectedAt: isoDateTimeSchema,
  lastDetectedAt: isoDateTimeSchema,
  dismissedAt: nullableIsoDateTimeSchema,
  resolvedAt: nullableIsoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const gardenOverviewSchema = z.object({
  policy: gardenPolicySchema,
  latestScan: gardenScanSchema.nullable(),
  counts: z.object({
    open: z.number().int().nonnegative(),
    dismissed: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
  }),
  items: z.array(gardenFindingSchema).max(50),
  nextCursor: z.string().regex(/^\d+$/u).nullable(),
});

export const gardenScanResponseSchema = z.object({
  scan: gardenScanSchema,
  reused: z.boolean(),
});

export const updateGardenFindingRequestSchema = z.object({
  status: z.enum(["open", "dismissed"]),
  version: z.number().int().positive(),
});

export const conversationClearRequestSchema = z.object({
  confirmed: z.literal(true),
});
export const conversationClearResponseSchema = z.object({
  deletedConversations: z.number().int().nonnegative(),
});
export const indexResetRequestSchema = z.object({
  confirmation: z.literal("RESET INDEX"),
});
export const indexResetResponseSchema = z.object({
  deletedDocuments: z.number().int().nonnegative(),
  queuedVectors: z.number().int().nonnegative(),
  pendingVectorCleanup: z.boolean(),
});

export type AppMode = z.infer<typeof appModeSchema>;
export type SourceType = z.infer<typeof sourceTypeSchema>;
export type IndexStatus = z.infer<typeof indexStatusSchema>;
export type SyncStatus = z.infer<typeof syncStatusSchema>;
export type SyncDocumentOutcome = z.infer<typeof syncDocumentOutcomeSchema>;
export type KnowledgeFreshness = z.infer<typeof knowledgeFreshnessSchema>;
export type MessageRole = z.infer<typeof messageRoleSchema>;
export type Confidence = z.infer<typeof confidenceSchema>;
export type DraftStatus = z.infer<typeof draftStatusSchema>;
export type DraftPublishState = z.infer<typeof draftPublishStateSchema>;
export type GardenSignalType = z.infer<typeof gardenSignalTypeSchema>;
export type GardenFindingStatus = z.infer<typeof gardenFindingStatusSchema>;
export type GardenSeverity = z.infer<typeof gardenSeveritySchema>;
export type HealthResponse = z.infer<typeof healthResponseSchema>;
export type KnowledgeSpace = z.infer<typeof knowledgeSpaceSchema>;
export type Document = z.infer<typeof documentSchema>;
export type DocumentChunk = z.infer<typeof documentChunkSchema>;
export type SyncRun = z.infer<typeof syncRunSchema>;
export type SyncRunDocument = z.infer<typeof syncRunDocumentSchema>;
export type SyncStartResponse = z.infer<typeof syncStartResponseSchema>;
export type SyncOverviewResponse = z.infer<typeof syncOverviewResponseSchema>;
export type SyncDetailResponse = z.infer<typeof syncDetailResponseSchema>;
export type DocumentSearchItem = z.infer<typeof documentSearchItemSchema>;
export type DocumentSearchResponse = z.infer<
  typeof documentSearchResponseSchema
>;
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
export type PublicDraft = z.infer<typeof publicDraftSchema>;
export type DraftSource = z.infer<typeof draftSourceSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
export type Feedback = z.infer<typeof feedbackSchema>;
export type FeedbackSummary = z.infer<typeof feedbackSummarySchema>;
export type GardenPolicy = z.infer<typeof gardenPolicySchema>;
export type GardenScan = z.infer<typeof gardenScanSchema>;
export type GardenFinding = z.infer<typeof gardenFindingSchema>;
export type GardenOverview = z.infer<typeof gardenOverviewSchema>;
