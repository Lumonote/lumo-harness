-- 协作文档写者围栏与同步 PG WAL。
-- 升级前必须停止所有旧 collaborator 写者并备份 PG/Redis；禁止混合滚动。
-- 旧文档首次打开时在文档锁内导入 Redis 尾部，迁移本身不删除 Redis。
CREATE TABLE IF NOT EXISTS collab_document_runtime (
  doc_id TEXT PRIMARY KEY REFERENCES collab_documents(doc_id) ON DELETE CASCADE,
  holder TEXT NOT NULL DEFAULT '',
  epoch BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT '-infinity',
  head BIGINT NOT NULL DEFAULT 0,
  migrated BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE IF NOT EXISTS collab_document_wal (
  doc_id TEXT NOT NULL REFERENCES collab_documents(doc_id) ON DELETE CASCADE,
  seq BIGINT NOT NULL CHECK (seq > 0),
  update JSONB NOT NULL,
  PRIMARY KEY (doc_id, seq)
);
