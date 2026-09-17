-- Service heartbeats feed derived cluster readiness (see
-- platform/control-plane/heartbeat). Two corrections to the table created by
-- 001_platform.sql:
--
-- 1. The primary key was `service` alone, so two replicas of one service
--    overwrote each other's row and one of them was invisible. Keying on
--    (service, instance) keeps every replica reportable: readiness then needs
--    only one serving replica, while a replica that went quiet stays visible in
--    the report instead of disappearing.
-- 2. `dependencies` carries each instance's own view of the dependencies it can
--    actually probe. That is what lets readiness reflect "PostgreSQL is down for
--    the scheduler" instead of a value an operator typed once.
--
-- CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so the
-- key change has to be an explicit ALTER (same reason and same shape as
-- 002_collaborator_realm_grants.sql). The service-side DDL in
-- platform/control-plane/heartbeat executes these same idempotent statements, so
-- a Compose deployment that never runs migrate.sh converges on the same shape.
ALTER TABLE lumo_service_heartbeats
  DROP CONSTRAINT IF EXISTS lumo_service_heartbeats_pkey;

ALTER TABLE lumo_service_heartbeats
  ADD CONSTRAINT lumo_service_heartbeats_pkey PRIMARY KEY (service, instance);

ALTER TABLE lumo_service_heartbeats
  ADD COLUMN IF NOT EXISTS dependencies JSONB NOT NULL DEFAULT '{}'::jsonb;
