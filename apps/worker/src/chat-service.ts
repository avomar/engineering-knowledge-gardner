import {
  chatResponseSchema,
  groundedAnswerSchema,
  idSchema,
  messageSchema,
  type ChatRequest,
  type ChatResponse,
  type GroundedAnswer,
  type Message,
} from "@knowledge-gardener/domain";

import {
  AiUnavailableError,
  InvalidAiResponseError,
  type AnswerGenerator,
} from "./answer-generator";
import { ChatRepository, type RetrievedChunk } from "./chat-repository";
import { DemoCorpusService } from "./demo-corpus";
import {
  HybridRetriever,
  RetrievalUnavailableError,
  retrieveChunks,
} from "./retrieval";
import type { AppMode } from "@knowledge-gardener/domain";

const insufficientAnswer: GroundedAnswer = {
  answer:
    "The indexed knowledge base does not contain enough evidence to answer that question.",
  confidence: "low",
  citations: [],
  unansweredQuestions: ["What source should be added to cover this topic?"],
};
const MAX_ANSWER_ATTEMPTS = 2;

export type ChatServiceErrorCode =
  | "conversation_not_found"
  | "rate_limited"
  | "invalid_ai_response"
  | "ai_unavailable"
  | "database_unavailable"
  | "knowledge_not_ready"
  | "retrieval_unavailable";

export class ChatServiceError extends Error {
  override readonly name = "ChatServiceError";

