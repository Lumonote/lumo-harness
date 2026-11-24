-- P0-1：session-control 的 awaiting-approval 关联具体 Ask。前向迁移，不改旧迁移。
-- 与 control-plane/session-control/internal/store DDL 末尾同一语句（两边都幂等）。
-- 兼容：既有行 ask_id = ''，读面与 approve/reject 校验都把 '' 视为「未关联、不校验」。
-- 回退：两列可直接 DROP；旧代码不读这两列。
ALTER TABLE session_control_state ADD COLUMN IF NOT EXISTS ask_id TEXT NOT NULL DEFAULT '';
ALTER TABLE session_control_audit ADD COLUMN IF NOT EXISTS ask_id TEXT NOT NULL DEFAULT '';
