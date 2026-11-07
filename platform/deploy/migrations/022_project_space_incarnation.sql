-- A recreated Space is a new authority resource, even when its public ID is
-- reused. Both Projects writers preserve this value on ordinary upserts.
ALTER TABLE project_spaces ADD COLUMN IF NOT EXISTS incarnation UUID NOT NULL DEFAULT gen_random_uuid();
