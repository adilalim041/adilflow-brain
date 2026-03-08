/**
 * AdilFlow Brain — Сервис 2
 * Центральный API всей медиа-сети
 * 
 * Railway: auto-deploy from GitHub
 * Supabase: PostgreSQL + pgvector
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '10mb' }));

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
app.post('/api/articles/batch', authMiddleware, async (req, res) => {
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
                    .single();

                if (existing) {
                    dupCount++;
                    continue;
                }

                // 2. Проверка дубля по content_hash
                const { data: contentDup } = await supabase
                    .from('articles')
                    .select('id')
                    .eq('content_hash', article.content_hash)
                    .single();

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
                        console.error(`Insert error: ${error.message}`);
                        errorCount++;
                    }
                } else {
                    newCount++;
                }

            } catch (e) {
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
app.post('/api/classify', authMiddleware, async (req, res) => {
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
        const { niche, limit = 5 } = req.query;

        let query = supabase
            .from('articles')
            .select('*')
            .eq('status', 'classified')
            .order('relevance_score', { ascending: false })
            .limit(parseInt(limit));

        if (niche) query = query.eq('niche', niche);

        const { data, error } = await query;
        if (error) throw error;

        // Помечаем как "processing"
        if (data && data.length > 0) {
            const ids = data.map(a => a.id);
            await supabase
                .from('articles')
                .update({ status: 'processing' })
                .in('id', ids);
        }

        res.json({ success: true, articles: data || [] });

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
            template_id
        } = req.body;

        const { error } = await supabase
            .from('articles')
            .update({
                headline, headline2, body, conclusion,
                telegram_caption, image_prompt,
                generated_image, cover_image, card_image,
                template_id,
                status: 'ready',
                generated_at: new Date().toISOString()
            })
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// ПУБЛИКАТОР → МОЗГ: получить готовые к публикации
// ═══════════════════════════════════════
app.get('/api/articles/publish', authMiddleware, async (req, res) => {
    try {
        const { niche, channel = 'telegram', limit = 1 } = req.query;

        let query = supabase
            .from('articles')
            .select('*')
            .eq('status', 'ready')
            .order('relevance_score', { ascending: false })
            .limit(parseInt(limit));

        if (niche) query = query.eq('niche', niche);

        const { data, error } = await query;
        if (error) throw error;

        res.json({ success: true, articles: data || [] });

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
        const { channel, message_id } = req.body;

        // Получаем текущий published_channels
        const { data: article } = await supabase
            .from('articles')
            .select('published_channels')
            .eq('id', id)
            .single();

        const channels = article?.published_channels || [];
        channels.push({
            channel,
            message_id,
            published_at: new Date().toISOString()
        });

        const { error } = await supabase
            .from('articles')
            .update({
                published_channels: channels,
                status: 'published',
                published_system_at: new Date().toISOString()
            })
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });

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
        const statuses = ['raw', 'classified', 'processing', 'ready', 'published', 'rejected'];
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


// ═══════════════════════════════════════
// ЗАПУСК
// ═══════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`AdilFlow Brain listening on port ${PORT}`);
    console.log(`Supabase: ${process.env.SUPABASE_URL ? 'connected' : 'NOT SET'}`);
});
