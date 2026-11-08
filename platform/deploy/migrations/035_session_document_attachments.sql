-- Preserve existing receipts while enabling bounded read-only document previews.
ALTER TABLE session_attachment_receipts DROP CONSTRAINT IF EXISTS session_attachment_receipts_kind_check;
ALTER TABLE session_attachment_receipts ADD CONSTRAINT session_attachment_receipts_kind_check CHECK(kind IN ('text','image','document'));
