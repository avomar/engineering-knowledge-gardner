import { jsonValueSchema, type JsonValue } from "@knowledge-gardener/domain";
import {
  SourceAdapterError,
  sourceDocumentSchema,
  sourcePageBatchSchema,
  type DiscoverPagesInput,
  type FetchPageInput,
  type SourceAdapter,
  type SourceDocument,
  type SourcePageReference,
} from "@knowledge-gardener/source";
import { z } from "zod";

import projectReadme from "../../../README.md";
import adr0001 from "../../../docs/adr/0001-foundation-architecture.md";
import adr0002 from "../../../docs/adr/0002-grounded-demo-chat-architecture.md";
import adr0003 from "../../../docs/adr/0003-live-notion-workflow-sync.md";
import adr0004 from "../../../docs/adr/0004-unified-worker-static-assets.md";
import adr0005 from "../../../docs/adr/0005-hybrid-retrieval-and-live-chat.md";
import adr0006 from "../../../docs/adr/0006-safe-notion-draft-publishing.md";
import adr0007 from "../../../docs/adr/0007-evidence-traceable-garden-findings.md";
import adr0008 from "../../../docs/adr/0008-public-demo-and-live-security-boundaries.md";
import adr0009 from "../../../docs/adr/0009-public-project-documentation-demo-corpus.md";

const publicDemoDocumentSchema = z.object({
  sourcePageId: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  sourceUrl: z.string().url(),
  parentSourcePageId: z.string().trim().min(1).max(500).nullable(),
  lastEditedAt: z.string().datetime({ offset: true }),
  metadata: z.record(z.string(), jsonValueSchema),
  contentMarkdown: z.string().trim().min(1).max(250_000),
});

const publicDemoManifestSchema = z.object({
  rootId: z.string().trim().min(1).max(500),
  rootTitle: z.string().trim().min(1).max(500),
  documents: z
    .array(publicDemoDocumentSchema)
    .min(1)
    .max(20)
    .superRefine((documents, context) => {
      const seen = new Set<string>();
      for (const [index, document] of documents.entries()) {
        if (seen.has(document.sourcePageId)) {
          context.addIssue({
            code: "custom",
            message: "Public demo source page IDs must be unique.",
            path: [index, "sourcePageId"],
          });
        }
        seen.add(document.sourcePageId);
      }
    }),
});

export type PublicDemoManifest = z.infer<typeof publicDemoManifestSchema>;

const publicReadmeSections = {
  overview: extractReadme({
    title: "README: Product and architecture",
    headings: ["Architecture", "Repository layout"],
    includePreamble: true,
  }),
  use: extractReadme({
    title: "README: Demo use and API",
    headings: ["Data and fixtures", "Using the demo", "API"],
  }),
  operations: extractReadme({
    title: "README: Configuration, deployment, and operations",
    headings: [
      "Configuration and bindings",
      "Deployment",
      "Trade-offs",
      "Roadmap",
      "Security, privacy, and operating limits",
      "Cost posture",
      "Evaluation status",
    ],
  }),
} as const;

const reviewedAt = "2026-09-07T00:00:00.000Z";

export const publicDemoManifest = publicDemoManifestSchema.parse({
  rootId: "engineering-knowledge-gardener-public-docs",
  rootTitle: "Engineering Knowledge Gardener public documentation",
  documents: [
    {
      sourcePageId: "readme-product-and-architecture",
      title: "README: Product and architecture",
      sourceUrl: "demo://project/readme/product-and-architecture",
      parentSourcePageId: null,
      lastEditedAt: reviewedAt,
      metadata: { status: "current", tags: ["project", "architecture"] },
      contentMarkdown: publicReadmeSections.overview,
    },
    {
      sourcePageId: "readme-demo-and-api",
      title: "README: Demo use and API",
      sourceUrl: "demo://project/readme/demo-and-api",
      parentSourcePageId: null,
      lastEditedAt: reviewedAt,
      metadata: { status: "current", tags: ["demo", "api", "usage"] },
      contentMarkdown: publicReadmeSections.use,
    },
    {
      sourcePageId: "readme-deployment-and-operations",
      title: "README: Configuration, deployment, and operations",
      sourceUrl: "demo://project/readme/deployment-and-operations",
      parentSourcePageId: null,
      lastEditedAt: reviewedAt,
      metadata: {
        status: "current",
        tags: ["deployment", "security", "operations"],
      },
      contentMarkdown: publicReadmeSections.operations,
    },
    adrDocument("adr-0001-foundation-architecture", adr0001),
    adrDocument("adr-0002-grounded-demo-chat", adr0002),
    adrDocument("adr-0003-live-notion-sync", adr0003),
    adrDocument("adr-0004-unified-worker-assets", adr0004),
    adrDocument("adr-0005-hybrid-retrieval", adr0005),
    adrDocument("adr-0006-safe-draft-publishing", adr0006),
    adrDocument("adr-0007-garden-findings", adr0007),
    adrDocument("adr-0008-demo-live-boundaries", adr0008),
    adrDocument("adr-0009-public-project-docs", adr0009),
  ],
});

