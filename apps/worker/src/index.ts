import {
  apiErrorResponseSchema,
  chatRequestSchema,
  conversationClearRequestSchema,
  conversationClearResponseSchema,
  conversationMessagesResponseSchema,
  createDraftRequestSchema,
  documentSearchResponseSchema,
  draftListResponseSchema,
  feedbackRequestSchema,
  feedbackResponseSchema,
  gardenFindingSchema,
  gardenFindingStatusSchema,
  gardenOverviewSchema,
  gardenScanResponseSchema,
  gardenSignalTypeSchema,
  healthResponseSchema,
  idSchema,
  indexResetRequestSchema,
  indexResetResponseSchema,
  indexStatusSchema,
  publicDraftSchema,
  publishDraftRequestSchema,
  publishDraftResponseSchema,
  syncDetailResponseSchema,
  syncOverviewResponseSchema,
  syncStartResponseSchema,
  updateGardenFindingRequestSchema,
  updateDraftRequestSchema,
  versionedDraftRequestSchema,
  type ApiErrorCode,
  type HealthResponse,
} from "@knowledge-gardener/domain";
import { Hono, type Context } from "hono";

import {
  AccessConfigurationError,
  accessConfigured,
  CloudflareAccessVerifier,
  type AccessVerifier,
} from "./access";
import {
  WorkersAiAnswerGenerator,
  type AnswerGenerator,
} from "./answer-generator";
import { ChatService, ChatServiceError, parseSessionId } from "./chat-service";
import { DemoCorpusService } from "./demo-corpus";
import { DraftService, DraftServiceError } from "./draft-service";
import type { DraftGenerator } from "./draft-generator";
import type { Env } from "./env";
import {
  FeedbackMaintenanceError,
  FeedbackService,
  MaintenanceService,
} from "./feedback-maintenance";
import {
  GardenService,
  GardenServiceError,
  type GardenRecommendationGenerator,
} from "./garden";
import { optionalRoot, SyncService, SyncServiceError } from "./sync-service";
import { SyncRepository } from "./sync-repository";

interface AppOptions {
  createAnswerGenerator?: (environment: Env) => AnswerGenerator;
  createDraftGenerator?: (environment: Env) => DraftGenerator;
  createGardenGenerator?: (environment: Env) => GardenRecommendationGenerator;
  accessVerifier?: AccessVerifier;
  now?: () => string;
  createId?: () => string;
  log?: (record: Record<string, unknown>) => void;
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const api = new Hono<{
    Bindings: Env;
    Variables: { accessSubject: string | null };
  }>();

  api.use("*", async (context, next) => {
    context.set("accessSubject", null);
    if (context.env.APP_MODE !== "live" || context.req.path === "/api/health") {
      await next();
      return;
    }
    if (!accessConfigured(context.env)) {
      return errorResponse(
        context,
        "access_configuration_error",
        "Live API authentication is not configured.",
        false,
        503,
      );
    }
    const token = context.req.header("Cf-Access-Jwt-Assertion");
    if (!token) {
      return errorResponse(
        context,
        "authentication_required",
        "Cloudflare Access authentication is required.",
        false,
        401,
      );
    }
    try {
      const verifier = options.accessVerifier ?? new CloudflareAccessVerifier();
      context.set("accessSubject", await verifier.verify(token, context.env));
      await next();
    } catch (error) {
      const configuration = error instanceof AccessConfigurationError;
      return errorResponse(
        context,
        configuration
          ? "access_configuration_error"
          : "authentication_required",
        configuration
          ? "Live API authentication is not configured."
          : "Cloudflare Access authentication is invalid.",
        false,
        configuration ? 503 : 401,
      );
    }
  });