  constructor(
    readonly code: ChatServiceErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface ChatServiceOptions {
  database: D1Database;
  ai: Ai;
  answerGenerator: AnswerGenerator;
  rateLimiter: RateLimit;
  now?: () => string;
  createId?: () => string;
  log?: (record: Record<string, unknown>) => void;
  mode?: AppMode;
  notionRootId?: string;
  knowledgeIndex?: VectorizeIndex;
}

export class ChatService {
  private readonly repository: ChatRepository;
  private readonly corpus: DemoCorpusService;
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly log: (record: Record<string, unknown>) => void;
  private readonly mode: AppMode;

  constructor(private readonly options: ChatServiceOptions) {
    this.repository = new ChatRepository(options.database);
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.corpus = new DemoCorpusService(options.database, this.now);
    this.log = options.log ?? ((record) => console.log(JSON.stringify(record)));
    this.mode = options.mode ?? "demo";
  }

  async answer(
    ownerSessionId: string,
    request: ChatRequest,
  ): Promise<ChatResponse> {
    const startedAt = Date.now();
    const requestId = this.createId();
    try {
      const knowledgeSpaceId = await this.resolveKnowledgeSpace();
      if (!(await this.repository.hasEligibleChunks(knowledgeSpaceId))) {
        throw new ChatServiceError(
          "knowledge_not_ready",
          "Complete a synchronization before asking questions.",
          false,
        );
      }
      const conversationId = request.conversationId ?? this.createId();
      const createConversation = request.conversationId === undefined;
      if (
        !createConversation &&
        !(await this.repository.conversationExists(
          conversationId,
          ownerSessionId,
          knowledgeSpaceId,
        ))
      ) {
        throw new ChatServiceError(
          "conversation_not_found",
          "The conversation could not be found.",
          false,
        );
      }

      const history = await (createConversation
        ? Promise.resolve([])
        : this.repository.listRecentMessages(conversationId, 8));
      const rateLimitConsumed = this.mode === "live";
      if (rateLimitConsumed) await this.requireRateLimit(ownerSessionId);
      const retrieval = await this.retrieve(request.question, knowledgeSpaceId);
      const sources = retrieval.chunks;
      this.log({
        event: "chat.retrieval",
        requestId,
        mode: this.mode,
        ...retrieval.diagnostics,
      });

      let answer: GroundedAnswer;
      if (sources.length === 0) {
        answer = insufficientAnswer;
      } else {
        if (!rateLimitConsumed) await this.requireRateLimit(ownerSessionId);
        answer = await this.generateGroundedAnswer(
          requestId,
          request.question,
          history,
          sources,
        );
      }

      const timestamp = this.now();
      const user = messageSchema.parse({
        id: this.createId(),
        conversationId,
        role: "user",
        content: request.question,
        citations: [],
        confidence: null,
        unansweredQuestions: [],
        createdAt: timestamp,
      });
      const assistant = messageSchema.parse({
        id: this.createId(),
        conversationId,
        role: "assistant",
        content: answer.answer,
        citations: answer.citations,
        confidence: answer.confidence,
        unansweredQuestions: answer.unansweredQuestions,
        createdAt: timestamp,
      });

      await this.repository.saveTurn({
        conversationId,
        knowledgeSpaceId,
        ownerSessionId,
        createConversation,
        user: {
          id: user.id,
          content: user.content,
          createdAt: user.createdAt,
        },
        assistant: {
          id: assistant.id,
          content: assistant.content,
          citations: assistant.citations,
          confidence: answer.confidence,
          unansweredQuestions: assistant.unansweredQuestions,
          createdAt: assistant.createdAt,
        },
      });
      const [userMessage, assistantMessage] =
        await this.repository.hydrateMessages([user, assistant]);
      if (userMessage === undefined || assistantMessage === undefined) {
        throw new Error("The stored turn could not be hydrated.");
      }
      this.log({
        event: "chat.completed",
        requestId,
        citedSources: assistant.citations.length,
        durationMs: Date.now() - startedAt,
      });
      return chatResponseSchema.parse({
        conversationId,
        userMessage,
        assistantMessage,
      });
    } catch (error) {
      this.log({
        event: "chat.failed",
        requestId,
        code: error instanceof ChatServiceError ? error.code : "internal",
        durationMs: Date.now() - startedAt,
      });
      if (error instanceof ChatServiceError) throw error;
      throw new ChatServiceError(
        "database_unavailable",
        "Chat history is temporarily unavailable.",
        true,
        { cause: error },
      );
    }
  }

  async history(ownerSessionId: string, conversationId: string) {
    try {
      const knowledgeSpaceId = await this.resolveKnowledgeSpace();
      if (
        !(await this.repository.conversationExists(
          conversationId,
          ownerSessionId,
          knowledgeSpaceId,
        ))
      ) {
        throw new ChatServiceError(
          "conversation_not_found",
          "The conversation could not be found.",
          false,
        );
      }
      const messages = await this.repository.listMessages(conversationId);
      return {
        conversationId,
        messages: await this.repository.hydrateMessages(messages),
      };
    } catch (error) {
      if (error instanceof ChatServiceError) throw error;
      throw new ChatServiceError(
        "database_unavailable",
        "Chat history is temporarily unavailable.",
        true,
        { cause: error },
      );
    }
  }

  private async resolveKnowledgeSpace(): Promise<string> {
    if (this.mode === "demo") return await this.corpus.ensureReady();
    if (this.options.notionRootId === undefined) {
      throw new ChatServiceError(
        "knowledge_not_ready",
        "The live knowledge source is not configured.",
        false,
      );
    }
    const spaceId = await this.repository.findLiveKnowledgeSpace(
      this.options.notionRootId,
    );
    if (spaceId === null) {
      throw new ChatServiceError(
        "knowledge_not_ready",
        "Complete a synchronization before asking questions.",
        false,
      );
    }
    return spaceId;
  }

  private async requireRateLimit(ownerSessionId: string): Promise<void> {
    const rateLimit = await this.options.rateLimiter.limit({
      key: ownerSessionId,
    });
    if (!rateLimit.success) {
      throw new ChatServiceError(
        "rate_limited",
        "Too many AI requests. Try again in a minute.",
        true,
      );
    }
  }

  private async retrieve(question: string, knowledgeSpaceId: string) {
    if (this.mode === "demo") {
      const chunks = retrieveChunks(
        question,
        await this.repository.listChunks(knowledgeSpaceId),
        6,
      );
      return {
        chunks,
        diagnostics: {
          lexicalCount: chunks.length,
          semanticCount: 0,
          hydratedCount: 0,
          selectedCount: chunks.length,
          staleCount: 0,
          semanticAvailable: false,
        },
      };
    }
    try {
      return await new HybridRetriever(
        this.repository,
        this.options.ai,
        this.options.knowledgeIndex,
      ).retrieve(question, knowledgeSpaceId);
    } catch (error) {
      if (error instanceof RetrievalUnavailableError) {
        throw new ChatServiceError(
          "retrieval_unavailable",
          "Knowledge retrieval is temporarily unavailable. Please retry.",
          true,
          { cause: error },
        );
      }
      throw error;
    }
  }

  private async generateGroundedAnswer(
    requestId: string,
    question: string,
    history: readonly Message[],
    sources: readonly RetrievedChunk[],
  ): Promise<GroundedAnswer> {
    for (let attempt = 1; attempt <= MAX_ANSWER_ATTEMPTS; attempt += 1) {
      let generated: unknown;
      try {
        generated = await this.options.answerGenerator.generate({
          question,
          history,
          sources,
          ...(attempt === 1 ? {} : { retry: true }),
        });
      } catch (error) {
        if (error instanceof InvalidAiResponseError) {
          this.logAnswerRejection(requestId, attempt, error.reason);
          if (attempt < MAX_ANSWER_ATTEMPTS) continue;
          throw invalidResponse(error);
        }
        if (error instanceof AiUnavailableError) {
          throw new ChatServiceError(
            "ai_unavailable",
            "The answer service is temporarily unavailable.",
            true,
            { cause: error },
          );
        }
        throw error;
      }

      try {
        const validated = validateGroundedAnswer(generated, sources);
        return validated.citations.length === 0 &&
          validated.confidence === "low"
          ? insufficientAnswer
          : validated;
      } catch (error) {
        if (!(error instanceof InvalidGroundedAnswerError)) throw error;
        this.logAnswerRejection(requestId, attempt, error.reason);
        if (attempt < MAX_ANSWER_ATTEMPTS) continue;
        throw invalidResponse(error);
      }
    }
    throw invalidResponse();
  }

  private logAnswerRejection(
    requestId: string,
    attempt: number,
    reason: AnswerRejectionReason,
  ): void {
    this.log({
      event: "chat.answer_rejected",
      requestId,
      attempt,
      reason,
      willRetry: attempt < MAX_ANSWER_ATTEMPTS,
    });
  }
}

function validateGroundedAnswer(
  value: unknown,
  sources: readonly RetrievedChunk[],
): GroundedAnswer {
  const parsed = groundedAnswerSchema.safeParse(value);
  if (!parsed.success) throw new InvalidGroundedAnswerError("schema_invalid");
  if (parsed.data.citations.length === 0 && parsed.data.confidence !== "low")
    throw new InvalidGroundedAnswerError("missing_citations");
  const sourceById = new Map(sources.map((source) => [source.chunkId, source]));
  const cited = new Set<string>();
  for (const citation of parsed.data.citations) {
    if (cited.has(citation.chunkId))
      throw new InvalidGroundedAnswerError("duplicate_citation");
    cited.add(citation.chunkId);
    const source = sourceById.get(citation.chunkId);
    if (source === undefined)
      throw new InvalidGroundedAnswerError("unknown_citation");
    if (
      !normalizeWhitespace(source.content).includes(
        normalizeWhitespace(citation.quote),
      )
    )
      throw new InvalidGroundedAnswerError("quote_mismatch");
    if (
      source.source.sourceUrl?.startsWith("https:") === true &&
      !isSupportedNotionUrl(source.source.sourceUrl)
    )
      throw new InvalidGroundedAnswerError("invalid_source_url");
  }
  return parsed.data;
}

type AnswerRejectionReason =
  | InvalidAiResponseError["reason"]
  | "schema_invalid"
  | "missing_citations"
  | "duplicate_citation"
  | "unknown_citation"
  | "quote_mismatch"
  | "invalid_source_url";

class InvalidGroundedAnswerError extends Error {
  override readonly name = "InvalidGroundedAnswerError";

  constructor(
    readonly reason: Exclude<
      AnswerRejectionReason,
      InvalidAiResponseError["reason"]
    >,
  ) {
    super("The generated answer failed grounding validation.");
  }
}

function invalidResponse(cause?: unknown): ChatServiceError {
  return new ChatServiceError(
    "invalid_ai_response",
    "The model returned an invalid answer. Please retry.",
    true,
    cause === undefined ? undefined : { cause },
  );
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function isSupportedNotionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["notion.so", "www.notion.so", "notion.com", "www.notion.com"].includes(
        url.hostname,
      )
    );
  } catch {
    return false;
  }
}

export function parseSessionId(value: string | undefined): string | null {
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
