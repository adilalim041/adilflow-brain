-- Migration: 2026-04-10_channel_credentials
-- Add per-channel Instagram credentials to channel_profiles
-- Enables multi-channel publishing without global env vars

ALTER TABLE channel_profiles ADD COLUMN IF NOT EXISTS ig_user_id text;
ALTER TABLE channel_profiles ADD COLUMN IF NOT EXISTS ig_access_token text;