  api.get("/health", async (context) => {
    try {
      const result =
        await context.env.DB.prepare("SELECT 1 AS ok").first<number>("ok");
      if (result !== 1) throw new Error("Database readiness query failed.");

      const accessReady =
        context.env.APP_MODE !== "live" || accessConfigured(context.env);
      const response: HealthResponse = {
        status: accessReady ? "ok" : "degraded",
        mode: context.env.APP_MODE,
        checks: {
          database: "ok",
          sourceConfiguration:
            context.env.APP_MODE === "live"
              ? optionalRoot(context.env) === null
                ? "error"
                : "ok"
              : "not_applicable",
          ...(context.env.APP_MODE === "live"
            ? {
                semanticIndex:
                  context.env.KNOWLEDGE_INDEX === undefined ? "error" : "ok",
                draftPublishing:
                  context.env.NOTION_TOKEN === undefined ||
                  context.env.NOTION_DRAFTS_PARENT_ID === undefined
                    ? "error"
                    : "ok",
                accessValidation: accessReady ? "ok" : "error",
              }
            : {}),
        },
      };
      return context.json(
        healthResponseSchema.parse(response),
        accessReady ? 200 : 503,
      );
    } catch {
      const response: HealthResponse = {
        status: "degraded",
        mode: context.env.APP_MODE,
        checks: {
          database: "error",
          sourceConfiguration:
            context.env.APP_MODE === "live" ? "error" : "not_applicable",
          ...(context.env.APP_MODE === "live"
            ? { semanticIndex: "error" }
            : {}),
          ...(context.env.APP_MODE === "live"
            ? { draftPublishing: "error", accessValidation: "error" }
            : {}),
        },
      };
      return context.json(healthResponseSchema.parse(response), 503);
    }
  });

