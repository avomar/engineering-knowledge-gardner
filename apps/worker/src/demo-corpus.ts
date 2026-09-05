import {
  FixtureSourceAdapter,
  fixtureManifest,
} from "@knowledge-gardener/fixtures";

export const DEMO_SPACE_ID = "10000000-0000-4000-8000-000000000001";

const identifiers: Readonly<
  Record<string, { documentId: string; chunkId: string }>
> = {
  "connection-incident": {
    documentId: "10000000-0000-4000-8000-000000000101",
    chunkId: "10000000-0000-4000-8000-000000000201",
  },
  "local-setup": {
    documentId: "10000000-0000-4000-8000-000000000102",
    chunkId: "10000000-0000-4000-8000-000000000202",
  },
  "storage-adr": {
    documentId: "10000000-0000-4000-8000-000000000103",
    chunkId: "10000000-0000-4000-8000-000000000203",
  },
  "worker-deploy-runbook": {
    documentId: "10000000-0000-4000-8000-000000000104",
    chunkId: "10000000-0000-4000-8000-000000000204",
  },
};

interface ExistingDocumentRow {
  id: string;
  document_checksum: string;
  chunk_id: string | null;
  chunk_checksum: string | null;
}

interface KnowledgeSpaceRow {
  id: string;
  name: string;
  mode: string;
}

export class DemoCorpusService {
  private readonly adapter = new FixtureSourceAdapter();

  constructor(
    private readonly database: D1Database,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async ensureReady(): Promise<string> {
    const timestamp = this.now();
    let space = await this.database
      .prepare(
        `SELECT id, name, mode FROM knowledge_spaces
         WHERE source_type = 'fixture' AND source_root_id = ?`,
      )
      .bind(fixtureManifest.rootId)
      .first<KnowledgeSpaceRow>();
    if (space === null) {
      const spaceWrite = await this.database
        .prepare(
          `INSERT INTO knowledge_spaces (
            id, name, source_type, source_root_id, mode,
            last_successful_sync_at, created_at, updated_at
          ) VALUES (?, ?, 'fixture', ?, 'demo', NULL, ?, ?)
          ON CONFLICT(source_type, source_root_id) DO NOTHING`,
        )
        .bind(
          DEMO_SPACE_ID,
          "Demo Engineering Knowledge",
          fixtureManifest.rootId,
          timestamp,
          timestamp,
        )
        .run();
      assertWrite(spaceWrite);
      space = await this.database
        .prepare(
          `SELECT id, name, mode FROM knowledge_spaces
           WHERE source_type = 'fixture' AND source_root_id = ?`,
        )
        .bind(fixtureManifest.rootId)
        .first<KnowledgeSpaceRow>();
    } else if (
      space.name !== "Demo Engineering Knowledge" ||
      space.mode !== "demo"
    ) {
      const spaceWrite = await this.database
        .prepare(
          `UPDATE knowledge_spaces
           SET name = ?, mode = 'demo', updated_at = ?
           WHERE id = ?`,
        )
        .bind("Demo Engineering Knowledge", timestamp, space.id)
        .run();
      assertWrite(spaceWrite);
    }
    if (space === null) throw new Error("Demo knowledge space is unavailable.");

    for (const page of fixtureManifest.documents) {
      const stableIds = identifiers[page.sourcePageId];
      if (stableIds === undefined) {
        throw new Error("A fixture is missing stable identifiers.");
      }
      const source = await this.adapter.fetchPage({
        rootId: fixtureManifest.rootId,
        pageId: page.sourcePageId,
      });
      const documentChecksum = await checksum(
        JSON.stringify({
          title: source.title,
          breadcrumb: source.breadcrumb,
          content: source.contentMarkdown,
        }),
      );
      const chunkChecksum = await checksum(source.contentMarkdown);
      const existing = await this.database
        .prepare(
          `SELECT d.id, d.checksum AS document_checksum,
                  c.id AS chunk_id, c.checksum AS chunk_checksum
           FROM documents d
           LEFT JOIN document_chunks c
             ON c.document_id = d.id AND c.ordinal = 0
           WHERE d.knowledge_space_id = ? AND d.source_page_id = ?`,
        )
        .bind(space.id, source.sourcePageId)
        .first<ExistingDocumentRow>();

      if (
        existing?.document_checksum === documentChecksum &&
        existing.chunk_checksum === chunkChecksum
      ) {
        continue;
      }

      const documentId = existing?.id ?? stableIds.documentId;
      const chunkId = existing?.chunk_id ?? stableIds.chunkId;
      const statements = [
        this.database
          .prepare(
            `INSERT INTO documents (
              id, knowledge_space_id, source_page_id, source_url,
              parent_source_page_id, title, breadcrumb_json, last_edited_at,
              checksum, index_status, last_synced_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'indexed', ?, ?, ?)
            ON CONFLICT(knowledge_space_id, source_page_id) DO UPDATE SET
              source_url = excluded.source_url,
              parent_source_page_id = excluded.parent_source_page_id,
              title = excluded.title,
              breadcrumb_json = excluded.breadcrumb_json,
              last_edited_at = excluded.last_edited_at,
              checksum = excluded.checksum,
              index_status = 'indexed',
              last_synced_at = excluded.last_synced_at,
              updated_at = excluded.updated_at`,
          )
          .bind(
            documentId,
            space.id,
            source.sourcePageId,
            source.sourceUrl,
            source.parentSourcePageId,
            source.title,
            JSON.stringify(source.breadcrumb),
            source.lastEditedAt,
            documentChecksum,
            timestamp,
            timestamp,
            timestamp,
          ),
        this.database
          .prepare("DELETE FROM document_chunks WHERE document_id = ?")
          .bind(documentId),
        this.database
          .prepare(
            `INSERT INTO document_chunks (
              id, document_id, ordinal, content, token_count, checksum, created_at
            ) VALUES (?, ?, 0, ?, ?, ?, ?)`,
          )
          .bind(
            chunkId,
            documentId,
            source.contentMarkdown,
            estimateTokens(source.contentMarkdown),
            chunkChecksum,
            timestamp,
          ),
      ];
      const results = await this.database.batch(statements);
      for (const result of results) assertWrite(result);
    }

    return space.id;
  }
}

function estimateTokens(content: string): number {
  return content.trim().split(/\s+/u).length;
}

async function checksum(content: string): Promise<string> {
  const input = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function assertWrite(result: D1Result): void {
  if (!result.success) throw new Error("D1 write failed.");
}
