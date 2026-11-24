-- P1：跨设备记忆同步（control-plane/projects/internal/memsync）。前向迁移，不改旧迁移。
-- 与 memsync.DDL 同文，两边幂等。隔离键 (realm, user_id, workspace)；workspace 为客户端
-- 对工作区标识求 sha256 的十六进制串。deleted=true 为墓碑，不物理删除（保证离线设备能拉到删除）。
-- 回退：DROP TABLE memory_sync_items; DROP SEQUENCE memory_sync_seq;（旧代码不读）。
CREATE SEQUENCE IF NOT EXISTS memory_sync_seq;
CREATE TABLE IF NOT EXISTS memory_sync_items (
  realm      TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  workspace  TEXT NOT NULL,
  id         UUID NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL DEFAULT '',
  hlc        TEXT NOT NULL,
  device     TEXT NOT NULL,
  deleted    BOOLEAN NOT NULL DEFAULT false,
  seq        BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, user_id, workspace, id)
);
CREATE INDEX IF NOT EXISTS memory_sync_items_pull ON memory_sync_items (realm, user_id, workspace, seq);