  api.post("/chat", async (context) => {
    const sessionId = parseSessionId(
      context.req.header("X-Client-Session-Id") ??
        (context.env.APP_MODE === "demo"
          ? context.req.header("X-Demo-Session-Id")
          : undefined),
    );
    if (sessionId === null) {
      return validationError(context, "A valid client session ID is required.");
    }
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return validationError(context, "The request body must be valid JSON.");
    }
    const request = chatRequestSchema.safeParse(input);
    if (!request.success) {
      return validationError(
        context,
        "Question and conversation fields are invalid.",
      );
    }

    try {
      const service = createChatService(context.env, options);
      return context.json(
        await service.answer(
          sessionId,
          request.data,
          aiRateKey(context, sessionId),
        ),
        200,
      );
    } catch (error) {
      return handleChatError(context, error);
    }
  });

  api.get("/conversations/:conversationId/messages", async (context) => {
    const sessionId = parseSessionId(
      context.req.header("X-Client-Session-Id") ??
        (context.env.APP_MODE === "demo"
          ? context.req.header("X-Demo-Session-Id")
          : undefined),
    );
    const conversationId = idSchema.safeParse(
      context.req.param("conversationId"),
    );
    if (sessionId === null || !conversationId.success) {
      return validationError(
        context,
        "Valid session and conversation IDs are required.",
      );
    }

    try {
      const service = createChatService(context.env, options);
      const result = await service.history(sessionId, conversationId.data);
      return context.json(
        conversationMessagesResponseSchema.parse(result),
        200,
      );
    } catch (error) {
      return handleChatError(context, error);
    }
  });

  api.post("/sync", async (context) => {
    if (context.env.APP_MODE !== "live") {
      return errorResponse(
        context,
        "mode_unavailable",
        "Synchronization is available only in live mode.",
        false,
        503,
      );
    }
    try {
      return context.json(
        syncStartResponseSchema.parse(
          await new SyncService(context.env).start(),
        ),
        202,
      );
    } catch (error) {
      return handleSyncError(context, error);
    }
  });

  api.get("/sync", async (context) => {
    if (context.env.APP_MODE !== "live") {
      return errorResponse(
        context,
        "mode_unavailable",
        "Synchronization is available only in live mode.",
        false,
        503,
      );
    }
    const limitText = context.req.query("limit") ?? "10";
    if (
      !/^\d+$/u.test(limitText) ||
      Number(limitText) < 1 ||
      Number(limitText) > 20
    ) {
      return validationError(
        context,
        "Synchronization history limit is invalid.",
      );
    }
    try {
      return context.json(
        syncOverviewResponseSchema.parse(
          await new SyncService(context.env).overview(Number(limitText)),
        ),
        200,
      );
    } catch (error) {
      return handleSyncError(context, error);
    }
  });

  api.get("/sync/:runId", async (context) => {
    if (context.env.APP_MODE !== "live") {
      return errorResponse(
        context,
        "mode_unavailable",
        "Synchronization is available only in live mode.",
        false,
        503,
      );
    }
    const runId = idSchema.safeParse(context.req.param("runId"));
    if (!runId.success)
      return validationError(
        context,
        "A valid synchronization run ID is required.",
      );
    try {
      return context.json(
        syncDetailResponseSchema.parse(
          await new SyncService(context.env).detail(runId.data),
        ),
        200,
      );
    } catch (error) {
      return handleSyncError(context, error);
    }
  });

  api.get("/documents/search", async (context) => {
    const query = (context.req.query("q") ?? "").trim();
    const cursor = context.req.query("cursor") ?? "0";
    const limitText = context.req.query("limit") ?? "20";
    const statusText = context.req.query("status");
    const status =
      statusText === undefined
        ? undefined
        : indexStatusSchema.safeParse(statusText);
    if (
      query.length > 100 ||
      !/^\d+$/u.test(cursor) ||
      !/^\d+$/u.test(limitText) ||
      Number(limitText) < 1 ||
      Number(limitText) > 50 ||
      (status !== undefined && !status.success)
    ) {
      return errorResponse(
        context,
        /^\d+$/u.test(cursor) ? "validation_error" : "invalid_cursor",
        "Document search parameters are invalid.",
        false,
        400,
      );
    }
    try {
      let spaceId: string | null;
      if (context.env.APP_MODE === "demo") {
        spaceId = await new DemoCorpusService(context.env.DB).ensureReady();
      } else {
        const root = optionalRoot(context.env);
        spaceId =
          root === null
            ? null
            : await new SyncRepository(context.env.DB).findSpaceId(
                "live",
                root,
              );
      }
      const result =
        spaceId === null
          ? { items: [], nextCursor: null }
          : await new SyncRepository(context.env.DB).searchDocuments({
              spaceId,
              query,
              ...(status?.success === true ? { status: status.data } : {}),
              offset: Number(cursor),
              limit: Number(limitText),
            });
      return context.json(documentSearchResponseSchema.parse(result), 200);
    } catch {
      return errorResponse(
        context,
        "database_unavailable",
        "Sources are temporarily unavailable.",
        true,
        503,
      );
    }
  });

  api.post("/drafts", async (context) => {
    const sessionId = liveSession(context);
    if (sessionId === null)
      return validationError(context, "A valid client session ID is required.");
    if (context.env.APP_MODE !== "live") return modeUnavailable(context);
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return validationError(context, "The request body must be valid JSON.");
    }
    if (!createDraftRequestSchema.safeParse(input).success)
      return validationError(
        context,
        "Draft source and instruction are invalid.",
      );
    try {
      return context.json(
        publicDraftSchema.parse(
          await new FeedbackService(context.env).forDraft(
            sessionId,
            await createDraftService(context.env, options).generate(
              sessionId,
              input,
            ),
          ),
        ),
        201,
      );
    } catch (error) {
      return handleDraftError(context, error);
    }
  });

  api.get("/drafts", async (context) => {
    const sessionId = liveSession(context);
    if (sessionId === null)
      return validationError(context, "A valid client session ID is required.");
    if (context.env.APP_MODE !== "live") return modeUnavailable(context);
    const cursor = context.req.query("cursor") ?? "0";
    const limit = context.req.query("limit") ?? "20";
    const status = context.req.query("status");
    if (
      !/^\d+$/u.test(cursor) ||
      !/^\d+$/u.test(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 50 ||
      (status !== undefined &&
        !["pending", "published", "discarded", "failed"].includes(status))
    )
      return validationError(context, "Draft listing parameters are invalid.");
    try {
      const drafts = await createDraftService(context.env, options).list(
        sessionId,
        Number(cursor),
        Number(limit),
        status,
      );
      return context.json(
        draftListResponseSchema.parse({
          ...drafts,
          items: await new FeedbackService(context.env).forDrafts(
            sessionId,
            drafts.items,
          ),
        }),
        200,
      );
    } catch (error) {
      return handleDraftError(context, error);
    }
  });

  api.get("/drafts/:draftId", async (context) => {
    const sessionId = liveSession(context);
    const id = idSchema.safeParse(context.req.param("draftId"));
    if (sessionId === null || !id.success)
      return validationError(
        context,
        "Valid session and draft IDs are required.",
      );
    if (context.env.APP_MODE !== "live") return modeUnavailable(context);
    try {
      return context.json(
        publicDraftSchema.parse(
          await new FeedbackService(context.env).forDraft(
            sessionId,
            await createDraftService(context.env, options).get(
              sessionId,
              id.data,
            ),
          ),
        ),
        200,
      );
    } catch (error) {
      return handleDraftError(context, error);
    }
  });

  api.patch("/drafts/:draftId", async (context) => {
    const sessionId = liveSession(context);
    const id = idSchema.safeParse(context.req.param("draftId"));
    if (sessionId === null || !id.success)
      return validationError(
        context,
        "Valid session and draft IDs are required.",
      );
    if (context.env.APP_MODE !== "live") return modeUnavailable(context);
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return validationError(context, "The request body must be valid JSON.");
    }
    const parsed = updateDraftRequestSchema.safeParse(input);
    if (!parsed.success)
      return validationError(context, "Draft edits are invalid.");
    try {
      return context.json(
        publicDraftSchema.parse(
          await new FeedbackService(context.env).forDraft(
            sessionId,
            await createDraftService(context.env, options).edit(
              sessionId,
              id.data,
              parsed.data,
            ),
          ),
        ),
        200,
      );
    } catch (error) {
      return handleDraftError(context, error);
    }
  });

  api.post("/drafts/:draftId/discard", async (context) => {
    const sessionId = liveSession(context);
    const id = idSchema.safeParse(context.req.param("draftId"));
    if (sessionId === null || !id.success)
      return validationError(
        context,
        "Valid session and draft IDs are required.",
      );
    if (context.env.APP_MODE !== "live") return modeUnavailable(context);
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return validationError(context, "The request body must be valid JSON.");
    }
    const parsed = versionedDraftRequestSchema.safeParse(input);
    if (!parsed.success)
      return validationError(context, "A draft version is required.");
    try {
      return context.json(
        publicDraftSchema.parse(
          await new FeedbackService(context.env).forDraft(
            sessionId,
            await createDraftService(context.env, options).discard(
              sessionId,
              id.data,
              parsed.data.version,
            ),
          ),
        ),
        200,
      );
    } catch (error) {
      return handleDraftError(context, error);
    }
  });

  api.post("/drafts/:draftId/publish", async (context) => {
    const sessionId = liveSession(context);
    const id = idSchema.safeParse(context.req.param("draftId"));
    if (sessionId === null || !id.success)
      return validationError(
        context,
        "Valid session and draft IDs are required.",
      );
    if (context.env.APP_MODE !== "live") return modeUnavailable(context);
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return validationError(context, "The request body must be valid JSON.");
    }
    const parsed = publishDraftRequestSchema.safeParse(input);
    if (!parsed.success)
      return validationError(
        context,
        "Explicit publish confirmation and a draft version are required.",
      );
    try {
      const result = await createDraftService(context.env, options).publish(
        sessionId,
        id.data,
        parsed.data.version,
      );
      return context.json(
        publishDraftResponseSchema.parse({
          ...result,
          draft: await new FeedbackService(context.env).forDraft(
            sessionId,
            result.draft,
          ),
        }),
        200,
      );
    } catch (error) {
      return handleDraftError(context, error);
    }
  });

  api.get("/garden", async (context) => {
    const sessionId = clientSession(context);
    if (sessionId === null)
      return validationError(context, "A valid client session ID is required.");
    const cursor = context.req.query("cursor") ?? "0";
    const limit = context.req.query("limit") ?? "20";
    const status = context.req.query("status");
    const signalType = context.req.query("type");
    if (
      !/^\d+$/u.test(cursor) ||
      !/^\d+$/u.test(limit) ||
      Number(limit) < 1 ||
      Number(limit) > 50 ||
      (status !== undefined &&
        !gardenFindingStatusSchema.safeParse(status).success) ||
      (signalType !== undefined &&
        !gardenSignalTypeSchema.safeParse(signalType).success)
    ) {
      return validationError(context, "Garden listing parameters are invalid.");
    }
    try {
      return context.json(
        gardenOverviewSchema.parse(
          await createGardenService(context.env, options).overview(
            ownerScope(context, sessionId),
            {
              offset: Number(cursor),
              limit: Number(limit),
              ...(status === undefined ? {} : { status }),
              ...(signalType === undefined ? {} : { signalType }),
            },
          ),
        ),
        200,
      );
    } catch (error) {
      return handleGardenError(context, error);
    }
  });

  api.post("/garden/scans", async (context) => {
    const sessionId = clientSession(context);
    if (sessionId === null)
      return validationError(context, "A valid client session ID is required.");
    try {
      return context.json(
        gardenScanResponseSchema.parse(
          await createGardenService(context.env, options).scan(
            ownerScope(context, sessionId),
            aiRateKey(context, sessionId),
          ),
        ),
        200,
      );
    } catch (error) {
      return handleGardenError(context, error);
    }
  });

  api.patch("/garden/findings/:findingId", async (context) => {
    const sessionId = clientSession(context);
    const findingId = idSchema.safeParse(context.req.param("findingId"));
    if (sessionId === null || !findingId.success)
      return validationError(
        context,
        "Valid session and finding IDs are required.",
      );
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return validationError(context, "The request body must be valid JSON.");
    }
    const parsed = updateGardenFindingRequestSchema.safeParse(input);
    if (!parsed.success)
      return validationError(
        context,
        "Finding status and version are invalid.",
      );
    try {
      return context.json(
        gardenFindingSchema.parse(
          await createGardenService(context.env, options).update(
            ownerScope(context, sessionId),
            findingId.data,
            parsed.data.status,
            parsed.data.version,
          ),
        ),
        200,
      );
    } catch (error) {
      return handleGardenError(context, error);
    }
  });

  api.post("/feedback", async (context) => {
    const sessionId = clientSession(context);
    if (sessionId === null)
      return validationError(context, "A valid client session ID is required.");
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return validationError(context, "The request body must be valid JSON.");
    }
    if (!feedbackRequestSchema.safeParse(input).success)
      return validationError(context, "Feedback is invalid.");
    try {
      return context.json(
        feedbackResponseSchema.parse(
          await new FeedbackService(context.env).save(sessionId, input),
        ),
        200,
      );
    } catch (error) {
      return handleFeedbackMaintenanceError(context, error);
    }
  });

  api.delete("/conversations", async (context) => {
    const sessionId = clientSession(context);
    if (sessionId === null)
      return validationError(context, "A valid client session ID is required.");
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return validationError(context, "The request body must be valid JSON.");
    }
    if (!conversationClearRequestSchema.safeParse(input).success)
      return validationError(context, "Explicit confirmation is required.");
    try {
      return context.json(
        conversationClearResponseSchema.parse(
          await new MaintenanceService(context.env).clearConversations(
            sessionId,
          ),
        ),
        200,
      );
    } catch (error) {
      return handleFeedbackMaintenanceError(context, error);
    }
  });

  api.post("/maintenance/index-reset", async (context) => {
    const sessionId = clientSession(context);
    if (sessionId === null)
      return validationError(context, "A valid client session ID is required.");
    if (context.env.APP_MODE !== "live") return modeUnavailable(context);
    let input: unknown;
    try {
      input = await context.req.json();
    } catch {
      return validationError(context, "The request body must be valid JSON.");
    }
    if (!indexResetRequestSchema.safeParse(input).success)
      return validationError(context, "Type RESET INDEX to confirm.");
    try {
      return context.json(
        indexResetResponseSchema.parse(
          await new MaintenanceService(context.env).resetIndex(),
        ),
        200,
      );
    } catch (error) {
      return handleFeedbackMaintenanceError(context, error);
    }
  });

  app.route("/api", api);
  app.notFound((context) =>
    errorResponse(context, "not_found", "Not found.", false, 404),
  );

  return app;
}

