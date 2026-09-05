import {
  SourceAdapterError,
  sourceDocumentSchema,
  type SourceDocument,
} from "@knowledge-gardener/source";
import { z } from "zod";

export const NOTION_API_VERSION = "2026-03-11";
const apiOrigin = "https://api.notion.com/v1";
const requestTimeoutMs = 20_000;
const notionPageHosts = new Set([
  "notion.so",
  "www.notion.so",
  "notion.com",
  "www.notion.com",
]);

const richTextSchema = z.object({
  plain_text: z.string().default(""),
  href: z.string().url().nullable().optional(),
  annotations: z
    .object({
      bold: z.boolean().optional(),
      italic: z.boolean().optional(),
      strikethrough: z.boolean().optional(),
      code: z.boolean().optional(),
    })
    .optional(),
});

const pageSchema = z.object({
  object: z.literal("page"),
  id: z.string(),
  url: z.string().url(),
  created_time: z.string().datetime({ offset: true }),
  last_edited_time: z.string().datetime({ offset: true }),
  in_trash: z.boolean().optional().default(false),
  parent: z.record(z.string(), z.unknown()),
  properties: z.record(z.string(), z.unknown()),
});

const blockSchema: z.ZodType<NotionBlock> = z
  .object({
    object: z.literal("block"),
    id: z.string(),
    type: z.string(),
    has_children: z.boolean().default(false),
    in_trash: z.boolean().optional().default(false),
  })
  .passthrough() as z.ZodType<NotionBlock>;

