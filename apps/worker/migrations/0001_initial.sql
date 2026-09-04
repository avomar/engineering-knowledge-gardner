PRAGMA foreign_keys = ON;

CREATE TABLE knowledge_spaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('fixture', 'notion')),
  source_root_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('demo', 'live')),
  last_successful_sync_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_type, source_root_id)
) STRICT;

CREATE TABLE documents (
  id TEXT PRIMARY KEY NOT NULL,
  knowledge_space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
  source_page_id TEXT NOT NULL,
  source_url TEXT,
  parent_source_page_id TEXT,
  title TEXT NOT NULL,
  breadcrumb_json TEXT NOT NULL DEFAULT '[]',
  last_edited_at TEXT NOT NULL,
  checksum TEXT NOT NULL,
  index_status TEXT NOT NULL CHECK (index_status IN ('pending', 'indexed', 'failed', 'stale')),
  last_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (knowledge_space_id, source_page_id)
) STRICT;

CREATE INDEX documents_knowledge_space_idx ON documents(knowledge_space_id);
CREATE INDEX documents_status_idx ON documents(knowledge_space_id, index_status);
CREATE INDEX documents_last_edited_idx ON documents(knowledge_space_id, last_edited_at DESC);

CREATE TABLE document_chunks (
  id TEXT PRIMARY KEY NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  content TEXT NOT NULL,
  token_count INTEGER NOT NULL CHECK (token_count >= 0),
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (document_id, ordinal)
) STRICT;

CREATE INDEX document_chunks_document_idx ON document_chunks(document_id, ordinal);

CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY NOT NULL,
  knowledge_space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
  workflow_instance_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed')),
  started_at TEXT,
  completed_at TEXT,
  discovered_count INTEGER NOT NULL DEFAULT 0 CHECK (discovered_count >= 0),
  indexed_count INTEGER NOT NULL DEFAULT 0 CHECK (indexed_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  error_summary TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX sync_runs_knowledge_space_started_idx ON sync_runs(knowledge_space_id, started_at DESC);
CREATE INDEX sync_runs_status_idx ON sync_runs(knowledge_space_id, status);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY NOT NULL,
  knowledge_space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
  owner_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX conversations_session_idx ON conversations(owner_session_id, updated_at DESC);
CREATE INDEX conversations_knowledge_space_idx ON conversations(knowledge_space_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  citation_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX messages_conversation_created_idx ON messages(conversation_id, created_at);

CREATE TABLE drafts (
  id TEXT PRIMARY KEY NOT NULL,
  knowledge_space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content_markdown TEXT NOT NULL CHECK (length(content_markdown) <= 20000),
  source_json TEXT NOT NULL DEFAULT '[]',
  assumptions_json TEXT NOT NULL DEFAULT '[]',
  target_parent_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'discarded', 'failed')),
  idempotency_key TEXT UNIQUE,
  notion_page_id TEXT,
  notion_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
) STRICT;

CREATE INDEX drafts_knowledge_space_status_idx ON drafts(knowledge_space_id, status, updated_at DESC);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  knowledge_space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX audit_events_resource_idx ON audit_events(resource_type, resource_id, created_at DESC);
CREATE INDEX audit_events_knowledge_space_idx ON audit_events(knowledge_space_id, created_at DESC);

CREATE TABLE feedback (
  id TEXT PRIMARY KEY NOT NULL,
  message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
  draft_id TEXT REFERENCES drafts(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
  correction TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (message_id IS NOT NULL AND draft_id IS NULL)
    OR (message_id IS NULL AND draft_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX feedback_message_idx ON feedback(message_id, created_at DESC);
CREATE INDEX feedback_draft_idx ON feedback(draft_id, created_at DESC);
