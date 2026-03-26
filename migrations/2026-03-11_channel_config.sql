-- AdilFlow Brain: channel configuration layer
-- Safe to run multiple times.

create or replace function update_modified_column()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

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

drop trigger if exists channel_profiles_updated on channel_profiles;
create trigger channel_profiles_updated
    before update on channel_profiles
    for each row execute function update_modified_column();

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

drop trigger if exists content_playbooks_updated on content_playbooks;
create trigger content_playbooks_updated
    before update on content_playbooks
    for each row execute function update_modified_column();

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

drop trigger if exists template_bindings_updated on template_bindings;
create trigger template_bindings_updated
    before update on template_bindings
    for each row execute function update_modified_column();