const blockListSchema = z.object({
  results: z.array(blockSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

const databaseSchema = z.object({
  object: z.literal("database"),
  id: z.string(),
  title: z.array(richTextSchema).default([]),
  data_sources: z.array(z.object({ id: z.string(), name: z.string() })),
});

const dataSourceListSchema = z.object({
  results: z.array(z.record(z.string(), z.unknown())),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

export type NotionPage = z.infer<typeof pageSchema>;
export interface NotionBlock {
  object: "block";
  id: string;
  type: string;
  has_children: boolean;
  in_trash: boolean;
  [key: string]: unknown;
}

export interface BlockTree extends NotionBlock {
  children: BlockTree[];
}

interface NotionClientOptions {
  fetcher?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  log?: (record: Record<string, unknown>) => void;
}

export class NotionClient {
  private lastRequestAt = 0;
  private readonly fetcher: typeof fetch;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly random: () => number;
  private readonly log: (record: Record<string, unknown>) => void;

  constructor(
    private readonly token: string,
    options: NotionClientOptions = {},
  ) {
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.wait =
      options.wait ?? ((milliseconds) => scheduler.wait(milliseconds));
    this.random = options.random ?? Math.random;
    this.log = options.log ?? (() => undefined);
  }

  async retrievePage(pageId: string): Promise<NotionPage> {
    return pageSchema.parse(
      await this.request(`/pages/${encodeURIComponent(pageId)}`),
    );
  }

  async listBlockChildren(blockId: string): Promise<NotionBlock[]> {
    const results: NotionBlock[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (cursor !== null) query.set("start_cursor", cursor);
      const page = blockListSchema.parse(
        await this.request(
          `/blocks/${encodeURIComponent(blockId)}/children?${query.toString()}`,
        ),
      );
      results.push(...page.results);
      cursor = page.has_more ? page.next_cursor : null;
      if (page.has_more && cursor === null) {
        throw new SourceAdapterError(
          "invalid_data",
          "Notion pagination was invalid.",
        );
      }
    } while (cursor !== null);
    return results;
  }

  async retrieveDatabase(databaseId: string) {
    return databaseSchema.parse(
      await this.request(`/databases/${encodeURIComponent(databaseId)}`),
    );
  }

  async queryDataSource(
    dataSourceId: string,
  ): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    do {
      const page = dataSourceListSchema.parse(
        await this.request(
          `/data_sources/${encodeURIComponent(dataSourceId)}/query`,
          {
            method: "POST",
            body: JSON.stringify({
              page_size: 100,
              ...(cursor === null ? {} : { start_cursor: cursor }),
              sorts: [{ timestamp: "created_time", direction: "ascending" }],
            }),
          },
        ),
      );
      results.push(...page.results);
      cursor = page.has_more ? page.next_cursor : null;
      if (page.has_more && cursor === null) {
        throw new SourceAdapterError(
          "invalid_data",
          "Notion pagination was invalid.",
        );
      }
    } while (cursor !== null);
    return results;
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const elapsed = Date.now() - this.lastRequestAt;
      if (elapsed < 350) await this.wait(350 - elapsed);
      this.lastRequestAt = Date.now();
      let response: Response;
      try {
        response = await this.fetcher(`${apiOrigin}${path}`, {
          ...init,
          signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/json",
            "Notion-Version": NOTION_API_VERSION,
            ...init.headers,
          },
        });
      } catch (error) {
        this.log({
          event: "notion.request_failed",
          attempt,
          ...safeFetchError(error),
        });
        if (attempt < 3) {
          await this.retryDelay(attempt, null);
          continue;
        }
        throw new SourceAdapterError(
          "unavailable",
          "Notion is temporarily unavailable.",
          undefined,
          { cause: error },
        );
      }

      if (response.ok) {
        try {
          return await response.json();
        } catch (error) {
          throw new SourceAdapterError(
            "invalid_data",
            "Notion returned invalid data.",
            undefined,
            { cause: error },
          );
        }
      }

      const retryable = [409, 429, 500, 502, 503, 504, 529].includes(
        response.status,
      );
      const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
      if (retryable && attempt < 3) {
        this.log({ event: "notion.retry", status: response.status, attempt });
        await this.retryDelay(attempt, retryAfter);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new SourceAdapterError(
          "access_denied",
          "The Notion connection cannot access the configured root.",
        );
      }
      if (response.status === 404) {
        throw new SourceAdapterError(
          "not_found",
          "The configured Notion page was not found or shared.",
        );
      }
      if (response.status === 429) {
        throw new SourceAdapterError(
          "rate_limited",
          "Notion rate limiting prevented synchronization.",
          retryAfter ?? undefined,
        );
      }
      if (retryable) {
        throw new SourceAdapterError(
          "unavailable",
          "Notion is temporarily unavailable.",
        );
      }
      throw new SourceAdapterError(
        "invalid_data",
        "Notion rejected the synchronization request.",
      );
    }
    throw new SourceAdapterError(
      "unavailable",
      "Notion is temporarily unavailable.",
    );
  }

  private async retryDelay(attempt: number, retryAfterSeconds: number | null) {
    const exponential = 1_000 * 2 ** (attempt - 1);
    const jittered = exponential + Math.floor(this.random() * 250);
    await this.wait(Math.max(jittered, (retryAfterSeconds ?? 0) * 1_000));
  }
}

function safeFetchError(error: unknown): {
  errorName: string;
  errorMessage: string;
} {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message.slice(0, 300),
    };
  }
  return { errorName: "UnknownError", errorMessage: "Unknown fetch failure." };
}

interface QueuePage {
  id: string;
  breadcrumb: string[];
  parentPageId: string | null;
  titleHint?: string;
}

interface QueueDatabase {
  id: string;
  breadcrumb: string[];
  parentPageId: string;
}

export interface DiscoveryResult {
  documents: SourceDocument[];
  failures: DiscoveryFailure[];
  complete: boolean;
}

export interface DiscoveryFailure {
  sourcePageId: string;
  title: string;
  breadcrumb: string[];
  parentSourcePageId: string | null;
  sourceUrl: string;
  errorCode: string;
  errorMessage: string;
}

