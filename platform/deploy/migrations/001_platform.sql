-- Versioned platform-owned migration. Service DDL remains idempotent for local-lite,
-- while production upgrades are recorded centrally before rolling deployments.
CREATE TABLE IF NOT EXISTS lumo_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS lumo_service_heartbeats (
  service TEXT PRIMARY KEY,
  instance TEXT NOT NULL,
  status TEXT NOT NULL,
  version TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
