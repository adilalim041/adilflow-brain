-- Migration: 2026-04-16_scheduler_advisory_lock.sql
--
-- Exposes pg_try_advisory_lock / pg_advisory_unlock to the Supabase service-role
-- client so the Brain scheduler can self-coordinate across Railway pods without
-- a Redis dependency.
--
-- Key derivation: hashtext('adilflow-scheduler-tick')::bigint
--   PostgreSQL's hashtext() is stable within a major version.
--   The key is the same on every call regardless of which pod runs it.
--
-- Advisory lock semantics (session-level):
--   pg_try_advisory_lock  — returns TRUE if lock acquired, FALSE if held by another session.
--   pg_advisory_unlock    — releases the lock; safe to call even if never held (returns FALSE,
--                           does not error). Session-level locks are also auto-released when the
--                           underlying PG connection is closed or recycled by pgBouncer.
--
-- Pooling note:
--   Supabase JS uses pgBouncer in transaction-pooling mode by default.
--   Session-level advisory locks are NOT safe across pgBouncer transaction-mode connections
--   because the lock is tied to the backend PG session, which may change between calls.
--
--   Brain uses the Supabase service-role client (supabase-js), which by default connects
--   through the direct connection string or session-mode pooler (port 5432).
--   If SUPABASE_URL points to the pgBouncer transaction-mode endpoint (port 6543),
--   the lock will behave unpredictably — each rpc() call may land on a different session.
--
--   Safe config: use the direct DB URL (port 5432) for Brain, or ensure the service-role
--   client uses the session-mode pooler endpoint.
--   30-second scheduler ticks are short enough that a connection recycling mid-tick (rare)
--   simply releases the lock early — the next pod will then acquire it, which is acceptable.
--
-- Idempotent: CREATE OR REPLACE is safe to re-run.

CREATE OR REPLACE FUNCTION try_scheduler_lock()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT pg_try_advisory_lock(hashtext('adilflow-scheduler-tick')::bigint);
$$;

CREATE OR REPLACE FUNCTION release_scheduler_lock()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT pg_advisory_unlock(hashtext('adilflow-scheduler-tick'));
$$;

-- Grant execute to service_role (used by Supabase service-key clients)
GRANT EXECUTE ON FUNCTION try_scheduler_lock()     TO service_role;
GRANT EXECUTE ON FUNCTION release_scheduler_lock() TO service_role;
