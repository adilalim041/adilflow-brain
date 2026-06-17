-- News.AI entity asset catalog + image style presets.
-- Safe to run multiple times.

create table if not exists entities (
    slug                text primary key,
    name                text not null,
    entity_type         text not null check (entity_type in ('company', 'person', 'product', 'organization', 'place')),
    aliases             text[] not null default '{}',
    parent_entity_slug  text references entities(slug) on delete set null,
    notes               text,
    is_active           boolean not null default true,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_entities_type_active
    on entities(entity_type, is_active, name);

drop trigger if exists entities_updated on entities;
create trigger entities_updated
    before update on entities
    for each row execute function update_modified_column();

create table if not exists entity_assets (
    id                              bigint generated always as identity primary key,
    entity_slug                     text not null references entities(slug) on delete cascade,
    asset_type                      text not null check (
        asset_type in (
            'logo_icon',
            'logo_wordmark',
            'person_reference',
            'person_cutout',
            'product_photo',
            'source_photo',
            'symbol'
        )
    ),
    variant                         text not null default 'primary',
    display_name                    text,
    person_entity_slug              text references entities(slug) on delete set null,
    source_url                      text,
    source_name                     text,
    license_note                    text,
    cloudinary_url                  text not null,
    cloudinary_public_id            text,
    cutout_cloudinary_url           text,
    cutout_cloudinary_public_id     text,
    width                           int,
    height                          int,
    quality_score                   int check (quality_score is null or quality_score between 0 and 100),
    status                          text not null default 'needs_review' check (
        status in ('needs_review', 'approved', 'rejected', 'archived')
    ),
    metadata                        jsonb not null default '{}'::jsonb,
    created_at                      timestamptz not null default now(),
    updated_at                      timestamptz not null default now()
);

create unique index if not exists idx_entity_assets_unique_variant
    on entity_assets(entity_slug, asset_type, variant, person_entity_slug) nulls not distinct;

create index if not exists idx_entity_assets_lookup
    on entity_assets(entity_slug, asset_type, status, quality_score desc nulls last);

drop trigger if exists entity_assets_updated on entity_assets;
create trigger entity_assets_updated
    before update on entity_assets
    for each row execute function update_modified_column();

create table if not exists image_style_presets (
    slug                        text primary key,
    name                        text not null,
    category                    text not null default 'editorial',
    prompt_template             text not null,
    negative_prompt             text not null default '',
    use_cases                   text[] not null default '{}',
    requires_entity_assets      boolean not null default false,
    supports_person_reference   boolean not null default false,
    supports_logo_layer         boolean not null default true,
    priority                    int not null default 100,
    is_active                   boolean not null default true,
    metadata                    jsonb not null default '{}'::jsonb,
    created_at                  timestamptz not null default now(),
    updated_at                  timestamptz not null default now()
);

create index if not exists idx_image_style_presets_active
    on image_style_presets(is_active, priority, category);

drop trigger if exists image_style_presets_updated on image_style_presets;
create trigger image_style_presets_updated
    before update on image_style_presets
    for each row execute function update_modified_column();

insert into entities (slug, name, entity_type, aliases, notes)
values
    ('openai', 'OpenAI', 'company', array['OpenAI', 'ChatGPT'], 'Prefer logo_icon without text for post overlays.'),
    ('anthropic', 'Anthropic', 'company', array['Anthropic', 'Claude'], 'Prefer icon-only mark when available.'),
    ('google', 'Google', 'company', array['Google', 'Gemini', 'DeepMind'], 'Use icon-only mark where possible.'),
    ('apple', 'Apple', 'company', array['Apple', 'Siri'], 'Use Apple icon, not wordmark.'),
    ('meta', 'Meta', 'company', array['Meta', 'Facebook', 'Instagram', 'Threads'], 'Use icon-only mark where possible.'),
    ('xai', 'xAI', 'company', array['xAI', 'Grok'], 'Use icon-only mark where possible.')
on conflict (slug) do update set
    name = excluded.name,
    entity_type = excluded.entity_type,
    aliases = excluded.aliases,
    notes = excluded.notes;

insert into image_style_presets (
    slug, name, category, prompt_template, negative_prompt, use_cases,
    requires_entity_assets, supports_person_reference, supports_logo_layer, priority
)
values
    (
        'founder_symbolic_metaphor',
        'Founder Symbolic Metaphor',
        'metaphor',
        'Editorial symbolic metaphor for an AI news Instagram cover. Use the provided person reference only for facial identity and general likeness. Create the person in a new symbolic scene: {{metaphor_scene}}. This is not a real event photo; it is clearly editorial/satirical. Leave lower-third space for headline and leave background space for a real company logo layer behind the subject.',
        'no generated logos, no readable text, no fake UI, no watermarks, no documentary claim, no exact recreation of a real event',
        array['founder news', 'company grants', 'lawsuits', 'launches', 'dramatic announcements'],
        true, true, true, 10
    ),
    (
        'press_photo_realistic',
        'Press Photo Realistic',
        'realistic',
        'Ultra-realistic candid press photograph for an AI/tech news story about {{title}}. Natural people, real office or event environment, imperfect documentary composition, realistic faces, natural light, lower-third negative space.',
        'no robots, no cyberpunk, no abstract data streams, no generated logos, no readable text, no poster look',
        array['general tech news', 'company updates', 'product announcements'],
        false, false, true, 20
    ),
    (
        'business_pressure_desk',
        'Business Pressure Desk',
        'business',
        'Realistic editorial photograph of a tense business/tech desk scene about {{title}}: laptop, papers, budget pressure, executives or analysts, natural office lighting, candid expression, lower-third negative space.',
        'no fake text, no logos, no shiny AI symbols, no cyberpunk',
        array['pricing', 'costs', 'funding', 'layoffs', 'market pressure'],
        false, false, true, 30
    ),
    (
        'legal_courthouse_press',
        'Legal Courthouse Press',
        'legal',
        'Realistic courthouse or legal hallway press-photo scene about {{title}}: folders, attorneys, serious expressions, institutional lighting, no readable documents, lower-third negative space.',
        'no generated logos, no readable case names, no fake text, no courtroom fantasy',
        array['lawsuits', 'copyright', 'regulation', 'investigations'],
        false, false, true, 40
    ),
    (
        'government_meeting_press',
        'Government Meeting Press',
        'government',
        'Realistic government or policy meeting photo about {{title}}: officials around a table, papers and tablet, candid discussion, natural window light, no readable seals, lower-third negative space.',
        'no real politician likeness unless provided, no readable emblems, no propaganda poster style',
        array['policy', 'government', 'geopolitics', 'defense'],
        false, false, true, 50
    ),
    (
        'developer_workspace',
        'Developer Workspace',
        'product',
        'Realistic developer workspace scene about {{title}}: laptop, code-like blurred screen with no readable text, notebooks, coffee, team in background, natural startup lighting, lower-third negative space.',
        'no readable code, no generated logos, no neon cyberpunk, no robots',
        array['developer tools', 'APIs', 'SDKs', 'launches'],
        false, false, true, 60
    ),
    (
        'product_phone_closeup',
        'Product Phone Closeup',
        'product',
        'Realistic close-up of hands holding a smartphone or laptop product context for {{title}}, screen glow but no readable UI text, candid office background, lower-third negative space.',
        'no fake app text, no generated brand logos, no perfect mockup look',
        array['apps', 'ChatGPT', 'mobile products', 'subscriptions'],
        false, false, true, 70
    ),
    (
        'market_chart_scene',
        'Market Chart Scene',
        'business',
        'Realistic financial newsroom or analyst desk scene about {{title}} with abstract charts blurred in background, people looking at monitors, natural contrast, lower-third negative space.',
        'no readable tickers, no fake numbers, no glowing data streams',
        array['market share', 'stocks', 'business metrics'],
        false, false, true, 80
    ),
    (
        'company_campus_press',
        'Company Campus Press',
        'realistic',
        'Realistic exterior or campus press-photo style scene about {{title}}: office building, employees, event context, natural daylight, lower-third negative space.',
        'no readable signage, no generated logos, no fantasy architecture',
        array['company news', 'campus events', 'walkouts'],
        false, false, true, 90
    ),
    (
        'symbolic_object_macro',
        'Symbolic Object Macro',
        'metaphor',
        'Realistic macro editorial object metaphor for {{title}}: one strong physical object representing the story, premium photography, shallow depth of field, simple background, lower-third negative space.',
        'no text, no logos, no abstract AI blobs, no cyberpunk',
        array['abstract stories', 'privacy', 'safety', 'model releases'],
        false, false, true, 100
    )
on conflict (slug) do update set
    name = excluded.name,
    category = excluded.category,
    prompt_template = excluded.prompt_template,
    negative_prompt = excluded.negative_prompt,
    use_cases = excluded.use_cases,
    requires_entity_assets = excluded.requires_entity_assets,
    supports_person_reference = excluded.supports_person_reference,
    supports_logo_layer = excluded.supports_logo_layer,
    priority = excluded.priority,
    is_active = true;
