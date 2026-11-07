-- The collaborator service DDL also ensures this index on startup.
-- Restrict a thread page by its authorized task IDs before applying the ID cursor.
CREATE INDEX IF NOT EXISTS threads_task_page ON threads (realm, task_id, id);
