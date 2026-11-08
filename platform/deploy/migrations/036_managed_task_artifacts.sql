-- Extend only the isolated managed namespace. Legacy content/ objects remain
-- outside physical collection, including after logical artifact withdrawal.
ALTER TABLE managed_content_objects DROP CONSTRAINT IF EXISTS managed_content_objects_reservation_kind_check;
ALTER TABLE managed_content_objects ADD CONSTRAINT managed_content_objects_reservation_kind_check CHECK(reservation_kind IN ('knowledge-file','task-artifact','cold-log-segment'));
ALTER TABLE managed_content_references DROP CONSTRAINT IF EXISTS managed_content_references_kind_check;
ALTER TABLE managed_content_references ADD CONSTRAINT managed_content_references_kind_check CHECK(kind IN ('knowledge-file','task-artifact','cold-log-segment'));
