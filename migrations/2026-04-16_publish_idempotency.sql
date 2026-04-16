-- Migration: 2026-04-16_publish_idempotency
-- Adds explicit publish lease + idempotency fields to articles.
--
-- Motivation: 2026-04-14 incident — Publisher posted a stale article because
-- /api/articles/publish picked oldest-first and had no atomic lease check.
-- If Publisher crashes between IG container creation and the /published callback,
-- we'd get a duplicate post (ban risk). This migration enables an atomic
-- acquire-publish-lease endpoint that prevents concurrent and duplicate publishing.

-- ig_container_id: stores the Instagram media container ID created in step 1
-- of the two-step IG publish flow. On retry, Publisher checks this field and
-- skips container creation if one already exists for this article.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS ig_container_id text;

-- publish_attempt_count: incremented on every lease acquisition. Lets us detect
-- runaway retry loops and surface them in the dashboard.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS publish_attempt_count int NOT NULL DEFAULT 0;

-- publish_lease_until: explicit lease expiry timestamp. Replaces the implicit
-- "updated_at < now() - 30m" pattern in fetchPublishableArticles. A row with
-- status='publishing' and publish_lease_until < now() is safe to reclaim.
ALTER TABLE articles ADD COLUMN IF NOT EXISTS publish_lease_until timestamptz;

-- Partial index: only covers rows that the acquire-publish-lease endpoint
-- will ever touch (status IN ('publishing','ready')). Keeps the index small
-- and makes the UPDATE ... WHERE status='ready' fast.
CREATE INDEX IF NOT EXISTS articles_publishing_lease_idx
    ON articles (status, publish_lease_until)
    WHERE status IN ('publishing', 'ready');
