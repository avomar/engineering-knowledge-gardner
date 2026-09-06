-- Phase 3 keeps D1 authoritative. Vectorize only holds opaque chunk IDs and
-- short-lived query acceleration data.
ALTER TABLE documents ADD COLUMN chunking_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE document_chunks ADD COLUMN embedding_model TEXT;
ALTER TABLE document_chunks ADD COLUMN embedding_version TEXT;
ALTER TABLE document_chunks ADD COLUMN vector_upserted_at TEXT;

ALTER TABLE sync_runs ADD COLUMN embedded_chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (embedded_chunk_count >= 0);

CREATE TABLE vector_deletion_queue (
  knowledge_space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
  vector_id TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at TEXT,
  last_error_code TEXT,
  PRIMARY KEY (knowledge_space_id, vector_id)
) STRICT;

CREATE INDEX document_chunks_embedding_idx
ON document_chunks(embedding_version, document_id, ordinal);

CREATE INDEX vector_deletion_queue_pending_idx
ON vector_deletion_queue(knowledge_space_id, enqueued_at);

-- A content-only FTS table deliberately contains no source metadata. The
-- application always hydrates hits from authoritative D1 rows before use.
CREATE VIRTUAL TABLE document_chunks_fts USING fts5(content, tokenize = 'unicode61');

INSERT INTO document_chunks_fts(rowid, content)
SELECT rowid, content FROM document_chunks;