function adrDocument(sourcePageId: string, contentMarkdown: string) {
  const title = contentMarkdown.split("\n", 1)[0]?.replace(/^#\s+/u, "").trim();
  if (!title) throw new Error(`ADR ${sourcePageId} has no Markdown title.`);
  return {
    sourcePageId,
    title,
    sourceUrl: `demo://project/${sourcePageId}`,
    parentSourcePageId: null,
    lastEditedAt: reviewedAt,
    metadata: { status: "accepted", tags: ["adr", "architecture"] },
    contentMarkdown,
  };
}

function extractReadme({
  title,
  headings,
  includePreamble = false,
}: {
  title: string;
  headings: readonly string[];
  includePreamble?: boolean;
}): string {
  const sections = headings.map((heading) => readmeSection(heading));
  const preamble = includePreamble
    ? projectReadme.slice(0, projectReadme.indexOf("## Architecture")).trim()
    : "";
  return [title, preamble, ...sections].filter(Boolean).join("\n\n");
}

function readmeSection(heading: string): string {
  const marker = `## ${heading}`;
  const start = projectReadme.indexOf(marker);
  if (start < 0) throw new Error(`README section "${heading}" is missing.`);
  const nextHeading = projectReadme.indexOf("\n## ", start + marker.length);
  return projectReadme
    .slice(start, nextHeading < 0 ? undefined : nextHeading)
    .trim();
}

function parseCursor(cursor: string | undefined, length: number): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/u.test(cursor)) {
    throw new SourceAdapterError(
      "invalid_configuration",
      "Invalid public-demo cursor.",
    );
  }
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) {
    throw new SourceAdapterError(
      "invalid_configuration",
      "Invalid public-demo cursor.",
    );
  }
  return offset;
}

function assertRoot(rootId: string): void {
  if (rootId !== publicDemoManifest.rootId) {
    throw new SourceAdapterError(
      "access_denied",
      "The requested public-demo root is not allowed.",
    );
  }
}

function toReference(
  document: PublicDemoManifest["documents"][number],
): SourcePageReference {
  return {
    sourceType: "fixture",
    sourcePageId: document.sourcePageId,
    title: document.title,
    sourceUrl: document.sourceUrl,
    parentSourcePageId: document.parentSourcePageId,
    lastEditedAt: document.lastEditedAt,
    breadcrumb: [publicDemoManifest.rootTitle, document.title],
    metadata: document.metadata as Record<string, JsonValue>,
  };
}

export class PublicDemoSourceAdapter implements SourceAdapter {
  readonly sourceType = "fixture" as const;

  async discoverPages({
    rootId,
    cursor,
    pageSize,
  }: DiscoverPagesInput): Promise<
    ReturnType<typeof sourcePageBatchSchema.parse>
  > {
    assertRoot(rootId);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new SourceAdapterError(
        "invalid_configuration",
        "Public-demo page size must be between 1 and 100.",
      );
    }
    const offset = parseCursor(cursor, publicDemoManifest.documents.length);
    const end = Math.min(
      offset + pageSize,
      publicDemoManifest.documents.length,
    );
    return sourcePageBatchSchema.parse({
      pages: publicDemoManifest.documents.slice(offset, end).map(toReference),
      nextCursor:
        end < publicDemoManifest.documents.length ? String(end) : null,
    });
  }

  async fetchPage({ rootId, pageId }: FetchPageInput): Promise<SourceDocument> {
    assertRoot(rootId);
    const document = publicDemoManifest.documents.find(
      (candidate) => candidate.sourcePageId === pageId,
    );
    if (document === undefined) {
      throw new SourceAdapterError(
        "not_found",
        "Public-demo page was not found.",
      );
    }
    return sourceDocumentSchema.parse({
      ...toReference(document),
      contentMarkdown: document.contentMarkdown,
    });
  }
}
