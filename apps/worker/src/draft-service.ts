import {
  createDraftRequestSchema,
  publishDraftResponseSchema,
  type Draft,
  type DraftSource,
} from "@knowledge-gardener/domain";
import { SourceAdapterError } from "@knowledge-gardener/source";
import { z } from "zod";
import { AiUnavailableError, InvalidAiResponseError } from "./answer-generator";
import { ChatRepository } from "./chat-repository";
import {
  type DraftGenerator,
  WorkersAiDraftGenerator,
} from "./draft-generator";
import { DraftRepository } from "./draft-repository";
import type { Env } from "./env";
import { normalizeNotionId, NotionClient } from "./notion";
import { optionalRoot } from "./sync-service";

export type DraftServiceErrorCode =
  | "draft_not_found"
  | "draft_source_unavailable"
  | "draft_conflict"
  | "draft_not_publishable"
  | "draft_publish_in_progress"
  | "draft_publish_uncertain"
  | "draft_generation_unavailable"
  | "notion_write_unavailable"
  | "rate_limited"
  | "knowledge_not_ready"
  | "source_configuration_error";

export class DraftServiceError extends Error {
  constructor(
    readonly code: DraftServiceErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class DraftService {
  private readonly repository: DraftRepository;
  private readonly chatRepository: ChatRepository;
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly generator: DraftGenerator;

  constructor(
    private readonly env: Env,
    options: {
      generator?: DraftGenerator;
      now?: () => string;
      createId?: () => string;
    } = {},
  ) {
    this.repository = new DraftRepository(env.DB);
    this.chatRepository = new ChatRepository(env.DB);
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? (() => crypto.randomUUID());
    this.generator = options.generator ?? new WorkersAiDraftGenerator(env.AI);
  }

  async generate(owner: string, input: unknown): Promise<Draft> {
    const request = createDraftRequestSchema.safeParse(input);
    if (!request.success)
      throw new DraftServiceError(
        "draft_source_unavailable",
        "Draft source and instruction are invalid.",
        false,
      );
    const [space, parent] = await Promise.all([
      this.liveSpace(),
      Promise.resolve(this.draftsParent()),
    ]);
    await this.requireRateLimit(owner);
    const origin = await this.repository.findOrigin(
      owner,
      space,
      request.data.sourceMessageId,
    );
    if (!origin)
      throw new DraftServiceError(
        "draft_source_unavailable",
        "That cited assistant answer is unavailable.",
        false,
      );
    const hydrated = await this.repository.hydrateSources(
      space,
      origin.citations,
    );
    if (
      hydrated.sources.length !== origin.citations.length ||
      hydrated.sources.length === 0
    )
      throw new DraftServiceError(
        "draft_source_unavailable",
        "One or more cited sources are no longer available.",
        false,
      );
    const raw = await this.generateWithCorrection({
      question: origin.question,
      answer: origin.answer,
      ...(request.data.instruction === undefined
        ? {}
        : { instruction: request.data.instruction }),
      sources: hydrated.sources,
    });
    const output = outputSchema.safeParse(raw);
    if (
      !output.success ||
      output.data.sourceChunkIds.some(
        (id) => !hydrated.sources.some((source) => source.chunkId === id),
      )
    )
      throw new DraftServiceError(
        "draft_generation_unavailable",
        "Draft generation returned invalid grounded content.",
        true,
      );
    const used = output.data.sourceChunkIds
      .map((id) => hydrated.snapshots.find((source) => source.chunkId === id))
      .filter((value): value is DraftSource => value !== undefined);
    if (used.length === 0)
      throw new DraftServiceError(
        "draft_generation_unavailable",
        "Draft generation did not retain a source.",
        true,
      );
    return await this.repository.create({
      id: this.createId(),
      knowledgeSpaceId: space,
      ownerSessionId: owner,
      sourceMessageId: request.data.sourceMessageId,
      instruction: request.data.instruction ?? null,
      title: output.data.title,
      contentMarkdown: output.data.contentMarkdown,
      assumptions: output.data.assumptions,
      sources: used,
      targetParentId: parent,
      now: this.now(),
    });
  }

  async list(owner: string, cursor: number, limit: number, status?: string) {
    return await this.repository.list(
      owner,
      await this.liveSpace(),
      cursor,
      limit,
      status,
    );
  }
  async get(owner: string, id: string): Promise<Draft> {
    return this.requireDraft(id, owner);
  }
  async edit(
    owner: string,
    id: string,
    input: {
      title: string;
      contentMarkdown: string;
      assumptions: string[];
      version: number;
    },
  ): Promise<Draft> {
    const outcome = await this.repository.edit(
      id,
      owner,
      await this.liveSpace(),
      { ...input, now: this.now() },
    );
    if (outcome === "missing")
      throw new DraftServiceError("draft_not_found", "Draft not found.", false);
    if (outcome !== "ok")
      throw new DraftServiceError(
        "draft_conflict",
        "This draft changed or is being published. Reload it before saving.",
        false,
      );
    return this.requireDraft(id, owner);
  }
  async discard(owner: string, id: string, version: number): Promise<Draft> {
    const outcome = await this.repository.discard(
      id,
      owner,
      await this.liveSpace(),
      version,
      this.now(),
    );
    if (outcome === "missing")
      throw new DraftServiceError("draft_not_found", "Draft not found.", false);
    if (outcome !== "ok")
      throw new DraftServiceError(
        "draft_conflict",
        "This draft changed or is being published. Reload it before discarding.",
        false,
      );
    return this.requireDraft(id, owner);
  }

  async publish(owner: string, id: string, version: number) {
    const space = await this.liveSpace();
    const now = this.now();
    const lease = new Date(Date.parse(now) + 60_000).toISOString();
    const claim = await this.repository.claim(
      id,
      owner,
      space,
      version,
      now,
      lease,
    );
    if (claim === "missing")
      throw new DraftServiceError("draft_not_found", "Draft not found.", false);
    if (claim === "published")
      return publishDraftResponseSchema.parse({
        draft: await this.requireDraft(id, owner),
        reused: true,
      });
    if (claim === "in_progress")
      throw new DraftServiceError(
        "draft_publish_in_progress",
        "This draft is already being published.",
        true,
      );
    if (claim !== "claimed")
      throw new DraftServiceError(
        "draft_conflict",
        "This draft changed. Reload it before publishing.",
        false,
      );
    const draft = await this.requireDraft(id, owner);
    try {
      const parent = await this.validateParent(draft);
      const client = new NotionClient(this.env.NOTION_TOKEN!, {
        log: (record) => console.log(JSON.stringify(record)),
      });
      const marker = markerFor(draft.id);
      const existing = await client.findDirectChildByMarker(parent, marker);
      if (existing) {
        await this.repository.publishResult(
          draft.id,
          owner,
          space,
          existing.id,
          existing.url,
          this.now(),
          true,
        );
        return publishDraftResponseSchema.parse({
          draft: await this.requireDraft(id, owner),
          reused: true,
        });
      }
      const page = await client.createPage(
        parent,
        `${draft.title} ${marker}`,
        composeMarkdown(draft),
      );
      await this.repository.publishResult(
        draft.id,
        owner,
        space,
        page.id,
        page.url,
        this.now(),
        false,
      );
      return publishDraftResponseSchema.parse({
        draft: await this.requireDraft(id, owner),
        reused: false,
      });
    } catch (error) {
      const definite =
        error instanceof DraftServiceError ||
        (error instanceof SourceAdapterError &&
          ["access_denied", "not_found", "invalid_data"].includes(error.code));
      await this.repository.publishFailure(
        id,
        owner,
        space,
        definite ? "failed" : "uncertain",
        definite ? "notion_write_rejected" : "notion_write_uncertain",
        definite
          ? "Notion rejected the draft publication."
          : "The Notion result is uncertain; inspect the drafts parent before retrying.",
        this.now(),
      );
      if (error instanceof DraftServiceError) throw error;
      if (!definite)
        throw new DraftServiceError(
          "draft_publish_uncertain",
          "The Notion result is uncertain; inspect the drafts parent before retrying.",
          false,
          { cause: error },
        );
      throw new DraftServiceError(
        "notion_write_unavailable",
        "Notion could not publish this draft.",
        true,
        { cause: error },
      );
    }
  }

  private async generateWithCorrection(
    input: Parameters<DraftGenerator["generate"]>[0],
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.generator.generate({
          ...input,
          ...(attempt === 1 ? { retry: true } : {}),
        });
        if (outputSchema.safeParse(result).success) return result;
      } catch (error) {
        if (error instanceof AiUnavailableError)
          throw new DraftServiceError(
            "draft_generation_unavailable",
            "Draft generation is temporarily unavailable.",
            true,
            { cause: error },
          );
        if (!(error instanceof InvalidAiResponseError)) throw error;
      }
    }
    throw new DraftServiceError(
      "draft_generation_unavailable",
      "Draft generation returned invalid content.",
      true,
    );
  }
  private async liveSpace(): Promise<string> {
    const root = optionalRoot(this.env);
    if (!root)
      throw new DraftServiceError(
        "source_configuration_error",
        "The live Notion source is not configured.",
        false,
      );
    const space = await this.chatRepository.findLiveKnowledgeSpace(root);
    if (!space)
      throw new DraftServiceError(
        "knowledge_not_ready",
        "Complete a synchronization before creating a draft.",
        false,
      );
    return space;
  }
  private draftsParent(): string {
    if (!this.env.NOTION_TOKEN || !this.env.NOTION_DRAFTS_PARENT_ID)
      throw new DraftServiceError(
        "source_configuration_error",
        "The live Notion drafts parent is not configured.",
        false,
      );
    try {
      return normalizeNotionId(this.env.NOTION_DRAFTS_PARENT_ID);
    } catch {
      throw new DraftServiceError(
        "source_configuration_error",
        "The live Notion drafts parent is invalid.",
        false,
      );
    }
  }
  private async validateParent(draft: Draft): Promise<string> {
    const root = optionalRoot(this.env);
    const parent = this.draftsParent();
    if (!root || parent === root || draft.targetParentId !== parent)
      throw new DraftServiceError(
        "draft_not_publishable",
        "The configured drafts parent is not safe for this draft.",
        false,
      );
    const page = await new NotionClient(this.env.NOTION_TOKEN!).retrievePage(
      parent,
    );
    const parentId =
      typeof page.parent.page_id === "string"
        ? normalizeNotionId(page.parent.page_id)
        : null;
    if (page.in_trash || parentId !== root)
      throw new DraftServiceError(
        "draft_not_publishable",
        "The drafts parent must be a direct child of the source root.",
        false,
      );
    return parent;
  }
  private async requireDraft(id: string, owner: string): Promise<Draft> {
    const draft = await this.repository.find(id, owner, await this.liveSpace());
    if (!draft)
      throw new DraftServiceError("draft_not_found", "Draft not found.", false);
    return draft;
  }
  private async requireRateLimit(owner: string): Promise<void> {
    const result = await this.env.CHAT_RATE_LIMITER.limit({
      key: `draft:${owner}`,
    });
    if (!result.success)
      throw new DraftServiceError(
        "rate_limited",
        "Too many draft requests. Try again in a minute.",
        true,
      );
  }
}

const outputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  contentMarkdown: z.string().max(12_000),
  assumptions: z.array(z.string().trim().min(1).max(1_000)).max(10),
  sourceChunkIds: z.array(z.string().uuid()).min(1).max(6),
});
function markerFor(id: string) {
  return `[KG Draft ${id}]`;
}
function sanitize(markdown: string): string {
  const withoutControls = [...markdown]
    .filter(
      (character) =>
        character >= " " || character === "\n" || character === "\t",
    )
    .join("");
  if (withoutControls.length > 20_000)
    throw new DraftServiceError(
      "draft_not_publishable",
      "Draft content is too large to publish.",
      false,
    );
  return withoutControls
    .replace(/^#\s+/gmu, "## ")
    .replace(/<\/?(?:page|database|mention|media|[a-z][^>]*)[^>]*>/giu, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1");
}
function composeMarkdown(draft: Draft): string {
  const sources = draft.sources
    .map(
      (source) =>
        `- [${source.title}](${source.sourceUrl}) — “${source.quote.replaceAll("\n", " ")}”`,
    )
    .join("\n");
  return [
    `> AI-assisted, owner-reviewed draft. Generated from cited source material; verify before relying on it.`,
    "",
    sanitize(draft.contentMarkdown),
    "",
    "## Sources",
    sources,
    ...(draft.assumptions.length
      ? ["", "## Assumptions", ...draft.assumptions.map((item) => `- ${item}`)]
      : []),
    "",
    "## Provenance",
    `Draft ID: ${draft.id}`,
    `Originating assistant message: ${draft.sourceMessageId}`,
  ].join("\n");
}
