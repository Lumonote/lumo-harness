-- 可发送名额与逻辑保留配额分开：退役保留历史字节，不再占用活跃上传名额。
CREATE INDEX IF NOT EXISTS session_attachment_receipts_active ON session_attachment_receipts(realm,session_ref,receipt_id) WHERE retired_at IS NULL;
