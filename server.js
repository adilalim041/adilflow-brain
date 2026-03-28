/**
 * AdilFlow Brain — Сервис 2
 * Центральный API всей медиа-сети
 *
 * Railway: auto-deploy from GitHub
 * Supabase: PostgreSQL + pgvector
 */

require('dotenv').config();

const Sentry = require('@sentry/node');
if (process.env.SENTRY_DSN) {
    Sentry.init({
        dsn: process.env.SENTRY_DSN,
        environment: process.env.NODE_ENV || 'development',
        tracesSampleRate: 0.2
    });
}

const express = require('express');
const rateLimit = require('express-rate-limit');
const { z } = require('zod');
const pino = require('pino');
const pinoHttp = require('pino-http');
const { createClient } = require('@supabase/supabase-js');

const logger = pino({ name: 'adilflow-brain' });

function validate(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            return res.status(400).json({ error: 'Validation failed', details: result.error.issues });
        }
        req.body = result.data;
        next();
    };
}

const ArticleBatchSchema = z.object({
    articles: z.array(z.object({
        url: z.string().url(),
        raw_title: z.string().min(1),
        raw_text: z.string().optional(),
        source_name: z.string().optional(),
        source_domain: z.string().optional(),
        niche: z.string().optional()
    })).min(1).max(200),
    niche: z.string().optional()
}).passthrough();

const ClassifySchema = z.object({
    niche: z.string().min(1).default('health_medicine'),
    limit: z.number().int().min(1).max(100).default(20)
}).passthrough();

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/health' } }));

// Rate limiting
app.use('/api/', rateLimit({ windowMs: 60_000, max: 300, message: { error: 'Too many requests' } }));
app.use('/api/articles/batch', rateLimit({ windowMs: 60_000, max: 100 }));
app.use('/api/classify', rateLimit({ windowMs: 60_000, max: 30 }));
const PROCESSING_LEASE_MINUTES = parseInt(process.env.PROCESSING_LEASE_MINUTES || '30', 10);
const PUBLISHING_LEASE_MINUTES = parseInt(process.env.PUBLISHING_LEASE_MINUTES || '30', 10);

// ═══════════════════════════════════════
// SUPABASE
// ═══════════════════════════════════════
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY  // service_role key (полный доступ)
);

