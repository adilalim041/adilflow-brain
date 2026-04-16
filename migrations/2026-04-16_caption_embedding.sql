-- ═══════════════════════════════════════
-- Migration: caption_embedding
-- Date: 2026-04-16
-- Purpose: Cross-channel caption deduplication via semantic similarity.
--   When 12 ECHO channels post on overlapping topics (e.g. Apple news in
--   ai_news + technology) the captions can be nearly identical → Instagram
--   spam detection → cascade-ban risk. Storing caption embeddings allows
--   pre-publish similarity checks across all niches in a single RPC call.
--
-- Safe to run: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- The IVFFlat index build will warn "lists=50 is more than the number of
-- rows" when the table has <2500 rows — this is benign, the index still
-- works. Re-create with higher lists= after reaching 10k+ published rows.
-- ═══════════════════════════════════════

-- Extension is already enabled in schema.sql but guard idempotency.
CREATE EXTENSION IF NOT EXISTS vector;

-- Add caption_embedding column (same 384-dim model as existing embedding).
ALTER TABLE articles ADD COLUMN IF NOT EXISTS caption_embedding vector(384);

-- IVFFlat index for fast cosine-similarity search on published captions.
-- lists=50 is tuned for 600-5000 rows; revisit at >10k published articles.
CREATE INDEX IF NOT EXISTS articles_caption_embedding_idx
    ON articles USING ivfflat (caption_embedding vector_cosine_ops)
    WITH (lists = 50);

-- ─────────────────────────────────────────────────────────────
-- RPC: find_similar_caption
-- Returns the single closest published article within a time window,
-- excluding the article being checked. Caller decides on threshold.
-- ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION find_similar_caption(
    query_embedding vector(384),
    window_days     int     DEFAULT 30,
    exclude_id      bigint  DEFAULT NULL
) RETURNS TABLE (
    id              bigint,
    niche           text,
    caption_preview text,
    similarity      float
) LANGUAGE sql STABLE AS $$
    SELECT
        a.id,
        a.niche,
        LEFT(COALESCE(a.telegram_caption, a.body, ''), 200) AS caption_preview,
        1 - (a.caption_embedding <=> query_embedding)       AS similarity
    FROM articles a
    WHERE a.status = 'published'
      AND a.caption_embedding IS NOT NULL
      AND a.published_system_at > now() - (window_days || ' days')::interval
      AND (exclude_id IS NULL OR a.id <> exclude_id)
    ORDER BY a.caption_embedding <=> query_embedding
    LIMIT 1;
$$;

-- Allow the service_role key (used by Brain) to call the function.
GRANT EXECUTE ON FUNCTION find_similar_caption(vector, int, bigint) TO service_role;
