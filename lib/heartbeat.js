/**
 * heartbeat.js — publishes aggregated News.AI system health to the
 * ObsidianVault via GitHub Contents API every 5 minutes.
 *
 * Only adilflow_brain writes this heartbeat — other services (parser,
 * generator, publisher, dashboard) do NOT call this module.
 *
 * Metrics source:
 *   - uptime_h             : process.uptime() — no DB needed
 *   - last_article_published_at : MAX(published_at) from articles WHERE status='published'
 *   - articles_today       : COUNT WHERE status='published' AND published_at >= today UTC
 *   - queue_depth          : COUNT WHERE status IN ('raw','classified','ready','processing')
 *                            (articles anywhere in the pipeline not yet published/rejected)
 *   - error_rate_1h        : null — brain has no dedicated error counter; honest null is
 *                            better than a fabricated number. Add when Sentry SDK is wired.
 *
 * All Supabase queries piggyback the existing `supabase` client — zero new
 * connections, zero new cross-service calls.
 *
 * Usage (in server.js, after `app.listen`):
 *   const { startHeartbeat } = require('./lib/heartbeat');
 *   startHeartbeat(supabase, logger);
 */

'use strict';

const { writeHeartbeat } = require('./vault_github');

const INTERVAL_MS    = 5 * 60 * 1000; // 5 minutes
const SERVICE_NAME   = 'news-ai';
const PIPELINE_STATUSES = ['raw', 'classified', 'ready', 'processing'];

/**
 * Collect metrics from Supabase using the shared client.
 * Each query is best-effort — any failure returns null for that metric.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {import('pino').Logger} logger
 * @returns {Promise<object>}
 */
async function collectMetrics(supabase, logger) {
    const uptimeH = Math.round((process.uptime() / 3600) * 100) / 100;

    // ── last_article_published_at ────────────────────────────────────────────
    let lastPublishedAt = null;
    try {
        const { data, error } = await supabase
            .from('articles')
            .select('published_at')
            .eq('status', 'published')
            .not('published_at', 'is', null)
            .order('published_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw error;
        lastPublishedAt = data?.published_at ?? null;
    } catch (err) {
        logger.warn({ err: err.message, metric: 'last_article_published_at' }, 'heartbeat: metric query failed');
    }

    // ── articles_today ───────────────────────────────────────────────────────
    let articlesToday = 0;
    try {
        const todayUtc = new Date();
        todayUtc.setUTCHours(0, 0, 0, 0);

        const { count, error } = await supabase
            .from('articles')
            .select('*', { count: 'exact', head: true })
            .eq('status', 'published')
            .gte('published_at', todayUtc.toISOString());

        if (error) throw error;
        articlesToday = count ?? 0;
    } catch (err) {
        logger.warn({ err: err.message, metric: 'articles_today' }, 'heartbeat: metric query failed');
    }

    // ── queue_depth ──────────────────────────────────────────────────────────
    // Count articles still in the pipeline (not yet published or rejected).
    let queueDepth = null;
    try {
        const { count, error } = await supabase
            .from('articles')
            .select('*', { count: 'exact', head: true })
            .in('status', PIPELINE_STATUSES);

        if (error) throw error;
        queueDepth = count ?? null;
    } catch (err) {
        logger.warn({ err: err.message, metric: 'queue_depth' }, 'heartbeat: metric query failed');
    }

    return {
        uptime_h: uptimeH,
        last_article_published_at: lastPublishedAt,
        articles_today: articlesToday,
        queue_depth: queueDepth,
        error_rate_1h: null, // not tracked yet — add when Sentry error count API is wired
    };
}

/**
 * Run one heartbeat cycle: collect metrics, determine status, write to vault.
 * Never throws — any error is logged and swallowed so brain keeps running.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {import('pino').Logger} logger
 */
async function runHeartbeat(supabase, logger) {
    try {
        const details = await collectMetrics(supabase, logger);

        // Simple health heuristic: degraded if queue is deep and nothing published today.
        const status = (details.queue_depth !== null && details.queue_depth > 500 && details.articles_today === 0)
            ? 'degraded'
            : 'healthy';

        await writeHeartbeat(SERVICE_NAME, status, details);

        logger.info(
            { service: SERVICE_NAME, status, queue_depth: details.queue_depth, articles_today: details.articles_today },
            'heartbeat: vault updated'
        );
    } catch (err) {
        // NEVER crash brain on heartbeat failure.
        // VAULT_WRITE_TOKEN absence is expected in local dev — logged once at boot.
        logger.warn({ err: err.message }, 'heartbeat: write failed (non-fatal)');
    }
}

/**
 * Start the 5-minute heartbeat loop and fire the first tick immediately.
 *
 * Call this once inside `app.listen(PORT, () => { ... })` after startScheduler().
 *
 * If VAULT_WRITE_TOKEN is missing, logs a warning once and exits early —
 * no interval is registered, brain runs normally without the heartbeat.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {import('pino').Logger} logger
 */
function startHeartbeat(supabase, logger) {
    if (!process.env.VAULT_WRITE_TOKEN) {
        logger.warn('VAULT_WRITE_TOKEN not set — heartbeat disabled. Set it in Railway env to enable vault health reporting.');
        return;
    }

    // Immediate first tick so Railway logs show activity right after deploy.
    runHeartbeat(supabase, logger);

    setInterval(() => runHeartbeat(supabase, logger), INTERVAL_MS);

    logger.info({ interval_ms: INTERVAL_MS, service: SERVICE_NAME }, 'heartbeat: started');
}

// Export for testing — allows unit tests to call runHeartbeat directly
// with mocked supabase and logger without starting the full server.
module.exports = { startHeartbeat, runHeartbeat, collectMetrics };
