-- Migration: playbook_audit table
-- Purpose: audit log for every POST/PUT on /api/playbooks.
--          Enables investigation of prompt injection attempts and accidental edits.
-- Safe to run multiple times (CREATE TABLE IF NOT EXISTS).
-- Run in Supabase SQL Editor before deploying Brain with Zod playbook validation.

CREATE TABLE IF NOT EXISTS playbook_audit (
    id          BIGSERIAL PRIMARY KEY,
    playbook_id TEXT        NOT NULL,       -- content_playbooks.key
    action      TEXT        NOT NULL,       -- 'create' | 'update'
    old_value   JSONB,                      -- previous state (null on create)
    new_value   JSONB       NOT NULL,       -- new state written
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for per-playbook history lookups
CREATE INDEX IF NOT EXISTS playbook_audit_playbook_id_idx
    ON playbook_audit (playbook_id, created_at DESC);

-- Supabase RLS: only service-role key can read/write audit log.
-- Row-level reads for this table are not needed by the app — only write.
ALTER TABLE playbook_audit ENABLE ROW LEVEL SECURITY;

-- Allow INSERT from service role (the backend uses service role key).
-- SELECT is blocked by default for anon/authenticated — intentional.
CREATE POLICY "service_role_insert_audit"
    ON playbook_audit
    FOR INSERT
    TO service_role
    WITH CHECK (true);

CREATE POLICY "service_role_select_audit"
    ON playbook_audit
    FOR SELECT
    TO service_role
    USING (true);