export async function discoverNotionDocuments(
  client: NotionClient,
  rootId: string,
  limit = 51,
): Promise<DiscoveryResult> {
  const normalizedRoot = normalizeNotionId(rootId);
  const pages: QueuePage[] = [
    { id: normalizedRoot, breadcrumb: [], parentPageId: null },
  ];
  const databases: QueueDatabase[] = [];
  const queuedPages = new Set([normalizedRoot]);
  const visitedDatabases = new Set<string>();
  const documents: SourceDocument[] = [];
  const failures: DiscoveryFailure[] = [];
  let traversalComplete = true;

  while (
    (pages.length > 0 || databases.length > 0) &&
    documents.length < limit
  ) {
    const queued = pages.shift();
    if (queued !== undefined) {
      try {
        const page = await client.retrievePage(queued.id);
        if (page.in_trash) {
          if (queued.id === normalizedRoot) {
            throw new SourceAdapterError(
              "not_found",
              "The configured Notion root is in trash.",
            );
          }
          continue;
        }
        const title = pageTitle(page);
        const breadcrumb = [...queued.breadcrumb, title];
        const blockCount = { value: 0 };
        const trees = await loadBlockTrees(client, page.id, blockCount);
        if (blockCount.value > 2_000) {
          throw new SourceAdapterError(
            "invalid_data",
            "A Notion page exceeds the 2,000 block limit.",
          );
        }
        const metadata = pageMetadata(page);
        const markdown = normalizePageMarkdown(title, metadata, trees);
        if (markdown.length > 250_000) {
          throw new SourceAdapterError(
            "invalid_data",
            "A Notion page exceeds the content limit.",
          );
        }
        documents.push(
          sourceDocumentSchema.parse({
            sourceType: "notion",
            sourcePageId: normalizeNotionId(page.id),
            title,
            sourceUrl: safeNotionUrl(page.url, page.id),
            parentSourcePageId: queued.parentPageId,
            lastEditedAt: page.last_edited_time,
            breadcrumb,
            metadata,
            contentMarkdown: markdown,
          }),
        );
        collectChildren(
          trees,
          breadcrumb,
          page.id,
          pages,
          databases,
          queuedPages,
        );
      } catch (error) {
        if (queued.id === normalizedRoot) throw error;
        traversalComplete = false;
        const title = queued.titleHint ?? "Unreadable Notion page";
        failures.push({
          sourcePageId: queued.id,
          title,
          breadcrumb: [...queued.breadcrumb, title],
          parentSourcePageId: queued.parentPageId,
          sourceUrl: `https://www.notion.so/${queued.id.replaceAll("-", "")}`,
          errorCode:
            error instanceof SourceAdapterError ? error.code : "unavailable",
          errorMessage: safeDiscoveryMessage(error),
        });
      }
      continue;
    }

    const database = databases.shift();
    if (database === undefined || visitedDatabases.has(database.id)) continue;
    visitedDatabases.add(database.id);
    let value;
    try {
      value = await client.retrieveDatabase(database.id);
    } catch {
      traversalComplete = false;
      continue;
    }
    const databaseTitle = plainText(value.title) || "Untitled database";
    const databaseBreadcrumb = [...database.breadcrumb, databaseTitle];
    for (const dataSource of value.data_sources) {
      let entries;
      try {
        entries = await client.queryDataSource(dataSource.id);
      } catch {
        traversalComplete = false;
        continue;
      }
      for (const entry of entries) {
        if (entry.object === "page") {
          const parsed = pageSchema.parse(entry);
          const id = normalizeNotionId(parsed.id);
          if (!queuedPages.has(id) && !parsed.in_trash) {
            queuedPages.add(id);
            pages.push({
              id,
              breadcrumb: databaseBreadcrumb,
              parentPageId: database.parentPageId,
              titleHint: pageTitle(parsed),
            });
          }
        } else if (entry.object === "data_source") {
          const nestedId = typeof entry.id === "string" ? entry.id : null;
          if (nestedId !== null) {
            const nested = await client.queryDataSource(nestedId);
            for (const item of nested) {
              if (item.object !== "page") continue;
              const parsed = pageSchema.parse(item);
              const id = normalizeNotionId(parsed.id);
              if (!queuedPages.has(id) && !parsed.in_trash) {
                queuedPages.add(id);
                pages.push({
                  id,
                  breadcrumb: [...databaseBreadcrumb, dataSource.name],
                  parentPageId: database.parentPageId,
                  titleHint: pageTitle(parsed),
                });
              }
            }
          }
        }
      }
    }
  }

  return {
    documents,
    failures,
    complete: traversalComplete && pages.length === 0 && databases.length === 0,
  };
}