function createChatService(environment: Env, options: AppOptions): ChatService {
  const log =
    options.log ??
    ((record: Record<string, unknown>) => console.log(JSON.stringify(record)));
  return new ChatService({
    database: environment.DB,
    ai: environment.AI,
    answerGenerator:
      options.createAnswerGenerator?.(environment) ??
      new WorkersAiAnswerGenerator(environment.AI, log),
    rateLimiter: environment.CHAT_RATE_LIMITER,
    mode: environment.APP_MODE,
    ...(environment.NOTION_ROOT_PAGE_ID === undefined
      ? {}
      : { notionRootId: environment.NOTION_ROOT_PAGE_ID }),
    ...(environment.KNOWLEDGE_INDEX === undefined
      ? {}
      : { knowledgeIndex: environment.KNOWLEDGE_INDEX }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.createId === undefined ? {} : { createId: options.createId }),
    log,
  });
}

function createDraftService(
  environment: Env,
  options: AppOptions,
): DraftService {
  return new DraftService(environment, {
    ...(options.createDraftGenerator === undefined
      ? {}
      : { generator: options.createDraftGenerator(environment) }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.createId === undefined ? {} : { createId: options.createId }),
  });
}

function createGardenService(environment: Env, options: AppOptions) {
  return new GardenService(environment, {
    ...(options.createGardenGenerator === undefined
      ? {}
      : { generator: options.createGardenGenerator(environment) }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.createId === undefined ? {} : { createId: options.createId }),
    ...(options.log === undefined ? {} : { log: options.log }),
  });
}

