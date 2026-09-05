import {
  apiErrorResponseSchema,
  chatRequestSchema,
  conversationMessagesResponseSchema,
  healthResponseSchema,
  idSchema,
  type ApiErrorCode,
  type HealthResponse,
} from "@knowledge-gardener/domain";
import { Hono, type Context } from "hono";

import {
  WorkersAiAnswerGenerator,
  type AnswerGenerator,
} from "./answer-generator";
import { ChatService, ChatServiceError, parseSessionId } from "./chat-service";
import type { Env } from "./env";

interface AppOptions {
  createAnswerGenerator?: (environment: Env) => AnswerGenerator;
  now?: () => string;
  createId?: () => string;
  log?: (record: Record<string, unknown>) => void;
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<{ Bindings: Env }>();

  app.use("*", async (context, next) => {
    const origin = context.req.header("Origin");

    if (context.req.method === "OPTIONS") {
      if (origin !== context.env.APP_ALLOWED_ORIGIN) {
        return context.body(null, 403);
      }
      return context.body(null, 204, {
        "Access-Control-Allow-Headers": "Content-Type, X-Demo-Session-Id",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
      });
    }

    await next();
    if (origin === context.env.APP_ALLOWED_ORIGIN) {
      context.header("Access-Control-Allow-Origin", origin);
      context.header("Vary", "Origin");
    }
  });

  app.get("/health", async (context) => {
    try {
      const result =
        await context.env.DB.prepare("SELECT 1 AS ok").first<number>("ok");
      if (result !== 1) throw new Error("Database readiness query failed.");

      const response: HealthResponse = {
        status: "ok",
        mode: context.env.APP_MODE,
        checks: { database: "ok" },
      };
      return context.json(healthResponseSchema.parse(response), 200);
    } catch {
      const response: HealthResponse = {
        status: "degraded",
        mode: context.env.APP_MODE,
        checks: { database: "error" },
      };
      return context.json(healthResponseSchema.parse(response), 503);
    }
  });

  app.post("/chat", async (context) => {
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

  app.get("/conversations/:conversationId/messages", async (context) => {
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

function validationError(context: Context, message: string) {
  return errorResponse(context, "validation_error", message, false, 400);
}

function errorResponse(
  context: Context,
  code: ApiErrorCode,
  message: string,
  retryable: boolean,
  status: 400 | 404 | 429 | 502 | 503,
) {
  return context.json(
    apiErrorResponseSchema.parse({ error: { code, message, retryable } }),
    status,
  );
}

const app = createApp();

export { app };
export default app;