async function loadBlockTrees(
  client: NotionClient,
  blockId: string,
  count: { value: number },
): Promise<BlockTree[]> {
  const blocks = await client.listBlockChildren(blockId);
  const result: BlockTree[] = [];
  for (const block of blocks) {
    count.value += 1;
    if (count.value > 2_000) break;
    const structural =
      block.type === "child_page" || block.type === "child_database";
    const children =
      block.has_children && !structural
        ? await loadBlockTrees(client, block.id, count)
        : [];
    result.push({ ...block, children });
  }
  return result;
}

function collectChildren(
  trees: readonly BlockTree[],
  breadcrumb: string[],
  parentPageId: string,
  pages: QueuePage[],
  databases: QueueDatabase[],
  queuedPages: Set<string>,
) {
  for (const block of trees) {
    if (block.type === "child_page") {
      const id = normalizeNotionId(block.id);
      if (!queuedPages.has(id)) {
        queuedPages.add(id);
        const titleHint = asRecord(block.child_page).title;
        pages.push({
          id,
          breadcrumb,
          parentPageId: normalizeNotionId(parentPageId),
          ...(typeof titleHint === "string" ? { titleHint } : {}),
        });
      }
    } else if (block.type === "child_database") {
      databases.push({
        id: normalizeNotionId(block.id),
        breadcrumb,
        parentPageId: normalizeNotionId(parentPageId),
      });
    }
    collectChildren(
      block.children,
      breadcrumb,
      parentPageId,
      pages,
      databases,
      queuedPages,
    );
  }
}

export function normalizePageMarkdown(
  title: string,
  metadata: Record<string, string | number | boolean | null | string[]>,
  trees: readonly BlockTree[],
): string {
  const properties = Object.entries(metadata)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, value]) =>
        `- ${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
    );
  const body = trees
    .map((tree) => normalizeBlock(tree, 0))
    .filter(Boolean)
    .join("\n\n");
  return [
    `# ${title}`,
    properties.length > 0 ? `## Properties\n\n${properties.join("\n")}` : "",
    body,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function normalizeBlock(block: BlockTree, depth: number): string {
  if (
    block.in_trash ||
    block.type === "child_page" ||
    block.type === "child_database"
  )
    return "";
  const value = asRecord(block[block.type]);
  const text = richText(value.rich_text);
  const children = block.children
    .map((child) => normalizeBlock(child, depth + 1))
    .filter(Boolean)
    .join("\n");
  const indent = "  ".repeat(depth);
  let own = "";
  switch (block.type) {
    case "paragraph":
      own = text;
      break;
    case "heading_1":
      own = `# ${text}`;
      break;
    case "heading_2":
      own = `## ${text}`;
      break;
    case "heading_3":
    case "heading_4":
      own = `### ${text}`;
      break;
    case "bulleted_list_item":
      own = `${indent}- ${text}`;
      break;
    case "numbered_list_item":
      own = `${indent}1. ${text}`;
      break;
    case "to_do":
      own = `${indent}- [${value.checked === true ? "x" : " "}] ${text}`;
      break;
    case "toggle":
      own = `${indent}- ${text}`;
      break;
    case "quote":
      own = `> ${text}`;
      break;
    case "callout":
      own = `> ${text}`;
      break;
    case "code":
      own = `\`\`\`${typeof value.language === "string" ? value.language : ""}\n${text}\n\`\`\``;
      break;
    case "equation":
      own = typeof value.expression === "string" ? `$${value.expression}$` : "";
      break;
    case "divider":
      own = "---";
      break;
    case "table_row": {
      const cells = Array.isArray(value.cells)
        ? value.cells.map((cell) => richText(cell))
        : [];
      own = cells.length > 0 ? `| ${cells.join(" | ")} |` : "";
      break;
    }
    case "bookmark":
    case "embed":
    case "link_preview": {
      const url = typeof value.url === "string" ? value.url : "";
      const caption = richText(value.caption);
      own = caption ? `[${caption}](${url})` : url;
      break;
    }
    case "image":
    case "video":
    case "pdf":
    case "file":
    case "audio":
      own = richText(value.caption);
      break;
    case "column_list":
    case "column":
    case "table":
    case "synced_block":
      own = "";
      break;
    default:
      own = "";
  }
  return [own, children].filter(Boolean).join("\n");
}

