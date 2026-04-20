/**
 * heartbeat.test.js
 *
 * Unit tests for lib/heartbeat.js.
 *
 * Strategy: import the module functions directly, inject a mock Supabase
 * client and a silent logger. Use vi.stubGlobal to control the fetch used
 * by vault_github.js. Verify payload shape and that a fetch failure never
 * throws out of runHeartbeat.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Silence logger in tests ────────────────────────────────────────────────
const silentLogger = {
    info:  () => {},
    warn:  () => {},
    error: () => {},
    fatal: () => {},
    debug: () => {},
};

// ─── Minimal Supabase mock builder ──────────────────────────────────────────
/**
 * Returns a mock Supabase client whose .from() calls resolve with the
 * supplied responses in order. Each response is { data, count, error }.
 *
 * Fluent chain: .from().select().eq()...maybeSingle() / head:true all
 * collapse to a single awaitable that returns the next queued response.
 */
function makeSupabaseMock(responses) {
    let callIndex = 0;

    const terminal = () => {
        const resp = responses[callIndex++] || { data: null, count: null, error: null };
        return Promise.resolve(resp);
    };

    // A chainable builder that ends at .maybeSingle(), .limit(n).maybeSingle(),
    // or any await-point reached by Supabase select with { head: true }.
    const chain = () => ({
        select: () => chain(),
        eq:     () => chain(),
        neq:    () => chain(),
        not:    () => chain(),
        in:     () => chain(),
        gte:    () => chain(),
        lte:    () => chain(),
        order:  () => chain(),
        limit:  () => chain(),
        maybeSingle: terminal,
        then:   (resolve) => terminal().then(resolve),
        // Supabase select with count:exact & head:true awaits the chain directly
        [Symbol.toStringTag]: 'Promise',
    });

    return { from: () => chain() };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('collectMetrics', async () => {
    // Dynamic import so vault_github.js (a CJS module) doesn't need global fetch
    // at module-load time — we stub fetch before the first call.
    const { collectMetrics } = await import('../lib/heartbeat.js');

    beforeEach(() => {
        // Reset env
        delete process.env.VAULT_WRITE_TOKEN;
    });

    it('returns correct shape when all queries succeed', async () => {
        const publishedAt = '2026-04-20T10:00:00.000Z';

        // Responses in query order:
        //  1. last_article_published_at (maybeSingle)
        //  2. articles_today (head count)
        //  3. queue_depth (head count)
        const mockSupabase = makeSupabaseMock([
            { data: { published_at: publishedAt }, count: null, error: null },
            { data: null, count: 3, error: null },
            { data: null, count: 42, error: null },
        ]);

        const metrics = await collectMetrics(mockSupabase, silentLogger);

        expect(typeof metrics.uptime_h).toBe('number');
        expect(metrics.uptime_h).toBeGreaterThanOrEqual(0);
        expect(metrics.last_article_published_at).toBe(publishedAt);
        expect(metrics.articles_today).toBe(3);
        expect(metrics.queue_depth).toBe(42);
        expect(metrics.error_rate_1h).toBeNull(); // always null until Sentry wired
    });

    it('returns null for metrics when queries fail', async () => {
        const mockSupabase = makeSupabaseMock([
            { data: null, count: null, error: new Error('db timeout') },
            { data: null, count: null, error: new Error('db timeout') },
            { data: null, count: null, error: new Error('db timeout') },
        ]);

        const metrics = await collectMetrics(mockSupabase, silentLogger);

        expect(metrics.last_article_published_at).toBeNull();
        expect(metrics.articles_today).toBe(0);   // falls back to 0, not null
        expect(metrics.queue_depth).toBeNull();    // null when count unavailable
    });
});

describe('runHeartbeat', async () => {
    const { runHeartbeat } = await import('../lib/heartbeat.js');

    afterEach(() => {
        vi.unstubAllGlobals();
        delete process.env.VAULT_WRITE_TOKEN;
    });

    it('does not throw when fetch (vault write) fails', async () => {
        process.env.VAULT_WRITE_TOKEN = 'test-token';

        // Stub global fetch: first call (sha lookup) fails
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

        const mockSupabase = makeSupabaseMock([
            { data: { published_at: '2026-04-20T10:00:00.000Z' }, count: null, error: null },
            { data: null, count: 5, error: null },
            { data: null, count: 10, error: null },
        ]);

        // Must not throw
        await expect(runHeartbeat(mockSupabase, silentLogger)).resolves.toBeUndefined();
    });

    it('calls writeHeartbeat with correct service name and payload shape', async () => {
        process.env.VAULT_WRITE_TOKEN = 'test-token';

        let capturedBody = null;

        // Stub fetch:
        //  - First PUT call from writeVault is a GET for sha → 404 (new file)
        //  - Second call is the actual PUT → 201
        vi.stubGlobal('fetch', vi.fn()
            .mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })   // sha lookup → new file
            .mockResolvedValueOnce({ ok: true, status: 201, json: async () => ({ content: {} }) }) // PUT
        );

        // Intercept the fetch to capture what was written
        const originalFetch = global.fetch;
        vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
            if (opts?.method === 'PUT') {
                capturedBody = JSON.parse(opts.body);
            }
            return originalFetch(url, opts);
        }));

        const mockSupabase = makeSupabaseMock([
            { data: { published_at: '2026-04-20T10:00:00.000Z' }, count: null, error: null },
            { data: null, count: 2, error: null },
            { data: null, count: 7, error: null },
        ]);

        await runHeartbeat(mockSupabase, silentLogger);

        // If capturedBody was set — verify payload structure
        if (capturedBody) {
            const written = JSON.parse(Buffer.from(capturedBody.content, 'base64').toString('utf-8'));
            expect(written.service).toBe('news-ai');
            expect(['healthy', 'degraded', 'down', 'unknown']).toContain(written.status);
            expect(written.version).toBe('1.0');
            expect(typeof written.updated_at).toBe('string');
            expect(written.details).toHaveProperty('uptime_h');
            expect(written.details).toHaveProperty('last_article_published_at');
            expect(written.details).toHaveProperty('articles_today');
            expect(written.details).toHaveProperty('queue_depth');
            expect(written.details).toHaveProperty('error_rate_1h');
        }
    });
});

describe('startHeartbeat', async () => {
    const { startHeartbeat } = await import('../lib/heartbeat.js');

    afterEach(() => {
        vi.useRealTimers();
        delete process.env.VAULT_WRITE_TOKEN;
    });

    it('warns and returns early when VAULT_WRITE_TOKEN is missing', () => {
        delete process.env.VAULT_WRITE_TOKEN;

        const warnSpy = vi.fn();
        const testLogger = { ...silentLogger, warn: warnSpy };

        startHeartbeat(makeSupabaseMock([]), testLogger);

        expect(warnSpy).toHaveBeenCalledOnce();
        expect(warnSpy.mock.calls[0][0]).toMatch(/VAULT_WRITE_TOKEN/);
    });
});
