import {
  documentChunkSchema,
  documentSchema,
  knowledgeSpaceSchema,
  type Document,
  type DocumentChunk,
  type KnowledgeSpace,
} from "@knowledge-gardener/domain";

interface KnowledgeSpaceRow {
  id: string;
  name: string;
  source_type: string;
  source_root_id: string;
  mode: string;
  last_successful_sync_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DocumentRow {
  id: string;
  knowledge_space_id: string;
  source_page_id: string;
  source_url: string | null;
  parent_source_page_id: string | null;
  title: string;
  breadcrumb_json: string;
  last_edited_at: string;
  checksum: string;
  index_status: string;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DocumentChunkRow {
  id: string;
  document_id: string;
  ordinal: number;
  content: string;
  token_count: number;
  checksum: string;
  created_at: string;
}

function assertWrite(result: D1Result): void {
  if (!result.success) throw new Error("D1 write failed.");
}

function mapKnowledgeSpace(row: KnowledgeSpaceRow): KnowledgeSpace {
  return knowledgeSpaceSchema.parse({
    id: row.id,
    name: row.name,
    sourceType: row.source_type,
    sourceRootId: row.source_root_id,
    mode: row.mode,
    lastSuccessfulSyncAt: row.last_successful_sync_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapDocument(row: DocumentRow): Document {
  return documentSchema.parse({
    id: row.id,
    knowledgeSpaceId: row.knowledge_space_id,
    sourcePageId: row.source_page_id,
    sourceUrl: row.source_url,
    parentSourcePageId: row.parent_source_page_id,
    title: row.title,
    breadcrumb: JSON.parse(row.breadcrumb_json) as unknown,
    lastEditedAt: row.last_edited_at,
    checksum: row.checksum,
    indexStatus: row.index_status,
    lastSyncedAt: row.last_synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapChunk(row: DocumentChunkRow): DocumentChunk {
  return documentChunkSchema.parse({
    id: row.id,
    documentId: row.document_id,
    ordinal: row.ordinal,
    content: row.content,
    tokenCount: row.token_count,
    checksum: row.checksum,
    createdAt: row.created_at,
  });
}

export class KnowledgeSpaceRepository {
  constructor(private readonly database: D1Database) {}

  async create(value: KnowledgeSpace): Promise<void> {
    const record = knowledgeSpaceSchema.parse(value);
    const result = await this.database
      .prepare(
        `INSERT INTO knowledge_spaces (
          id, name, source_type, source_root_id, mode,
          last_successful_sync_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.name,
        record.sourceType,
        record.sourceRootId,
        record.mode,
        record.lastSuccessfulSyncAt,
        record.createdAt,
        record.updatedAt,
      )
      .run();
    assertWrite(result);
  }

  async findById(id: string): Promise<KnowledgeSpace | null> {
    const row = await this.database
      .prepare("SELECT * FROM knowledge_spaces WHERE id = ?")
      .bind(id)
      .first<KnowledgeSpaceRow>();
    return row === null ? null : mapKnowledgeSpace(row);
  }
}

export class DocumentRepository {
  constructor(private readonly database: D1Database) {}

  async create(value: Document): Promise<void> {
    const record = documentSchema.parse(value);
    const result = await this.database
      .prepare(
        `INSERT INTO documents (
          id, knowledge_space_id, source_page_id, source_url,
          parent_source_page_id, title, breadcrumb_json, last_edited_at,
          checksum, index_status, last_synced_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.knowledgeSpaceId,
        record.sourcePageId,
        record.sourceUrl,
        record.parentSourcePageId,
        record.title,
        JSON.stringify(record.breadcrumb),
        record.lastEditedAt,
        record.checksum,
        record.indexStatus,
        record.lastSyncedAt,
        record.createdAt,
        record.updatedAt,
      )
      .run();
    assertWrite(result);
  }

  async findById(id: string): Promise<Document | null> {
    const row = await this.database
      .prepare("SELECT * FROM documents WHERE id = ?")
      .bind(id)
      .first<DocumentRow>();
    return row === null ? null : mapDocument(row);
  }
}

export class DocumentChunkRepository {
  constructor(private readonly database: D1Database) {}

  async replaceForDocument(
    documentId: string,
    values: readonly DocumentChunk[],
  ): Promise<void> {
    const records = values.map((value) => documentChunkSchema.parse(value));
    if (records.some((record) => record.documentId !== documentId)) {
      throw new Error("Every chunk must belong to the requested document.");
    }

    const statements = [
      this.database
        .prepare("DELETE FROM document_chunks WHERE document_id = ?")
        .bind(documentId),
      ...records.map((record) =>
        this.database
          .prepare(
            `INSERT INTO document_chunks (
              id, document_id, ordinal, content, token_count, checksum, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            record.id,
            record.documentId,
            record.ordinal,
            record.content,
            record.tokenCount,
            record.checksum,
            record.createdAt,
          ),
      ),
    ];

    const results = await this.database.batch(statements);
    for (const result of results) assertWrite(result);
  }

  async listByDocument(documentId: string): Promise<DocumentChunk[]> {
    const result = await this.database
      .prepare(
        "SELECT * FROM document_chunks WHERE document_id = ? ORDER BY ordinal",
      )
      .bind(documentId)
      .all<DocumentChunkRow>();
    return result.results.map(mapChunk);
  }
}