function clientSession(context: Context): string | null {
  return parseSessionId(context.req.header("X-Client-Session-Id"));
}

function ownerScope(context: Context, sessionId: string): string {
  return context.env.APP_MODE === "live"
    ? (context.get("accessSubject") ?? sessionId)
    : sessionId;
}

function aiRateKey(context: Context, sessionId: string): string {
  if (context.env.APP_MODE === "live") {
    return context.get("accessSubject") ?? sessionId;
  }
  return context.req.header("CF-Connecting-IP") ?? sessionId;
}

function liveSession(context: Context): string | null {
  return parseSessionId(context.req.header("X-Client-Session-Id"));
}
function modeUnavailable(context: Context) {
  return errorResponse(
    context,
    "mode_unavailable",
    "Draft publishing is available only in live mode.",
    false,
    503,
  );
}
function handleDraftError(context: Context, error: unknown) {
  if (!(error instanceof DraftServiceError))
    return errorResponse(
      context,
      "database_unavailable",
      "Drafts are temporarily unavailable.",
      true,
      503,
    );
  const status = (
    {
      draft_not_found: 404,
      draft_source_unavailable: 409,
      draft_conflict: 409,
      draft_not_publishable: 409,
      draft_publish_in_progress: 409,
      draft_publish_uncertain: 409,
      draft_generation_unavailable: 503,
      notion_write_unavailable: 503,
      rate_limited: 429,
      knowledge_not_ready: 409,
      source_configuration_error: 503,
    } as const
  )[error.code];
  if (error.code === "rate_limited") context.header("Retry-After", "60");
  return errorResponse(
    context,
    error.code,
    error.message,
    error.retryable,
    status,
  );
}