function pageTitle(page: NotionPage): string {
  for (const property of Object.values(page.properties)) {
    const value = asRecord(property);
    if (value.type === "title") {
      const title = richText(value.title);
      if (title) return title;
    }
  }
  return "Untitled";
}

function pageMetadata(
  page: NotionPage,
): Record<string, string | number | boolean | null | string[]> {
  const output: Record<string, string | number | boolean | null | string[]> =
    {};
  for (const [name, raw] of Object.entries(page.properties)) {
    const value = asRecord(raw);
    switch (value.type) {
      case "title":
      case "rich_text":
        output[name] = richText(value[value.type]);
        break;
      case "number":
        output[name] = typeof value.number === "number" ? value.number : null;
        break;
      case "checkbox":
        output[name] = value.checkbox === true;
        break;
      case "url":
      case "email":
      case "phone_number":
      case "created_time":
      case "last_edited_time":
        output[name] =
          typeof value[value.type] === "string"
            ? (value[value.type] as string)
            : null;
        break;
      case "select":
      case "status":
        output[name] =
          typeof asRecord(value[value.type]).name === "string"
            ? (asRecord(value[value.type]).name as string)
            : null;
        break;
      case "multi_select":
        output[name] = Array.isArray(value.multi_select)
          ? value.multi_select
              .map((item) => asRecord(item).name)
              .filter((item): item is string => typeof item === "string")
          : [];
        break;
      case "date":
        output[name] =
          typeof asRecord(value.date).start === "string"
            ? (asRecord(value.date).start as string)
            : null;
        break;
      case "formula": {
        const formula = asRecord(value.formula);
        const formulaValue =
          formula[typeof formula.type === "string" ? formula.type : ""];
        if (
          ["string", "number", "boolean"].includes(typeof formulaValue) ||
          formulaValue === null
        )
          output[name] = formulaValue as string | number | boolean | null;
        break;
      }
    }
  }
  return output;
}

function richText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => asRecord(item).plain_text)
    .filter((item): item is string => typeof item === "string")
    .join("");
}

function plainText(value: z.infer<typeof richTextSchema>[]): string {
  return value
    .map((item) => item.plain_text)
    .join("")
    .trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function safeNotionUrl(value: string, pageId: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && notionPageHosts.has(url.hostname)) {
      return url.toString();
    }
  } catch {
    // A canonical URL is safer and more useful than failing an otherwise valid page.
  }
  return `https://www.notion.so/${normalizeNotionId(pageId).replaceAll("-", "")}`;
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  return Number(value);
}

function safeDiscoveryMessage(error: unknown): string {
  if (
    error instanceof SourceAdapterError &&
    (error.code === "access_denied" || error.code === "not_found")
  ) {
    return "This page is no longer accessible to the Notion connection.";
  }
  if (error instanceof SourceAdapterError && error.code === "invalid_data") {
    return error.message;
  }
  return "This page could not be read from Notion.";
}

export function normalizeNotionId(value: string): string {
  const compact = value.trim().replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(compact)) {
    throw new SourceAdapterError(
      "invalid_configuration",
      "The Notion root page ID is invalid.",
    );
  }
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}
