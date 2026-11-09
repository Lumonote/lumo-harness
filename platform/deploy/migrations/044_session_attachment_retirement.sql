-- 逻辑退役保留历史、分支与配额；旧共享内容没有物理删除权威。
ALTER TABLE session_attachment_receipts ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;