function handleChatError(context: Context, error: unknown) {
  if (!(error instanceof ChatServiceError)) {
    return errorResponse(
      context,
      "database_unavailable",
      "Chat is temporarily unavailable.",
      true,
      503,
    );
  }
  const status = {
    conversation_not_found: 404,
    rate_limited: 429,
    invalid_ai_response: 502,
    ai_unavailable: 503,
    database_unavailable: 503,
    knowledge_not_ready: 409,
    retrieval_unavailable: 503,
  }[error.code] as 404 | 409 | 429 | 502 | 503;
  if (error.code === "rate_limited") context.header("Retry-After", "60");
  return errorResponse(
    context,
    error.code,
    error.message,
    error.retryable,
    status,
  );
}

function handleGardenError(context: Context, error: unknown) {
  if (!(error instanceof GardenServiceError)) {
    return errorResponse(
      context,
      "garden_unavailable",
      "Garden analysis is temporarily unavailable.",
      true,
      503,
    );
  }
  const status = {
    knowledge_not_ready: 409,
    garden_scan_in_progress: 409,
    garden_unavailable: 503,
    rate_limited: 429,
    not_found: 404,
    garden_conflict: 409,
  }[error.code] as 404 | 409 | 429 | 503;
  if (error.code === "rate_limited") context.header("Retry-After", "60");
  return errorResponse(
    context,
    error.code,
    error.message,
    error.retryable,
    status,
  );
}

function handleFeedbackMaintenanceError(context: Context, error: unknown) {
  if (!(error instanceof FeedbackMaintenanceError)) {
    return errorResponse(
      context,
      "database_unavailable",
      "The requested data change is temporarily unavailable.",
      true,
      503,
    );
  }
  const status = {
    feedback_target_not_found: 404,
    knowledge_not_ready: 409,
    maintenance_conflict: 409,
    database_unavailable: 503,
  }[error.code] as 404 | 409 | 503;
  return errorResponse(
    context,
    error.code,
    error.message,
    error.retryable,
    status,
  );
}

function handleSyncError(context: Context, error: unknown) {
  if (!(error instanceof SyncServiceError)) {
    return errorResponse(
      context,
      "database_unavailable",
      "Synchronization is temporarily unavailable.",
      true,
      503,
    );
  }
  const status =
    error.code === "sync_not_found"
      ? 404
      : error.code === "invalid_cursor"
        ? 400
        : 503;
  return errorResponse(
    context,
    error.code,
    error.message,
    error.retryable,
    status,
  );
}

function validationError(context: Context, message: string) {
  return errorResponse(context, "validation_error", message, false, 400);
}

function errorResponse(
  context: Context,
  code: ApiErrorCode,
  message: string,
  retryable: boolean,
  status: 202 | 400 | 401 | 404 | 409 | 429 | 502 | 503,
) {
  return context.json(
    apiErrorResponseSchema.parse({ error: { code, message, retryable } }),
    status,
  );
}

const app = createApp();

export { app };
export default app;
