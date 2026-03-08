/**
 * AdilFlow Brain — Сервис 2 (v2)
 * Центральный API всей медиа-сети
 * 
 * v2: Полноценная 4-шаговая классификация
 * - Предфильтр (без ИИ)
 * - Семантическая дедупликация (pgvector + OpenAI embeddings)
 * - Глубокая оценка (GPT-4o-mini, JSON с 6 критериями)
 * - Ранжирование с учётом разнообразия
 */

const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json({ limit: '10mb' }));

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

// ═══════════════════════════════════════
// AUTH
// ═══════════════════════════════════════
function auth(req, res, next) {
    const key = req.headers.authorization?.replace('Bearer ', '');
    if (!key || key !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ═══════════════════════════════════════
// HEALTH
// ═══════════════════════════════════════
app.get('/', (req, res) => {
    res.json({ service: 'AdilFlow Brain', version: '2.0.0', status: 'online' });
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
// ПАРСЕР → МОЗГ: приём статей
// ═══════════════════════════════════════
app.post('/api/articles/batch', auth, async (req, res) => {
    try {
        const { articles, niche } = req.body;
        if (!articles || !Array.isArray(articles)) {
            return res.status(400).json({ error: 'articles array required' });
        }

        let newCount = 0, dupCount = 0, errorCount = 0;

        for (const article of articles) {
            try {
                // Дедупликация по url_hash
                const { data: existing } = await supabase
                    .from('articles')
                    .select('id')
                    .eq('url_hash', article.url_hash)
                    .single();
                if (existing) { dupCount++; continue; }

                // Дедупликация по content_hash
                const { data: contentDup } = await supabase
                    .from('articles')
                    .select('id')
                    .eq('content_hash', article.content_hash)
                    .single();
                if (contentDup) { dupCount++; continue; }

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
                    if (error.code === '23505') dupCount++;
                    else { console.error(`Insert: ${error.message}`); errorCount++; }
                } else {
                    newCount++;
                }
            } catch (e) { errorCount++; }
        }

        console.log(`[BATCH] ${niche}: ${newCount} new, ${dupCount} dups, ${errorCount} err`);
        res.json({ success: true, received: articles.length, new: newCount, duplicates: dupCount, errors: errorCount });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// КЛАССИФИКАЦИЯ v2 — 4 шага
// ═══════════════════════════════════════
app.post('/api/classify', auth, async (req, res) => {
    try {
        const { niche, limit = 50 } = req.body || {};

        // Берём статьи "raw"
        // Берём ПОЛНЫЙ raw_text — GPT видит всю статью
        let query = supabase
            .from('articles')
            .select('id, raw_title, raw_text, raw_summary, niche, published_at, text_length, source_domain, images, has_usable_media')
            .eq('status', 'raw')
            .order('parsed_at', { ascending: false })
            .limit(limit);
        if (niche) query = query.eq('niche', niche);

        const { data: articles, error } = await query;
        if (error) throw error;
        if (!articles || articles.length === 0) {
            return res.json({ message: 'No raw articles', step1_filtered: 0, step2_deduped: 0, step3_classified: 0, step3_rejected: 0 });
        }

        console.log(`[CLASSIFY] Starting with ${articles.length} raw articles`);

        // ─── ШАГ 1: ПРЕДФИЛЬТР (без ИИ, бесплатно) ───
        const step1Results = { passed: [], filtered: 0 };

        for (const a of articles) {
            const filterReason = preFilter(a);
            if (filterReason) {
                // Отклоняем с причиной
                await supabase.from('articles').update({
                    status: 'rejected',
                    scores_detail: { rejected_reason: filterReason, rejected_at: 'prefilter' },
                    classified_at: new Date().toISOString()
                }).eq('id', a.id);
                step1Results.filtered++;
            } else {
                step1Results.passed.push(a);
            }
        }
        console.log(`[STEP 1] Prefilter: ${step1Results.filtered} rejected, ${step1Results.passed.length} passed`);

        if (step1Results.passed.length === 0) {
            return res.json({ message: 'All filtered at step 1', step1_filtered: step1Results.filtered, step2_deduped: 0, step3_classified: 0, step3_rejected: 0 });
        }

        // ─── ШАГ 2: СЕМАНТИЧЕСКАЯ ДЕДУПЛИКАЦИЯ (pgvector) ───
        const step2Results = { passed: [], deduped: 0 };

        for (const a of step1Results.passed) {
            try {
                // Генерируем embedding
                const embedding = await getEmbedding(a.raw_title + '. ' + (a.raw_summary || a.raw_text.slice(0, 300)));

                if (embedding) {
                    // Сохраняем embedding
                    await supabase.from('articles').update({ embedding }).eq('id', a.id);

                    // Ищем похожие (кроме самой статьи)
                    const { data: similar } = await supabase.rpc('find_similar_articles', {
                        query_embedding: embedding,
                        query_niche: a.niche,
                        similarity_threshold: 0.15,
                        max_results: 3
                    });

                    const realSimilar = (similar || []).filter(s => s.id !== a.id);

                    if (realSimilar.length > 0) {
                        await supabase.from('articles').update({
                            status: 'rejected',
                            scores_detail: {
                                rejected_reason: 'semantic_duplicate',
                                similar_to: realSimilar[0].raw_title,
                                similarity: realSimilar[0].similarity
                            },
                            classified_at: new Date().toISOString()
                        }).eq('id', a.id);
                        step2Results.deduped++;
                        continue;
                    }
                }

                step2Results.passed.push(a);
            } catch (e) {
                // Если embedding не сработал — пропускаем шаг, не блокируем
                step2Results.passed.push(a);
            }
        }
        console.log(`[STEP 2] Semantic dedup: ${step2Results.deduped} duplicates, ${step2Results.passed.length} passed`);

        if (step2Results.passed.length === 0) {
            return res.json({ message: 'All deduped at step 2', step1_filtered: step1Results.filtered, step2_deduped: step2Results.deduped, step3_classified: 0, step3_rejected: 0 });
        }

        // ─── ШАГ 3: ГЛУБОКАЯ ОЦЕНКА (GPT-4o-mini) ───
        // Загружаем конфиг ниши для контекстного промпта
        const nicheConfigs = {};
        const nicheIds = [...new Set(step2Results.passed.map(a => a.niche))];
        for (const n of nicheIds) {
            const { data } = await supabase.from('niches').select('*').eq('id', n).single();
            nicheConfigs[n] = data;
        }

        let classified = 0, rejected = 0;

        for (const a of step2Results.passed) {
            try {
                const scores = await deepEvaluate(a, nicheConfigs[a.niche]);

                // PUBLISH и MAYBE → classified, SKIP → rejected
                const newStatus = scores.verdict === 'SKIP' ? 'rejected' : 'classified';

                await supabase.from('articles').update({
                    relevance_score: scores.overall,
                    scores_detail: scores,
                    status: newStatus,
                    classified_at: new Date().toISOString()
                }).eq('id', a.id);

                if (newStatus === 'classified') classified++;
                else rejected++;

            } catch (e) {
                console.error(`[STEP 3] Error on ${a.id}: ${e.message}`);
                // Не блокируем — оставляем как raw
            }
        }
        console.log(`[STEP 3] Deep eval: ${classified} classified, ${rejected} rejected`);

        // ─── ШАГ 4: РАНЖИРОВАНИЕ (автоматическое через relevance_score) ───
        // GET /api/articles/ready уже сортирует по relevance_score desc
        // + проверка разнообразия при выдаче

        const result = {
            success: true,
            total_input: articles.length,
            step1_filtered: step1Results.filtered,
            step2_deduped: step2Results.deduped,
            step3_classified: classified,
            step3_rejected: rejected,
            final_ready: classified
        };
        console.log(`[CLASSIFY] Done:`, result);
        res.json(result);

    } catch (e) {
        console.error(`[CLASSIFY ERROR] ${e.message}`);
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// ШАГ 1: ПРЕДФИЛЬТР
// Возвращает причину отклонения или null
// ═══════════════════════════════════════
function preFilter(article) {
    // Слишком короткий текст
    if (article.text_length < 500) {
        return 'text_too_short';
    }

    // Спам-слова в заголовке
    const titleLower = article.raw_title.toLowerCase();
    const spamWords = ['sponsored', 'advertisement', 'partner content', 'paid post',
        'buy now', 'discount', 'coupon', 'promo code', 'affiliate',
        'this post contains affiliate', 'shop now'];
    for (const word of spamWords) {
        if (titleLower.includes(word)) return 'spam_title';
    }

    // Статья — список/подборка без новости
    const listPatterns = ['top 10', 'top 5', 'best of', '10 ways', '5 things',
        'you need to know', 'listicle', 'round-up', 'roundup'];
    for (const p of listPatterns) {
        if (titleLower.includes(p)) return 'listicle';
    }

    // Слишком старая (> 7 дней)
    if (article.published_at) {
        const pubDate = new Date(article.published_at);
        const now = new Date();
        const daysAgo = (now - pubDate) / (1000 * 60 * 60 * 24);
        if (daysAgo > 7) return 'too_old';
    }

    return null; // Прошёл фильтр
}


// ═══════════════════════════════════════
// ШАГ 2: EMBEDDINGS (OpenAI)
// ═══════════════════════════════════════
async function getEmbedding(text) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return null;

    try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                input: text.slice(0, 1000), // Лимит чтобы не тратить токены
                model: 'text-embedding-3-small',
                dimensions: 384  // Совпадает с vector(384) в schema
            })
        });

        const data = await response.json();
        if (data.data && data.data[0]) {
            return JSON.stringify(data.data[0].embedding);
        }
        return null;
    } catch (e) {
        console.error(`[EMBEDDING] ${e.message}`);
        return null;
    }
}


// ═══════════════════════════════════════
// ШАГ 3: ГЛУБОКАЯ ОЦЕНКА
// GPT получает ПОЛНЫЙ текст статьи
// ═══════════════════════════════════════
async function deepEvaluate(article, nicheConfig) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { overall: 5, note: 'no_api_key' };

    const nicheLanguage = nicheConfig?.language || 'ru';

    const systemPrompt = `Ты — главный редактор вирусного Telegram-канала о здоровье и медицине.

АУДИТОРИЯ:
- Обычные люди 25-55 лет, русскоязычные
- Интересуются здоровьем для себя и семьи
- НЕ врачи — им нужен простой язык, не термины
- Любят удивляться: "ого, не знал!"
- Ценят практические советы которые можно применить сегодня

СТИЛЬ КАНАЛА:
- Вирусный, цепляющий, wow-эффект
- Заголовки вызывают желание кликнуть и переслать друзьям
- Научная база есть, но подана как "учёные доказали" а не abstract из журнала

ТВОЯ ЗАДАЧА:
Оценить статью — стоит ли её публиковать на канале.
Ты СТРОГИЙ фильтр. Из 50 статей в день публикуем только 3-5 лучших.
Будь безжалостен к скучным, узким и непрактичным статьям.

Отвечай ТОЛЬКО валидным JSON, без markdown, без бэктиков.`;

    // Отправляем ПОЛНЫЙ текст статьи (GPT-4o-mini = 128K контекст, хватит)
    const fullText = article.raw_text || '';

    const userPrompt = `Оцени эту статью для нашего канала:

ЗАГОЛОВОК: ${article.raw_title}
ИСТОЧНИК: ${article.source_domain}
ДАТА ПУБЛИКАЦИИ: ${article.published_at || 'неизвестно'}
ЕСТЬ ФОТО: ${article.has_usable_media ? 'Да' : 'Нет'}

ПОЛНЫЙ ТЕКСТ СТАТЬИ:
${fullText}

---

Оцени по 5 критериям от 1 до 10:

1. mass_relevance — Касается ли это МНОГИХ людей?
   10 = рак, диабет, ожирение, сон, питание, сердце (миллионы)
   7 = аллергия, депрессия, спина, зрение (сотни тысяч)
   4 = редкая болезнь, узкая группа людей
   1 = касается единиц, академическая тема

2. practical_value — Может ли читатель ПРИМЕНИТЬ это в жизни?
   10 = конкретный совет ("ешь X — снижает риск Y на 30%")
   7 = общая рекомендация ("больше двигаться помогает от Z")
   4 = интересно но нельзя применить ("нашли ген отвечающий за X")
   1 = чистая теория, лабораторные мыши, ноль практики

3. wow_factor — Вызывает ли реакцию "ого, серьёзно?!"
   10 = переворачивает общепринятое мнение ("кофе ПОЛЕЗЕН для печени")
   7 = неожиданный факт ("телефон в туалете вызывает проблемы")
   4 = ожидаемый результат ("спорт полезен для сердца")
   1 = скучно, очевидно, никого не удивит

4. shareability — Перешлёт ли человек это маме/другу?
   10 = "мам, почитай срочно!" (касается здоровья близких)
   7 = "прикинь, что учёные нашли" (интересный факт для беседы)
   4 = "ну, любопытно" (прочтёт и забудет)
   1 = не перешлёт никому

5. freshness — Насколько НОВАЯ информация?
   10 = первое такое исследование в мире
   7 = новый поворот в известной теме
   4 = тема уже обсуждалась, это обновление
   1 = перепечатка старого

Верни JSON:
{
  "mass_relevance": число,
  "practical_value": число,
  "wow_factor": число,
  "shareability": число,
  "freshness": число,
  "overall": число,
  "verdict": "PUBLISH" или "MAYBE" или "SKIP",
  "reason": "1 предложение на русском — почему такая оценка",
  "hook_ru": "Цепляющий заголовок на русском для Telegram, до 10 слов, капслок"
}

Правила overall:
overall = (mass_relevance × 2.0 + practical_value × 1.5 + wow_factor × 1.5 + shareability × 1.5 + freshness × 1.0) / 7.5
Если overall >= 7.0 → "PUBLISH"
Если overall 5.0-6.9 → "MAYBE"  
Если overall < 5.0 → "SKIP"`;

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'gpt-4o-mini',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                max_tokens: 400,
                temperature: 0.3
            })
        });

        const data = await response.json();
        const text = data.choices?.[0]?.message?.content?.trim() || '{}';

        // Парсим JSON (убираем возможные ```json обёртки)
        const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const scores = JSON.parse(clean);

        // Пересчитываем overall по нашей формуле (не доверяем GPT считать)
        const weighted = (
            (scores.mass_relevance || 5) * 2.0 +
            (scores.practical_value || 5) * 1.5 +
            (scores.wow_factor || 5) * 1.5 +
            (scores.shareability || 5) * 1.5 +
            (scores.freshness || 5) * 1.0
        ) / 7.5;

        scores.overall = Math.round(weighted * 10) / 10;

        // Пересчитываем verdict
        if (scores.overall >= 7.0) scores.verdict = 'PUBLISH';
        else if (scores.overall >= 5.0) scores.verdict = 'MAYBE';
        else scores.verdict = 'SKIP';

        return scores;

    } catch (e) {
        console.error(`[DEEP EVAL] ${e.message}`);
        return { overall: 5, error: e.message };
    }
}


