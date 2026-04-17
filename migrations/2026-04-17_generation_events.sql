-- Migration: 2026-04-17_generation_events.sql
--
-- Adds an audit trail for every AI generation call (classification, copy,
-- image) so the Dashboard Workflow view can show "what prompt was sent to
-- which model, and what came back" for any article.
--
-- Previously this data lived only in Pino logs on Railway, which rotate out
-- after a few days and are not queryable from the Dashboard.
--
-- Write pattern:
--   Brain inserts one row per external-AI call it orchestrates.
--   Kind values:
--     'classify'       — Brain → OpenAI gpt-4o-mini (relevance score)
--     'copy'           — Generator → OpenAI gpt-4o-mini (headline/caption/hashtags)
--     'image_prompt'   — Generator → Gemini (image generation)
--     'caption_regen'  — Generator → OpenAI (second pass with forced new angle)
--
-- Read pattern:
--   Dashboard queries WHERE article_id = $1 ORDER BY created_at ASC
--   to reconstruct the full chain of calls for one article.
--
-- Retention: no auto-cleanup in this migration. When the table gets large
-- (est. >1M rows), add a pg_cron job: DELETE WHERE created_at < now() - '90 days'.

CREATE TABLE IF NOT EXISTS generation_events (
    id           bigserial PRIMARY KEY,
    article_id   bigint       NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
    kind         text         NOT NULL CHECK (kind IN ('classify', 'copy', 'image_prompt', 'caption_regen')),
    provider     text         NOT NULL,  -- 'openai', 'gemini', 'cloudinary'
    model        text,                   -- 'gpt-4o-mini', 'gemini-3-pro-image-preview', etc.
    prompt       jsonb        NOT NULL,  -- { system, user } or { prompt, angle, temperature }
    response     jsonb,                  -- full parsed model response (null on error)
    outcome      text         NOT NULL CHECK (outcome IN ('ok', 'error', 'fallback')),
    error        text,                   -- populated when outcome='error' or 'fallback'
    latency_ms   int,
    created_at   timestamptz  NOT NULL DEFAULT now()
);

-- Primary access pattern: fetch everything for one article, newest first.
CREATE INDEX IF NOT EXISTS generation_events_article_idx
    ON generation_events (article_id, created_at DESC);

-- Secondary: debugging / ops — find recent errors by provider.
CREATE INDEX IF NOT EXISTS generation_events_errors_idx
    ON generation_events (provider, created_at DESC)
    WHERE outcome != 'ok';
