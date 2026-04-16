/**
 * Backfill: generate caption_embedding for published articles that don't have one.
 *
 * Run manually AFTER 2026-04-16_caption_embedding.sql migration:
 *   node scripts/backfill_caption_embeddings.js
 *
 * Or via package.json script:
 *   npm run backfill:embeddings
 *
 * Environment variables required (same as Brain server):
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY, OPENAI_API_KEY
 *
 * Safety: processes at most 1000 articles per run, 1 RPS to OpenAI.
 * Re-run to continue if interrupted.
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const REQUIRED_ENV = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'OPENAI_API_KEY'];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
    console.error(`[backfill] Missing required env vars: ${missing.join(', ')}`);
    process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const BATCH_SIZE = 50;       // rows fetched per DB page
const MAX_TOTAL = 1000;      // hard limit per run — re-run to continue
const DELAY_MS = 1100;       // ~1 RPS to OpenAI embeddings endpoint
const EMBED_TIMEOUT_MS = 15000;

async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedCaption(text) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'text-embedding-3-small',
                dimensions: 384,
                input: text
            }),
            signal: controller.signal
        });

        const result = await response.json();
        if (!response.ok) {
            throw new Error(`OpenAI ${response.status}: ${result.error?.message || 'API error'}`);
        }

        const embedding = result?.data?.[0]?.embedding;
        if (!Array.isArray(embedding) || embedding.length !== 384) {
            throw new Error(`Unexpected embedding shape: length=${embedding?.length}`);
        }
        return embedding;
    } finally {
        clearTimeout(timeout);
    }
}

async function run() {
    console.log('[backfill] Starting caption embedding backfill...');
    console.log(`[backfill] Config: batch_size=${BATCH_SIZE}, max_total=${MAX_TOTAL}, delay=${DELAY_MS}ms`);

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let page = 0;

    while (processed < MAX_TOTAL) {
        const remaining = MAX_TOTAL - processed;
        const limit = Math.min(BATCH_SIZE, remaining);
        const offset = page * BATCH_SIZE;

        // Fetch published articles without caption_embedding
        const { data: articles, error: fetchError } = await supabase
            .from('articles')
            .select('id, telegram_caption, body')
            .eq('status', 'published')
            .is('caption_embedding', null)
            .order('published_system_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (fetchError) {
            console.error(`[backfill] DB fetch error at page ${page}:`, fetchError.message);
            process.exit(1);
        }

        if (!articles || articles.length === 0) {
            console.log('[backfill] No more articles to backfill.');
            break;
        }

        console.log(`[backfill] Page ${page}: fetched ${articles.length} articles (offset ${offset})`);

        for (const article of articles) {
            const captionText = article.telegram_caption || article.body;
            if (!captionText || captionText.trim().length < 10) {
                console.warn(`[backfill]   Article ${article.id}: no usable caption text — skipping`);
                processed++;
                continue;
            }

            try {
                const embedding = await embedCaption(captionText.slice(0, 5000));

                const { error: updateError } = await supabase
                    .from('articles')
                    .update({ caption_embedding: embedding })
                    .eq('id', article.id);

                if (updateError) {
                    throw new Error(updateError.message);
                }

                succeeded++;
                console.log(`[backfill]   Article ${article.id}: embedded OK (${succeeded} done)`);
            } catch (e) {
                failed++;
                console.error(`[backfill]   Article ${article.id}: FAILED — ${e.message}`);
            }

            processed++;

            // Rate-limit: 1 call per ~1.1s to stay well under OpenAI RPM limits
            if (processed < MAX_TOTAL && processed < (page + 1) * BATCH_SIZE) {
                await sleep(DELAY_MS);
            }
        }

        page++;

        // Brief pause between DB pages
        if (articles.length === limit) {
            await sleep(500);
        }
    }

    console.log(`\n[backfill] Done. processed=${processed}, succeeded=${succeeded}, failed=${failed}`);
    if (failed > 0) {
        console.warn(`[backfill] ${failed} articles failed — re-run to retry.`);
        process.exit(1);
    }
}

run().catch((e) => {
    console.error('[backfill] Unhandled error:', e.message);
    process.exit(1);
});
