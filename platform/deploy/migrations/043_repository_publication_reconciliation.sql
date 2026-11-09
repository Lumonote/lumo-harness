-- 只读外部核对不会释放已消费的发布许可；状态仍为 pending/publishing/draft。
ALTER TABLE governance_repository_publications ADD COLUMN IF NOT EXISTS reconciliation TEXT NOT NULL DEFAULT '' CHECK(reconciliation IN ('','confirmed','unknown'));
ALTER TABLE governance_repository_publications ADD COLUMN IF NOT EXISTS reconciliation_reason TEXT NOT NULL DEFAULT '' CHECK(reconciliation_reason IN ('','confirmed','provider_unavailable','evidence_mismatch'));
ALTER TABLE governance_repository_publications ADD COLUMN IF NOT EXISTS reconciliation_revision BIGINT NOT NULL DEFAULT 0 CHECK(reconciliation_revision >= 0);
ALTER TABLE governance_repository_publications ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;
