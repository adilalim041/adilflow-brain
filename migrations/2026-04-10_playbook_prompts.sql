-- Add full prompt template fields to content_playbooks
ALTER TABLE content_playbooks ADD COLUMN IF NOT EXISTS system_prompt TEXT;
ALTER TABLE content_playbooks ADD COLUMN IF NOT EXISTS image_system_prompt TEXT;
ALTER TABLE content_playbooks ADD COLUMN IF NOT EXISTS user_prompt_template TEXT;
