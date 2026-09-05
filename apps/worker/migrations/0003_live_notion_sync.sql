ALTER TABLE documents ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE documents ADD COLUMN last_sync_error_code TEXT;
ALTER TABLE documents ADD COLUMN last_sync_error_message TEXT;

ALTER TABLE sync_runs ADD COLUMN deleted_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_count >= 0);
ALTER TABLE sync_runs ADD COLUMN error_code TEXT;
ALTER TABLE sync_runs ADD COLUMN discovery_complete INTEGER NOT NULL DEFAULT 0 CHECK (discovery_complete IN (0, 1));

CREATE UNIQUE INDEX sync_runs_one_active_idx
ON sync_runs(knowledge_space_id)
WHERE status IN ('queued', 'running');

CREATE TABLE sync_run_documents (
  id TEXT PRIMARY KEY NOT NULL,
  sync_run_id TEXT NOT NULL REFERENCES sync_runs(id) ON DELETE CASCADE,
  document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  source_page_id TEXT NOT NULL,
  title TEXT NOT NULL,
  source_url TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('indexed', 'skipped', 'failed', 'deleted')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(sync_run_id, source_page_id)
) STRICT;

CREATE INDEX sync_run_documents_run_idx
ON sync_run_documents(sync_run_id, outcome, created_at);

CREATE INDEX documents_browse_idx
ON documents(knowledge_space_id, updated_at DESC, id);
