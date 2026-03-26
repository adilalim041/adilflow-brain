-- ═══════════════════════════════════════
-- AdilFlow Brain — Supabase Schema
-- Запусти этот SQL в Supabase SQL Editor
-- ═══════════════════════════════════════



-- 1. Включаем pgvector для семантической дедупликации
create extension if not exists vector;

-- ═══════════════════════════════════════
-- ТАБЛИЦА: articles
-- Центральная таблица всей системы
-- ═══════════════════════════════════════
create table if not exists articles (
    id              bigint generated always as identity primary key,

    -- Идентификация и дедупликация
    url             text not null,
    url_hash        text not null unique,        -- MD5(url), точная дедупликация
    content_hash    text not null,               -- MD5(text), контентная дедупликация
    embedding       vector(384),                 -- Семантический вектор (для pgvector)

    -- Источник
    source_name     text not null,               -- "ScienceDaily Health"
    source_domain   text not null,               -- "www.sciencedaily.com"
    niche           text not null,               -- "health_medicine", "ai_news", etc.

    -- Сырой контент (от Парсера, без обработки)
    raw_title       text not null,
    raw_text        text not null,
    raw_summary     text default '',
    authors         text[] default '{}',

    -- Медиа (от Парсера)
    images          text[] default '{}',         -- Массив URL картинок
    top_image       text,                        -- Лучшая картинка
    image_count     int default 0,
    videos          text[] default '{}',
    video_count     int default 0,
    has_usable_media boolean default false,       -- Есть готовая картинка?

    -- Оценка ИИ (заполняет Мозг при классификации)
    relevance_score  float,                      -- 0-10, среднее от ensemble
    scores_detail    jsonb,                      -- {"gpt": 8, "gemini": 7, "haiku": 9}

    -- Сгенерированный контент (заполняет Генератор)
    headline        text,
    headline2       text,
    body            text,
    conclusion      text,
    telegram_caption text,
    image_prompt    text,                        -- Промпт для DALL-E (если нет своей картинки)
    generated_image text,                        -- URL сгенерированной картинки
    cover_image     text,                        -- URL финальной обложки (после Railway overlay)
    card_image      text,                        -- URL текстовой карточки

    -- Шаблон
    template_id     text,                        -- ID шаблона из Template Editor

    -- Публикация
    status          text not null default 'raw',
    -- raw → classified → processing → ready → published → rejected
    published_channels jsonb default '[]',       -- [{"channel":"telegram","id":123,"at":"..."}]

    -- Метаданные
    published_at    timestamptz,                 -- Дата публикации оригинала
    parsed_at       timestamptz not null default now(),
    classified_at   timestamptz,
    generated_at    timestamptz,
    published_system_at timestamptz,             -- Когда мы опубликовали
    text_length     int default 0,

    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- ═══════════════════════════════════════
-- ИНДЕКСЫ
-- ═══════════════════════════════════════

-- Быстрый поиск дублей по URL
create index if not exists idx_articles_url_hash on articles(url_hash);

-- Быстрый поиск по нише и статусу (основной запрос)
create index if not exists idx_articles_niche_status on articles(niche, status);

-- Сортировка по релевантности
create index if not exists idx_articles_relevance on articles(relevance_score desc nulls last);

-- Семантический поиск (pgvector cosine distance)
create index if not exists idx_articles_embedding on articles
    using ivfflat (embedding vector_cosine_ops)
    with (lists = 100);

-- Поиск по дате парсинга
create index if not exists idx_articles_parsed on articles(parsed_at desc);

-- Поиск по домену
create index if not exists idx_articles_domain on articles(source_domain);


-- ═══════════════════════════════════════
-- ТАБЛИЦА: sources
-- Реестр источников по нишам
-- ═══════════════════════════════════════
create table if not exists sources (
    id              bigint generated always as identity primary key,
    name            text not null,               -- "ScienceDaily Health"
    url             text not null unique,         -- RSS URL
    niche           text not null,
    source_type     text default 'rss',          -- rss, scrape, api
    is_active       boolean default true,
    has_good_images boolean default true,         -- false = стоковые/водяные знаки
    last_parsed_at  timestamptz,
    article_count   int default 0,
    avg_relevance   float,                       -- Средняя оценка статей с этого источника
    created_at      timestamptz not null default now()
);


-- ═══════════════════════════════════════
-- ТАБЛИЦА: niches
-- Конфигурация ниш
-- ═══════════════════════════════════════
create table if not exists niches (
    id              text primary key,            -- "health_medicine", "ai_news"
    name            text not null,               -- "Здоровье и Медицина"
    language        text default 'ru',           -- Язык генерации
    telegram_chat_id text,                       -- ID канала
    instagram_account text,
    threads_account text,
    publish_schedule text default '08:00',       -- Время публикации
    posts_per_day   int default 1,
    gpt_system_prompt text,                      -- Промпт для генерации контента
    is_active       boolean default true,
    created_at      timestamptz not null default now()
);

-- ======================================
-- TABLE: channel_profiles
-- Channel profiles on top of the shared brain
-- ======================================
create table if not exists channel_profiles (
    id              bigint generated always as identity primary key,
    key             text not null unique,
    name            text not null,
    platform        text not null default 'instagram',
    niche           text not null references niches(id) on delete cascade,
    language        text default 'ru',
    account_ref     text,
    posting_mode    text default 'manual',
    priority        int default 100,
    settings        jsonb default '{}'::jsonb,
    is_active       boolean default true,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index if not exists idx_channel_profiles_platform_niche
    on channel_profiles(platform, niche, is_active, priority);

-- ======================================
-- TABLE: content_playbooks
-- Editorial and marketing rules for the generator
-- ======================================
create table if not exists content_playbooks (
    id                      bigint generated always as identity primary key,
    key                     text not null unique,
    channel_profile_id      bigint references channel_profiles(id) on delete set null,
    niche                   text not null references niches(id) on delete cascade,
    platform                text not null default 'instagram',
    format                  text not null default 'feed_post',
    language                text default 'ru',
    headline_rules          text[] default '{}',
    subheadline_rules       text[] default '{}',
    caption_rules           text[] default '{}',
    image_rules             text[] default '{}',
    image_prompt_template   text default '',
    examples                jsonb default '[]'::jsonb,
    is_active               boolean default true,
    created_at              timestamptz not null default now(),
    updated_at              timestamptz not null default now()
);

create index if not exists idx_content_playbooks_scope
    on content_playbooks(platform, niche, is_active, updated_at desc);

-- ======================================
-- TABLE: template_bindings
-- Template assignments by channel and format
-- ======================================
create table if not exists template_bindings (
    id                  bigint generated always as identity primary key,
    channel_profile_id  bigint references channel_profiles(id) on delete cascade,
    niche               text not null references niches(id) on delete cascade,
    platform            text not null default 'instagram',
    format              text not null default 'feed_post',
    template_id         text not null,
    template_slug       text,
    priority            int default 100,
    notes               text,
    is_active           boolean default true,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_template_bindings_scope
    on template_bindings(platform, niche, is_active, priority);



-- ═══════════════════════════════════════
-- ТАБЛИЦА: api_keys
-- Аутентификация сервисов
-- ═══════════════════════════════════════
create table if not exists api_keys (
    id              bigint generated always as identity primary key,
    key_hash        text not null unique,        -- SHA256 хеш ключа
    service_name    text not null,               -- "parser", "generator", "publisher"
    permissions     text[] default '{}',         -- ["read", "write", "classify"]
    is_active       boolean default true,
    created_at      timestamptz not null default now()
);


-- ═══════════════════════════════════════
-- ФУНКЦИЯ: автоматический updated_at
-- ═══════════════════════════════════════
create or replace function update_modified_column()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create or replace trigger articles_updated
    before update on articles
    for each row execute function update_modified_column();

drop trigger if exists channel_profiles_updated on channel_profiles;
create trigger channel_profiles_updated
    before update on channel_profiles
    for each row execute function update_modified_column();

drop trigger if exists content_playbooks_updated on content_playbooks;
create trigger content_playbooks_updated
    before update on content_playbooks
    for each row execute function update_modified_column();

drop trigger if exists template_bindings_updated on template_bindings;
create trigger template_bindings_updated
    before update on template_bindings
    for each row execute function update_modified_column();


-- ═══════════════════════════════════════
-- ФУНКЦИЯ: семантический поиск дублей
-- Находит статьи похожие по смыслу (cosine distance < 0.15)
-- ═══════════════════════════════════════
create or replace function find_similar_articles(
    query_embedding vector(384),
    query_niche text,
    similarity_threshold float default 0.15,
    max_results int default 5
)
returns table (
    id bigint,
    raw_title text,
    similarity float
) as $$
begin
    return query
    select
        a.id,
        a.raw_title,
        1 - (a.embedding <=> query_embedding) as similarity
    from articles a
    where a.niche = query_niche
        and a.embedding is not null
        and 1 - (a.embedding <=> query_embedding) > (1 - similarity_threshold)
    order by a.embedding <=> query_embedding
    limit max_results;
end;
$$ language plpgsql;


-- ═══════════════════════════════════════
-- НАЧАЛЬНЫЕ ДАННЫЕ
-- ═══════════════════════════════════════

-- Ниша: AI News (наш существующий канал)
insert into niches (id, name, language, telegram_chat_id, publish_schedule, posts_per_day, gpt_system_prompt)
values (
    'ai_news',
    'AI Новости',
    'ru',
    '417438841',
    '08:00',
    1,
    'Ты AI-новостной редактор. Пишешь на русском. Формат: headline (до 6 слов, капслок), headline2 (до 5 слов), body (3-4 предложения, суть), conclusion (CTA, 1 предложение), telegram (пост 3-4 предложения с эмодзи).'
)
on conflict (id) do nothing;

-- Ниша: Health & Medicine (новый канал)
insert into niches (id, name, language, telegram_chat_id, publish_schedule, posts_per_day, gpt_system_prompt)
values (
    'health_medicine',
    'Здоровье и Медицина',
    'ru',
    '',  -- Заполнить после создания канала
    '09:00',
    1,
    'Ты медицинский редактор. Пишешь на русском для широкой аудитории. Переводи сложные термины простым языком. Формат: headline (до 6 слов, капслок), headline2 (до 5 слов), body (3-4 предложения, суть открытия/исследования), conclusion (практический совет или CTA), telegram (пост 3-4 предложения с эмодзи).'
)
on conflict (id) do nothing;