// ═══════════════════════════════════════
// AUTH MIDDLEWARE
// ═══════════════════════════════════════
function authMiddleware(req, res, next) {
    const key = req.headers.authorization?.replace('Bearer ', '');
    if (!key || key !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

function toInt(value, fallback, min = 1, max = 100) {
    const parsed = parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function getLeaseCutoffIso(minutes = PROCESSING_LEASE_MINUTES) {
    return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

function mergeScoreDetails(existing, extra) {
    return { ...(existing || {}), ...(extra || {}) };
}

function toBool(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return fallback;
    if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
    if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
    return fallback;
}

function isMissingTableError(error) {
    const message = String(error?.message || '').toLowerCase();
    return error?.code === '42P01'
        || message.includes('could not find the table')
        || message.includes('schema cache')
        || message.includes('does not exist');
}

function optionalTableResponse(res, tableName) {
    return res.status(503).json({
        error: `Optional table '${tableName}' is not available yet`,
        action: 'Run the latest schema.sql in Supabase to enable channel configuration features.'
    });
}

function mapPlaybookRecord(record) {
    if (!record) return null;
    return {
        id: record.id,
        key: record.key,
        channel_profile_id: record.channel_profile_id,
        niche: record.niche,
        platform: record.platform,
        format: record.format,
        language: record.language,
        headline_rules: record.headline_rules || [],
        subheadline_rules: record.subheadline_rules || [],
        caption_rules: record.caption_rules || [],
        image_rules: record.image_rules || [],
        image_prompt_template: record.image_prompt_template || '',
        examples: record.examples || [],
        is_active: record.is_active !== false,
        created_at: record.created_at || null,
        updated_at: record.updated_at || null
    };
}

function mapTemplateBindingRecord(record) {
    if (!record) return null;
    return {
        id: record.id,
        channel_profile_id: record.channel_profile_id,
        niche: record.niche,
        platform: record.platform,
        format: record.format,
        template_id: record.template_id,
        template_slug: record.template_slug || null,
        priority: record.priority || 100,
        is_active: record.is_active !== false,
        notes: record.notes || null,
        created_at: record.created_at || null,
        updated_at: record.updated_at || null
    };
}

async function fetchReadyArticles(niche, limit) {
    let classifiedQuery = supabase
        .from('articles')
        .select('*')
        .eq('status', 'classified')
        .order('relevance_score', { ascending: false })
        .limit(limit);

    if (niche) classifiedQuery = classifiedQuery.eq('niche', niche);

    const { data: classified, error: classifiedError } = await classifiedQuery;
    if (classifiedError) throw classifiedError;

    const picked = classified || [];
    if (picked.length >= limit) return picked;

    let staleQuery = supabase
        .from('articles')
        .select('*')
        .eq('status', 'processing')
        .lt('updated_at', getLeaseCutoffIso())
        .order('relevance_score', { ascending: false })
        .limit(limit - picked.length);

    if (niche) staleQuery = staleQuery.eq('niche', niche);

    const { data: stale, error: staleError } = await staleQuery;
    if (staleError) throw staleError;

    return [...picked, ...(stale || [])];
}

async function markArticlesProcessing(articleIds) {
    if (!articleIds.length) return;
    const { error } = await supabase
        .from('articles')
        .update({ status: 'processing' })
        .in('id', articleIds);
    if (error) throw error;
}

async function fetchPublishableArticles(niche, limit, includeFailed = false) {
    let readyQuery = supabase
        .from('articles')
        .select('*')
        .eq('status', 'ready')
        .not('cover_image', 'is', null)
        .order('relevance_score', { ascending: false })
        .limit(limit);

    if (niche) readyQuery = readyQuery.eq('niche', niche);

    const { data: ready, error: readyError } = await readyQuery;
    if (readyError) throw readyError;

    const picked = ready || [];
    if (picked.length >= limit) return picked;

    let stalePublishingQuery = supabase
        .from('articles')
        .select('*')
        .eq('status', 'publishing')
        .not('cover_image', 'is', null)
        .lt('updated_at', getLeaseCutoffIso(PUBLISHING_LEASE_MINUTES))
        .order('relevance_score', { ascending: false })
        .limit(limit - picked.length);

    if (niche) stalePublishingQuery = stalePublishingQuery.eq('niche', niche);

    const { data: stalePublishing, error: stalePublishingError } = await stalePublishingQuery;
    if (stalePublishingError) throw stalePublishingError;

    const combined = [...picked, ...(stalePublishing || [])];
    if (combined.length >= limit || !includeFailed) return combined;

    let failedQuery = supabase
        .from('articles')
        .select('*')
        .eq('status', 'publish_failed')
        .not('cover_image', 'is', null)
        .order('updated_at', { ascending: false })
        .limit(limit - combined.length);

    if (niche) failedQuery = failedQuery.eq('niche', niche);

    const { data: failed, error: failedError } = await failedQuery;
    if (failedError) throw failedError;

    return [...combined, ...(failed || [])];
}

async function previewPublishableArticles(niche, limit, includeFailed = false) {
    let query = supabase
        .from('articles')
        .select('*')
        .in('status', includeFailed ? ['ready', 'publish_failed'] : ['ready'])
        .not('cover_image', 'is', null)
        .order('relevance_score', { ascending: false })
        .limit(limit);

    if (niche) query = query.eq('niche', niche);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

async function markArticlesPublishing(articleIds) {
    if (!articleIds.length) return;
    const { error } = await supabase
        .from('articles')
        .update({ status: 'publishing' })
        .in('id', articleIds);
    if (error) throw error;
}

// ═══════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════
app.get('/', (req, res) => {
    res.json({
        service: 'AdilFlow Brain',
        version: '1.0.0',
        status: 'online'
    });
});

app.get('/health', async (req, res) => {
    try {
        const { count } = await supabase.from('articles').select('*', { count: 'exact', head: true });
        res.json({ status: 'ok', articles: count });
    } catch (e) {
        res.status(500).json({ status: 'error', message: e.message });
    }
});

// ═══════════════════════════════════════
// ПАРСЕР → МОЗГ: приём сырых статей
// ═══════════════════════════════════════
app.post('/api/articles/batch', authMiddleware, validate(ArticleBatchSchema), async (req, res) => {
    try {
        const { articles, niche } = req.body;

        if (!articles || !Array.isArray(articles)) {
            return res.status(400).json({ error: 'articles array required' });
        }

        let newCount = 0;
        let dupCount = 0;
        let errorCount = 0;

        for (const article of articles) {
            try {
                // 1. Проверка точного дубля по url_hash
                const { data: existing } = await supabase
                    .from('articles')
                    .select('id')
                    .eq('url_hash', article.url_hash)
                    .maybeSingle();

                if (existing) {
                    dupCount++;
                    continue;
                }

                // 2. Проверка дубля по content_hash
                const { data: contentDup } = await supabase
                    .from('articles')
                    .select('id')
                    .eq('content_hash', article.content_hash)
                    .maybeSingle();

                if (contentDup) {
                    dupCount++;
                    continue;
                }

                // 3. Вставка новой статьи
                const { error } = await supabase.from('articles').insert({
                    url: article.url,
                    url_hash: article.url_hash,
                    content_hash: article.content_hash,
                    source_name: article.source_name,
                    source_domain: article.source_domain,
                    niche: niche || article.niche || 'unknown',
                    raw_title: article.raw_title,
                    raw_text: article.raw_text,
                    raw_summary: article.raw_summary || '',
                    authors: article.authors || [],
                    images: article.images || [],
                    top_image: article.top_image,
                    image_count: article.image_count || 0,
                    videos: article.videos || [],
                    video_count: article.video_count || 0,
                    has_usable_media: article.has_usable_media || false,
                    published_at: article.published_at,
                    parsed_at: article.parsed_at || new Date().toISOString(),
                    text_length: article.text_length || 0,
                    status: 'raw'
                });

                if (error) {
                    // Дубль по unique constraint — не ошибка
                    if (error.code === '23505') {
                        dupCount++;
                    } else {
                        console.error(`Insert error: ${error.message} | code: ${error.code} | details: ${error.details}`, { url: article.url });
                        errorCount++;
                    }
                } else {
                    newCount++;
                }

            } catch (e) {
                console.error(`[BATCH] Article insert exception: ${e.message}`, { url: article.url });
                errorCount++;
            }
        }

        console.log(`[BATCH] ${niche}: ${newCount} new, ${dupCount} dups, ${errorCount} errors (of ${articles.length})`);

        res.json({
            success: true,
            received: articles.length,
            new: newCount,
            duplicates: dupCount,
            errors: errorCount
        });

    } catch (e) {
        console.error(`[BATCH ERROR] ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// КЛАССИФИКАЦИЯ (вызывается по cron или вручную)
// ═══════════════════════════════════════
app.post('/api/classify', authMiddleware, validate(ClassifySchema), async (req, res) => {
    try {
        const { niche, limit = 20 } = req.body || {};

        // Берём статьи со статусом "raw"
        let query = supabase
            .from('articles')
            .select('id, raw_title, raw_text, raw_summary, niche')
            .eq('status', 'raw')
            .order('parsed_at', { ascending: false })
            .limit(limit);

        if (niche) query = query.eq('niche', niche);

        const { data: articles, error } = await query;
        if (error) throw error;

        if (!articles || articles.length === 0) {
            return res.json({ classified: 0, message: 'No raw articles to classify' });
        }

        // Получаем промпт ниши
        const niches = [...new Set(articles.map(a => a.niche))];
        const nicheConfigs = {};
        for (const n of niches) {
            const { data } = await supabase
                .from('niches')
                .select('gpt_system_prompt, language')
                .eq('id', n)
                .single();
            nicheConfigs[n] = data;
        }

        let classified = 0;
        let rejected = 0;

        for (const article of articles) {
            try {
                // Ensemble: GPT-4o-mini оценивает релевантность
                const score = await classifyWithGPT(article, nicheConfigs[article.niche]);

                const newStatus = score >= 6 ? 'classified' : 'rejected';

                await supabase
                    .from('articles')
                    .update({
                        relevance_score: score,
                        scores_detail: { gpt: score },
                        status: newStatus,
                        classified_at: new Date().toISOString()
                    })
                    .eq('id', article.id);

                if (newStatus === 'classified') classified++;
                else rejected++;

            } catch (e) {
                console.error(`[CLASSIFY] Error on article ${article.id}: ${e.message}`);
            }
        }

        console.log(`[CLASSIFY] ${classified} classified, ${rejected} rejected (of ${articles.length})`);
        res.json({ success: true, classified, rejected, total: articles.length });

    } catch (e) {
        console.error(`[CLASSIFY ERROR] ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});


async function classifyWithGPT(article, nicheConfig) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return 5; // Без ключа — средний балл

    const prompt = `Rate this article's relevance and newsworthiness on a scale of 1-10.
Consider: is it a real news/discovery (not an ad or opinion piece)? Is it recent? Is it interesting for a general audience?

Title: ${article.raw_title}
Summary: ${(article.raw_summary || article.raw_text.slice(0, 500))}

Respond with ONLY a number 1-10. Nothing else.`;

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [{ role: 'user', content: prompt }],
                max_tokens: 5,
                temperature: 0.1
            })
        });

        const data = await response.json();
        const text = data.choices?.[0]?.message?.content?.trim() || '5';
        const score = parseFloat(text);
        return isNaN(score) ? 5 : Math.min(10, Math.max(1, score));
    } catch (e) {
        console.error(`[GPT] ${e.message}`);
        return 5;
    }
}


// ═══════════════════════════════════════
// ГЕНЕРАТОР → МОЗГ: получить статьи для генерации
// ═══════════════════════════════════════
app.get('/api/articles/ready', authMiddleware, async (req, res) => {
    try {
        const { niche } = req.query;
        const limit = toInt(req.query.limit, 5, 1, 20);
        const articles = await fetchReadyArticles(niche, limit);

        if (articles.length > 0) {
            await markArticlesProcessing(articles.map(article => article.id));
        }

        res.json({
            success: true,
            lease_minutes: PROCESSING_LEASE_MINUTES,
            articles: articles || []
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// ГЕНЕРАТОР → МОЗГ: сохранить сгенерированный контент
// ═══════════════════════════════════════
app.post('/api/articles/:id/generated', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            headline, headline2, body, conclusion,
            telegram_caption, image_prompt,
            generated_image, cover_image, card_image,
            template_id, scores_detail
        } = req.body;

        const payload = {
            headline, headline2, body, conclusion,
            telegram_caption, image_prompt,
            generated_image, cover_image, card_image,
            template_id,
            status: 'ready',
            generated_at: new Date().toISOString()
        };

        if (scores_detail && typeof scores_detail === 'object') {
            const { data: article, error: loadError } = await supabase
                .from('articles')
                .select('scores_detail')
                .eq('id', id)
                .single();

            if (loadError) throw loadError;
            payload.scores_detail = mergeScoreDetails(article?.scores_detail, scores_detail);
        }

        const { error } = await supabase
            .from('articles')
            .update(payload)
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════
// ГЕНЕРАТОР → МОЗГ: вернуть статью в очередь при ошибке
// ═══════════════════════════════════════
app.post('/api/articles/:id/failed', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { stage = 'generator', error_message = 'Unknown error' } = req.body || {};

        const { data: article, error: loadError } = await supabase
            .from('articles')
            .select('scores_detail')
            .eq('id', id)
            .single();

        if (loadError) throw loadError;

        const { error } = await supabase
            .from('articles')
            .update({
                status: 'classified',
                scores_detail: mergeScoreDetails(article?.scores_detail, {
                    last_error_stage: stage,
                    last_error_message: error_message,
                    last_error_at: new Date().toISOString()
                })
            })
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true, status: 'classified' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// ПУБЛИКАТОР → МОЗГ: получить готовые к публикации
// ═══════════════════════════════════════
app.get('/api/articles/publish', authMiddleware, async (req, res) => {
    try {
        const { niche, channel = 'instagram' } = req.query;
        const limit = toInt(req.query.limit, 1, 1, 20);
        const reserve = toBool(req.query.reserve, true);
        const includeFailed = toBool(req.query.include_failed, false);

        const articles = reserve
            ? await fetchPublishableArticles(niche, limit, includeFailed)
            : await previewPublishableArticles(niche, limit, includeFailed);

        if (reserve && articles.length > 0) {
            await markArticlesPublishing(articles.map(article => article.id));
        }

        res.json({
            success: true,
            reserve,
            lease_minutes: PUBLISHING_LEASE_MINUTES,
            articles: channel === 'instagram' ? articles.filter(article => !!article.cover_image) : articles
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// ПУБЛИКАТОР → МОЗГ: отметить как опубликовано
// ═══════════════════════════════════════
app.post('/api/articles/:id/published', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { channel, message_id, external_id, permalink, channel_data } = req.body;

        // Получаем текущий published_channels
        const { data: article } = await supabase
            .from('articles')
            .select('published_channels, scores_detail')
            .eq('id', id)
            .single();

        const channels = article?.published_channels || [];
        channels.push({
            channel,
            message_id: message_id || external_id || null,
            external_id: external_id || message_id || null,
            permalink: permalink || null,
            channel_data: channel_data || null,
            published_at: new Date().toISOString()
        });

        const { error } = await supabase
            .from('articles')
            .update({
                published_channels: channels,
                status: 'published',
                published_system_at: new Date().toISOString(),
                scores_detail: mergeScoreDetails(article?.scores_detail, {
                    last_publish_error: null,
                    last_publish_attempt_at: new Date().toISOString(),
                    last_published_channel: channel || 'instagram'
                })
            })
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ═══════════════════════════════════════
// ПУБЛИКАТОР → МОЗГ: отметить ошибку публикации
// ═══════════════════════════════════════
app.post('/api/articles/:id/publish-failed', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { channel = 'instagram', error_message = 'Unknown publish error', retryable = true } = req.body || {};

        const { data: article, error: loadError } = await supabase
            .from('articles')
            .select('scores_detail')
            .eq('id', id)
            .single();

        if (loadError) throw loadError;

        const { error } = await supabase
            .from('articles')
            .update({
                status: 'publish_failed',
                scores_detail: mergeScoreDetails(article?.scores_detail, {
                    last_publish_error: error_message,
                    last_publish_attempt_at: new Date().toISOString(),
                    last_publish_channel: channel,
                    publish_retryable: retryable
                })
            })
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true, status: 'publish_failed' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// СТАТИСТИКА
// ═══════════════════════════════════════
app.get('/api/stats', authMiddleware, async (req, res) => {
    try {
        const { niche } = req.query;

        let baseQuery = supabase.from('articles');

        // Считаем по статусам
        const statuses = ['raw', 'classified', 'processing', 'ready', 'publishing', 'publish_failed', 'published', 'rejected'];
        const counts = {};

        for (const status of statuses) {
            let q = baseQuery.select('*', { count: 'exact', head: true }).eq('status', status);
            if (niche) q = q.eq('niche', niche);
            const { count } = await q;
            counts[status] = count || 0;
        }

        // Общее количество
        let totalQ = baseQuery.select('*', { count: 'exact', head: true });
        if (niche) totalQ = totalQ.eq('niche', niche);
        const { count: total } = await totalQ;

        res.json({
            success: true,
            niche: niche || 'all',
            total: total || 0,
            by_status: counts
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// НИШИ
// ═══════════════════════════════════════
app.get('/api/niches', authMiddleware, async (req, res) => {
    try {
        const { data, error } = await supabase
            .from('niches')
            .select('*')
            .eq('is_active', true);
        if (error) throw error;
        res.json({ success: true, niches: data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/channel-profiles', authMiddleware, async (req, res) => {
    try {
        const { platform, niche, active_only = 'true' } = req.query;
        let query = supabase
            .from('channel_profiles')
            .select('*')
            .order('priority', { ascending: true })
            .order('created_at', { ascending: true });

        if (platform) query = query.eq('platform', platform);
        if (niche) query = query.eq('niche', niche);
        if (toBool(active_only, true)) query = query.eq('is_active', true);

        const { data, error } = await query;
        if (error) {
            if (isMissingTableError(error)) return optionalTableResponse(res, 'channel_profiles');
            throw error;
        }

        res.json({ success: true, profiles: data || [] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/channel-profiles', authMiddleware, async (req, res) => {
    try {
        const payload = {
            key: req.body?.key,
            name: req.body?.name,
            platform: req.body?.platform || 'instagram',
            niche: req.body?.niche,
            language: req.body?.language || 'ru',
            account_ref: req.body?.account_ref || null,
            posting_mode: req.body?.posting_mode || 'manual',
            priority: toInt(req.body?.priority, 100, 1, 1000),
            settings: req.body?.settings || {},
            is_active: req.body?.is_active !== false
        };

        if (!payload.key || !payload.name || !payload.niche) {
            return res.status(400).json({ error: 'key, name, and niche are required' });
        }

        const { data, error } = await supabase
            .from('channel_profiles')
            .upsert(payload, { onConflict: 'key' })
            .select('*')
            .single();

        if (error) {
            if (isMissingTableError(error)) return optionalTableResponse(res, 'channel_profiles');
            throw error;
        }

        res.json({ success: true, profile: data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/playbooks', authMiddleware, async (req, res) => {
    try {
        const { key, niche, platform, channel_profile_id, active_only = 'true' } = req.query;
        let query = supabase
            .from('content_playbooks')
            .select('*')
            .order('updated_at', { ascending: false });

        if (key) query = query.eq('key', key);
        if (niche) query = query.eq('niche', niche);
        if (platform) query = query.eq('platform', platform);
        if (channel_profile_id) query = query.eq('channel_profile_id', channel_profile_id);
        if (toBool(active_only, true)) query = query.eq('is_active', true);

        const { data, error } = await query;
        if (error) {
            if (isMissingTableError(error)) return optionalTableResponse(res, 'content_playbooks');
            throw error;
        }

        res.json({
            success: true,
            playbooks: (data || []).map(mapPlaybookRecord)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/playbooks', authMiddleware, async (req, res) => {
    try {
        const payload = {
            key: req.body?.key,
            channel_profile_id: req.body?.channel_profile_id || null,
            niche: req.body?.niche,
            platform: req.body?.platform || 'instagram',
            format: req.body?.format || 'feed_post',
            language: req.body?.language || 'ru',
            headline_rules: req.body?.headline_rules || [],
            subheadline_rules: req.body?.subheadline_rules || [],
            caption_rules: req.body?.caption_rules || [],
            image_rules: req.body?.image_rules || [],
            image_prompt_template: req.body?.image_prompt_template || '',
            examples: req.body?.examples || [],
            is_active: req.body?.is_active !== false
        };

        if (!payload.key || !payload.niche) {
            return res.status(400).json({ error: 'key and niche are required' });
        }

        const { data, error } = await supabase
            .from('content_playbooks')
            .upsert(payload, { onConflict: 'key' })
            .select('*')
            .single();

        if (error) {
            if (isMissingTableError(error)) return optionalTableResponse(res, 'content_playbooks');
            throw error;
        }

        res.json({ success: true, playbook: mapPlaybookRecord(data) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/template-bindings', authMiddleware, async (req, res) => {
    try {
        const { niche, platform, channel_profile_id, active_only = 'true' } = req.query;
        let query = supabase
            .from('template_bindings')
            .select('*')
            .order('priority', { ascending: true })
            .order('updated_at', { ascending: false });

        if (niche) query = query.eq('niche', niche);
        if (platform) query = query.eq('platform', platform);
        if (channel_profile_id) query = query.eq('channel_profile_id', channel_profile_id);
        if (toBool(active_only, true)) query = query.eq('is_active', true);

        const { data, error } = await query;
        if (error) {
            if (isMissingTableError(error)) return optionalTableResponse(res, 'template_bindings');
            throw error;
        }

        res.json({
            success: true,
            bindings: (data || []).map(mapTemplateBindingRecord)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/template-bindings', authMiddleware, async (req, res) => {
    try {
        const payload = {
            channel_profile_id: req.body?.channel_profile_id || null,
            niche: req.body?.niche,
            platform: req.body?.platform || 'instagram',
            format: req.body?.format || 'feed_post',
            template_id: req.body?.template_id,
            template_slug: req.body?.template_slug || null,
            priority: toInt(req.body?.priority, 100, 1, 1000),
            notes: req.body?.notes || null,
            is_active: req.body?.is_active !== false
        };

        if (!payload.niche || !payload.template_id) {
            return res.status(400).json({ error: 'niche and template_id are required' });
        }

        const { data, error } = await supabase
            .from('template_bindings')
            .insert(payload)
            .select('*')
            .single();

        if (error) {
            if (isMissingTableError(error)) return optionalTableResponse(res, 'template_bindings');
            throw error;
        }

        res.json({ success: true, binding: mapTemplateBindingRecord(data) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/config/resolve', authMiddleware, async (req, res) => {
    try {
        const { niche, platform = 'instagram', channel_key } = req.query;
        if (!niche) {
            return res.status(400).json({ error: 'niche is required' });
        }

        let channelProfile = null;
        let playbook = null;
        let templateBindings = [];

        const { data: profileData, error: profileError } = await supabase
            .from('channel_profiles')
            .select('*')
            .eq('platform', platform)
            .eq('niche', niche)
            .eq('is_active', true)
            .order('priority', { ascending: true })
            .limit(channel_key ? 50 : 1);

        if (profileError && !isMissingTableError(profileError)) throw profileError;

        if (Array.isArray(profileData) && profileData.length > 0) {
            channelProfile = channel_key
                ? profileData.find((item) => item.key === channel_key) || profileData[0]
                : profileData[0];
        }

        const playbookQuery = supabase
            .from('content_playbooks')
            .select('*')
            .eq('platform', platform)
            .eq('niche', niche)
            .eq('is_active', true)
            .order('updated_at', { ascending: false })
            .limit(10);

        const { data: playbookData, error: playbookError } = await playbookQuery;
        if (playbookError && !isMissingTableError(playbookError)) throw playbookError;

        if (Array.isArray(playbookData) && playbookData.length > 0) {
            playbook = mapPlaybookRecord(
                channelProfile
                    ? playbookData.find((item) => item.channel_profile_id === channelProfile.id) || playbookData[0]
                    : playbookData[0]
            );
        }

        let bindingsQuery = supabase
            .from('template_bindings')
            .select('*')
            .eq('platform', platform)
            .eq('niche', niche)
            .eq('is_active', true)
            .order('priority', { ascending: true });

        if (channelProfile) {
            bindingsQuery = bindingsQuery.or(`channel_profile_id.eq.${channelProfile.id},channel_profile_id.is.null`);
        }

        const { data: bindingData, error: bindingError } = await bindingsQuery;
        if (bindingError && !isMissingTableError(bindingError)) throw bindingError;

        templateBindings = (bindingData || []).map(mapTemplateBindingRecord);

        res.json({
            success: true,
            config: {
                niche,
                platform,
                channel_profile: channelProfile,
                playbook,
                template_bindings: templateBindings
            }
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// PIPELINE SCHEDULER (opt-in via SCHEDULER_ENABLED=true)
// ═══════════════════════════════════════
const SCHEDULER_ENABLED = process.env.SCHEDULER_ENABLED === 'true';
const GENERATOR_URL = process.env.GENERATOR_URL || '';
const PUBLISHER_URL = process.env.PUBLISHER_URL || '';
const GENERATOR_API_KEY = process.env.GENERATOR_API_KEY || '';
const PUBLISHER_API_KEY = process.env.PUBLISHER_API_KEY || '';
const SCHEDULE_CLASSIFY_MINUTES = parseInt(process.env.SCHEDULE_CLASSIFY_MINUTES || '30', 10);
const SCHEDULE_GENERATE_MINUTES = parseInt(process.env.SCHEDULE_GENERATE_MINUTES || '60', 10);
const SCHEDULE_PUBLISH_MINUTES = parseInt(process.env.SCHEDULE_PUBLISH_MINUTES || '120', 10);
const SCHEDULE_NICHE = process.env.SCHEDULE_NICHE || 'health_medicine';
const schedulerLog = [];

async function schedulerRun(name, fn) {
    const start = Date.now();
    try {
        const result = await fn();
        const entry = { name, ok: true, duration: Date.now() - start, at: new Date().toISOString(), result };
        schedulerLog.push(entry);
        if (schedulerLog.length > 100) schedulerLog.shift();
        logger.info(entry, `[Scheduler] ${name} OK`);
    } catch (error) {
        const entry = { name, ok: false, duration: Date.now() - start, at: new Date().toISOString(), error: error.message };
        schedulerLog.push(entry);
        if (schedulerLog.length > 100) schedulerLog.shift();
        logger.error(entry, `[Scheduler] ${name} FAILED`);
    }
}

async function triggerClassify() {
    // Self-call — Brain's own classify endpoint
    const res = await fetch(`http://localhost:${process.env.PORT || 3001}/api/classify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ niche: SCHEDULE_NICHE, limit: 20 })
    });
    return res.json();
}

async function triggerGenerate() {
    if (!GENERATOR_URL) throw new Error('GENERATOR_URL not set');
    const res = await fetch(`${GENERATOR_URL}/api/generate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GENERATOR_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ niche: SCHEDULE_NICHE, count: 5 })
    });
    return res.json();
}

async function triggerPublish() {
    if (!PUBLISHER_URL) throw new Error('PUBLISHER_URL not set');
    const res = await fetch(`${PUBLISHER_URL}/api/publish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${PUBLISHER_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ niche: SCHEDULE_NICHE, limit: 3 })
    });
    return res.json();
}

app.get('/api/scheduler/status', authMiddleware, (req, res) => {
    res.json({
        enabled: SCHEDULER_ENABLED,
        intervals: {
            classify: `${SCHEDULE_CLASSIFY_MINUTES}m`,
            generate: `${SCHEDULE_GENERATE_MINUTES}m`,
            publish: `${SCHEDULE_PUBLISH_MINUTES}m`
        },
        niche: SCHEDULE_NICHE,
        recent_runs: schedulerLog.slice(-20)
    });
});

app.post('/api/scheduler/trigger', authMiddleware, async (req, res) => {
    const step = req.body?.step || 'classify';
    const fns = { classify: triggerClassify, generate: triggerGenerate, publish: triggerPublish };
    if (!fns[step]) return res.status(400).json({ error: `Unknown step: ${step}` });
    await schedulerRun(step, fns[step]);
    res.json({ triggered: step, log: schedulerLog.slice(-5) });
});

function startScheduler() {
    if (!SCHEDULER_ENABLED) {
        logger.info('[Scheduler] Disabled. Set SCHEDULER_ENABLED=true to enable.');
        return;
    }
    logger.info({ classify: `${SCHEDULE_CLASSIFY_MINUTES}m`, generate: `${SCHEDULE_GENERATE_MINUTES}m`, publish: `${SCHEDULE_PUBLISH_MINUTES}m` }, '[Scheduler] Starting pipeline automation');
    setInterval(() => schedulerRun('classify', triggerClassify), SCHEDULE_CLASSIFY_MINUTES * 60 * 1000);
    setInterval(() => schedulerRun('generate', triggerGenerate), SCHEDULE_GENERATE_MINUTES * 60 * 1000);
    setInterval(() => schedulerRun('publish', triggerPublish), SCHEDULE_PUBLISH_MINUTES * 60 * 1000);
}

// Sentry error handler (must be after all routes)
if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
}

// ═══════════════════════════════════════
// ЗАПУСК
// ═══════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    logger.info(`AdilFlow Brain listening on port ${PORT}`);
    logger.info(`Supabase: ${process.env.SUPABASE_URL ? 'connected' : 'NOT SET'}`);
    startScheduler();
});
