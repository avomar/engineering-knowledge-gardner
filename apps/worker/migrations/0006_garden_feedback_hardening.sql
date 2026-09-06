CREATE TABLE garden_scans (
  id TEXT PRIMARY KEY NOT NULL,
  knowledge_space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
  owner_scope_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  ai_status TEXT NOT NULL CHECK (ai_status IN ('not_requested', 'completed', 'degraded')),
  policy_json TEXT NOT NULL,
  finding_count INTEGER NOT NULL DEFAULT 0 CHECK (finding_count >= 0),
  ai_enriched_count INTEGER NOT NULL DEFAULT 0 CHECK (ai_enriched_count >= 0),
  error_code TEXT,
  lease_expires_at TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX garden_scans_one_running_idx
ON garden_scans(knowledge_space_id, owner_scope_id)
WHERE status = 'running';

CREATE INDEX garden_scans_owner_created_idx
ON garden_scans(knowledge_space_id, owner_scope_id, created_at DESC);

CREATE TABLE garden_findings (
  id TEXT PRIMARY KEY NOT NULL,
  knowledge_space_id TEXT NOT NULL REFERENCES knowledge_spaces(id) ON DELETE CASCADE,
  owner_scope_id TEXT NOT NULL,
  last_scan_id TEXT NOT NULL REFERENCES garden_scans(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('stale_document', 'missing_metadata', 'title_collision', 'obsolete_keyword')),
  severity TEXT NOT NULL CHECK (severity IN ('high', 'medium', 'low')),
  status TEXT NOT NULL CHECK (status IN ('open', 'dismissed', 'resolved')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  recommendation TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  ai_enriched INTEGER NOT NULL DEFAULT 0 CHECK (ai_enriched IN (0, 1)),
  first_detected_at TEXT NOT NULL,
  last_detected_at TEXT NOT NULL,
  dismissed_at TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (knowledge_space_id, owner_scope_id, fingerprint)
) STRICT;

CREATE INDEX garden_findings_filter_idx
ON garden_findings(knowledge_space_id, owner_scope_id, status, signal_type, severity, updated_at DESC);

ALTER TABLE feedback ADD COLUMN owner_session_id TEXT;
ALTER TABLE feedback ADD COLUMN updated_at TEXT;

CREATE UNIQUE INDEX feedback_owner_message_idx
ON feedback(owner_session_id, message_id)
WHERE owner_session_id IS NOT NULL AND message_id IS NOT NULL;

CREATE UNIQUE INDEX feedback_owner_draft_idx
ON feedback(owner_session_id, draft_id)
WHERE owner_session_id IS NOT NULL AND draft_id IS NOT NULL;