// ═══════════════════════════════════════
// ГЕНЕРАТОР → МОЗГ: получить топ статьи
// С учётом разнообразия (не все из одного источника)
// ═══════════════════════════════════════
app.get('/api/articles/ready', auth, async (req, res) => {
    try {
        const { niche, limit = 5 } = req.query;

        // Берём больше — для фильтрации разнообразия
        // Сначала PUBLISH (overall >= 7), потом MAYBE
        let query = supabase
            .from('articles')
            .select('*')
            .eq('status', 'classified')
            .order('relevance_score', { ascending: false })
            .limit(parseInt(limit) * 3);
        if (niche) query = query.eq('niche', niche);

        const { data, error } = await query;
        if (error) throw error;

        // Разнообразие — не больше 2 статей из одного источника
        const result = [];
        const sourceCounts = {};

        for (const a of (data || [])) {
            const src = a.source_domain;
            sourceCounts[src] = (sourceCounts[src] || 0) + 1;
            if (sourceCounts[src] <= 2) {
                result.push(a);
            }
            if (result.length >= parseInt(limit)) break;
        }

        // Помечаем как "processing"
        if (result.length > 0) {
            const ids = result.map(a => a.id);
            await supabase.from('articles').update({ status: 'processing' }).in('id', ids);
        }

        res.json({ success: true, count: result.length, articles: result });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// ГЕНЕРАТОР → МОЗГ: сохранить контент
// ═══════════════════════════════════════
app.post('/api/articles/:id/generated', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { headline, headline2, body, conclusion, telegram_caption, image_prompt,
                generated_image, cover_image, card_image, template_id } = req.body;

        const { error } = await supabase.from('articles').update({
            headline, headline2, body, conclusion, telegram_caption, image_prompt,
            generated_image, cover_image, card_image, template_id,
            status: 'ready',
            generated_at: new Date().toISOString()
        }).eq('id', id);

        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// ПУБЛИКАТОР → МОЗГ
// ═══════════════════════════════════════
app.get('/api/articles/publish', auth, async (req, res) => {
    try {
        const { niche, channel = 'telegram', limit = 1 } = req.query;
        let query = supabase.from('articles').select('*').eq('status', 'ready')
            .order('relevance_score', { ascending: false }).limit(parseInt(limit));
        if (niche) query = query.eq('niche', niche);
        const { data, error } = await query;
        if (error) throw error;
        res.json({ success: true, articles: data || [] });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/articles/:id/published', auth, async (req, res) => {
    try {
        const { id } = req.params;
        const { channel, message_id } = req.body;
        const { data: article } = await supabase.from('articles')
            .select('published_channels').eq('id', id).single();
        const channels = article?.published_channels || [];
        channels.push({ channel, message_id, published_at: new Date().toISOString() });

        const { error } = await supabase.from('articles').update({
            published_channels: channels,
            status: 'published',
            published_system_at: new Date().toISOString()
        }).eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// СТАТИСТИКА
// ═══════════════════════════════════════
app.get('/api/stats', auth, async (req, res) => {
    try {
        const { niche } = req.query;
        const statuses = ['raw', 'classified', 'processing', 'ready', 'published', 'rejected'];
        const counts = {};
        for (const status of statuses) {
            let q = supabase.from('articles').select('*', { count: 'exact', head: true }).eq('status', status);
            if (niche) q = q.eq('niche', niche);
            const { count } = await q;
            counts[status] = count || 0;
        }
        let totalQ = supabase.from('articles').select('*', { count: 'exact', head: true });
        if (niche) totalQ = totalQ.eq('niche', niche);
        const { count: total } = await totalQ;

        res.json({ success: true, niche: niche || 'all', total: total || 0, by_status: counts });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// НИШИ
// ═══════════════════════════════════════
app.get('/api/niches', auth, async (req, res) => {
    try {
        const { data, error } = await supabase.from('niches').select('*').eq('is_active', true);
        if (error) throw error;
        res.json({ success: true, niches: data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// УТИЛИТА: сбросить статусы для ретеста
// ═══════════════════════════════════════
app.post('/api/reset', auth, async (req, res) => {
    try {
        const { niche } = req.body || {};
        let query = supabase.from('articles').update({
            status: 'raw',
            relevance_score: null,
            scores_detail: null,
            embedding: null,
            classified_at: null
        });
        if (niche) query = query.eq('niche', niche);
        else query = query.neq('status', 'published'); // Не трогаем опубликованные

        const { error } = await query;
        if (error) throw error;
        res.json({ success: true, message: 'Statuses reset to raw' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ═══════════════════════════════════════
// ЗАПУСК
// ═══════════════════════════════════════
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`AdilFlow Brain v2 listening on port ${PORT}`);
    console.log(`Supabase: ${process.env.SUPABASE_URL ? 'connected' : 'NOT SET'}`);
});
