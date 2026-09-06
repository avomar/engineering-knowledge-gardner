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

import manifestJson from "../manifest.json";
import connectionIncident from "../documents/connection-incident.md";
import localSetup from "../documents/local-setup.md";
import storageAdr from "../documents/storage-adr.md";
import workerDeployRunbook from "../documents/worker-deploy-runbook.md";

export {
  PublicDemoSourceAdapter,
  publicDemoManifest,
  type PublicDemoManifest,
} from "./public-demo";

const fixtureDocumentMetadataSchema = z.object({
  sourcePageId: z.string().trim().min(1).max(500),
  title: z.string().trim().min(1).max(500),
  sourceUrl: z.string().url(),
  parentSourcePageId: z.string().trim().min(1).max(500).nullable(),
  lastEditedAt: z.string().datetime({ offset: true }),
  filename: z.string().regex(/^[a-z0-9-]+\.md$/),
  metadata: z.record(z.string(), jsonValueSchema),
});

const fixtureManifestSchema = z.object({
  rootId: z.string().trim().min(1).max(500),
  rootTitle: z.string().trim().min(1).max(500),
  documents: z.array(fixtureDocumentMetadataSchema).length(4),
});

export type FixtureManifest = z.infer<typeof fixtureManifestSchema>;

export const fixtureManifest = fixtureManifestSchema.parse(manifestJson);

const contentByFilename: Readonly<Record<string, string>> = {
  "connection-incident.md": connectionIncident,
  "local-setup.md": localSetup,
  "storage-adr.md": storageAdr,
  "worker-deploy-runbook.md": workerDeployRunbook,
};

function parseCursor(cursor: string | undefined, length: number): number {
  if (cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) {
    throw new SourceAdapterError(
      "invalid_configuration",
      "Invalid fixture cursor.",
    );
  }

  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > length) {
    throw new SourceAdapterError(
      "invalid_configuration",
      "Invalid fixture cursor.",
    );
  }
  return offset;
}

function assertRoot(rootId: string): void {
  if (rootId !== fixtureManifest.rootId) {
    throw new SourceAdapterError(
      "access_denied",
      "The requested fixture root is not allowed.",
    );
  }
}

function toReference(
  document: FixtureManifest["documents"][number],
): SourcePageReference {
  return {
    sourceType: "fixture",
    sourcePageId: document.sourcePageId,
    title: document.title,
    sourceUrl: document.sourceUrl,
    parentSourcePageId: document.parentSourcePageId,
    lastEditedAt: document.lastEditedAt,
    breadcrumb: [fixtureManifest.rootTitle, document.title],
    metadata: document.metadata as Record<string, JsonValue>,
  };
}

export class FixtureSourceAdapter implements SourceAdapter {
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
        "Fixture page size must be between 1 and 100.",
      );
    }

    const offset = parseCursor(cursor, fixtureManifest.documents.length);
    const end = Math.min(offset + pageSize, fixtureManifest.documents.length);
    const pages = fixtureManifest.documents.slice(offset, end).map(toReference);

    return sourcePageBatchSchema.parse({
      pages,
      nextCursor: end < fixtureManifest.documents.length ? String(end) : null,
    });
  }

  async fetchPage({ rootId, pageId }: FetchPageInput): Promise<SourceDocument> {
    assertRoot(rootId);
    const metadata = fixtureManifest.documents.find(
      (document) => document.sourcePageId === pageId,
    );
    if (metadata === undefined) {
      throw new SourceAdapterError("not_found", "Fixture page was not found.");
    }

    const contentMarkdown = contentByFilename[metadata.filename];
    if (contentMarkdown === undefined || contentMarkdown.trim() === "") {
      throw new SourceAdapterError(
        "invalid_data",
        "Fixture content is unavailable.",
      );
    }

    return sourceDocumentSchema.parse({
      ...toReference(metadata),
      contentMarkdown,
    });
  }
}
