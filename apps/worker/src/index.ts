import {
  apiErrorResponseSchema,
  chatRequestSchema,
  conversationMessagesResponseSchema,
  documentSearchResponseSchema,
  healthResponseSchema,
  idSchema,
  indexStatusSchema,
  syncDetailResponseSchema,
  syncOverviewResponseSchema,
  syncStartResponseSchema,
  type ApiErrorCode,
  type HealthResponse,
} from "@knowledge-gardener/domain";
import { Hono, type Context } from "hono";

import {
  WorkersAiAnswerGenerator,
  type AnswerGenerator,
} from "./answer-generator";
import { ChatService, ChatServiceError, parseSessionId } from "./chat-service";
import { DemoCorpusService } from "./demo-corpus";
import type { Env } from "./env";
import { optionalRoot, SyncService, SyncServiceError } from "./sync-service";
import { SyncRepository } from "./sync-repository";

interface AppOptions {
  createAnswerGenerator?: (environment: Env) => AnswerGenerator;
  now?: () => string;
  createId?: () => string;
  log?: (record: Record<string, unknown>) => void;
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<{ Bindings: Env }>();
  const api = new Hono<{ Bindings: Env }>();

  api.get("/health", async (context) => {
    try {
      const result =
        await context.env.DB.prepare("SELECT 1 AS ok").first<number>("ok");
      if (result !== 1) throw new Error("Database readiness query failed.");

      const response: HealthResponse = {
        status: "ok",
        mode: context.env.APP_MODE,
        checks: {
          database: "ok",
          sourceConfiguration:
            context.env.APP_MODE === "live"
              ? optionalRoot(context.env) === null
                ? "error"
                : "ok"
              : "not_applicable",
        },
      };
      return context.json(healthResponseSchema.parse(response), 200);
    } catch {
      const response: HealthResponse = {
        status: "degraded",
        mode: context.env.APP_MODE,
        checks: {
          database: "error",
          sourceConfiguration:
            context.env.APP_MODE === "live" ? "error" : "not_applicable",
        },
      };
      return context.json(healthResponseSchema.parse(response), 503);
    }
  });

  api.post("/chat", async (context) => {
    if (context.env.APP_MODE !== "demo") {
      return errorResponse(
        context,
        "mode_unavailable",
        "Demo chat is unavailable in this application mode.",
        false,
        503,
      );
    }
    const sessionId = parseSessionId(context.req.header("X-Demo-Session-Id"));
    if (sessionId === null) {
      return validationError(context, "A valid demo session ID is required.");
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
      return context.json(await service.answer(sessionId, request.data), 200);
    } catch (error) {
      return handleChatError(context, error);
    }
  });

  api.get("/conversations/:conversationId/messages", async (context) => {
    if (context.env.APP_MODE !== "demo") {
      return errorResponse(
        context,
        "mode_unavailable",
        "Demo chat is unavailable in this application mode.",
        false,
        503,
      );
    }
    const sessionId = parseSessionId(context.req.header("X-Demo-Session-Id"));
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
    answerGenerator:
      options.createAnswerGenerator?.(environment) ??
      new WorkersAiAnswerGenerator(environment.AI, log),
    rateLimiter: environment.CHAT_RATE_LIMITER,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.createId === undefined ? {} : { createId: options.createId }),
    log,
  });
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
  }[error.code] as 404 | 429 | 502 | 503;
  if (error.code === "rate_limited") context.header("Retry-After", "60");
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
  status: 202 | 400 | 404 | 429 | 502 | 503,
) {
  return context.json(
    apiErrorResponseSchema.parse({ error: { code, message, retryable } }),
    status,
  );
}

const app = createApp();

export { app };
export default app;
