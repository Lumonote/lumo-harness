-- Isolated managed namespace only. Legacy realm/content objects are never GC candidates.
CREATE TABLE IF NOT EXISTS managed_content_objects (
  realm TEXT NOT NULL,
  object_id UUID NOT NULL,
  storage_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  reservation_kind TEXT NOT NULL CHECK (reservation_kind='knowledge-file'),
  reservation_id TEXT NOT NULL,
  reservation_active BOOLEAN NOT NULL DEFAULT true,
  state TEXT NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','ready','deleting','deleted')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until TIMESTAMPTZ NOT NULL,
  grace_ms BIGINT NOT NULL CHECK (grace_ms >= 0),
  unreferenced_at TIMESTAMPTZ,
  collect_after TIMESTAMPTZ,
  delete_token UUID,
  delete_lease_until TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (realm,object_id),
  UNIQUE (realm,object_key),
  UNIQUE (realm,reservation_kind,reservation_id)
);
CREATE TABLE IF NOT EXISTS managed_content_references (
  realm TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind='knowledge-file'),
  reference_id TEXT NOT NULL,
  object_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  PRIMARY KEY (realm,kind,reference_id),
  FOREIGN KEY (realm,object_id) REFERENCES managed_content_objects(realm,object_id)
);
CREATE INDEX IF NOT EXISTS managed_content_live_references ON managed_content_references(realm,object_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS managed_content_gc ON managed_content_objects(realm,state,collect_after) WHERE reservation_active=false;
