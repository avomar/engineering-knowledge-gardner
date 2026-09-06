-- Phase 4 is additive: existing placeholder drafts remain readable but cannot
-- be published until they have the ownership and provenance fields below.
ALTER TABLE drafts ADD COLUMN owner_session_id TEXT;
ALTER TABLE drafts ADD COLUMN source_message_id TEXT;
ALTER TABLE drafts ADD COLUMN generation_instruction TEXT;
ALTER TABLE drafts ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE drafts ADD COLUMN was_edited INTEGER NOT NULL DEFAULT 0 CHECK (was_edited IN (0, 1));
ALTER TABLE drafts ADD COLUMN publish_state TEXT NOT NULL DEFAULT 'idle'
  CHECK (publish_state IN ('idle', 'publishing', 'uncertain', 'failed', 'published'));
ALTER TABLE drafts ADD COLUMN publish_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (publish_attempt_count >= 0);
ALTER TABLE drafts ADD COLUMN publish_started_at TEXT;
ALTER TABLE drafts ADD COLUMN publish_lease_expires_at TEXT;
ALTER TABLE drafts ADD COLUMN last_error_code TEXT;
ALTER TABLE drafts ADD COLUMN last_error_message TEXT;

CREATE INDEX drafts_owner_space_updated_idx
  ON drafts(owner_session_id, knowledge_space_id, updated_at DESC);
CREATE INDEX drafts_publish_recovery_idx
  ON drafts(target_parent_id, publish_state, publish_lease_expires_at);
