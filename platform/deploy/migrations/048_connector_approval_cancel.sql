-- P0-1：连接器审批支持申请人撤回（status = 'cancelled'）。前向迁移，不改旧迁移。
-- connector_approvals 由 connector-gateway 自建（internal/approval DDL），这里给跑迁移的部署
-- 同一份收敛语句；两边都幂等。旧数据无需回填：既有行的状态都在新集合内。
-- 回退：先把 cancelled 行改成 'rejected'（或删除），再把约束恢复成四值集合。
DO $$
DECLARE c record;
BEGIN
  IF to_regclass('connector_approvals') IS NULL THEN
    RETURN; -- 网关尚未建表：其 Init 会直接建出含 cancelled 的约束
  END IF;
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'connector_approvals'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%consumed%'
              AND pg_get_constraintdef(oid) NOT LIKE '%cancelled%'
  LOOP
    EXECUTE format('ALTER TABLE connector_approvals DROP CONSTRAINT %I', c.conname);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'connector_approvals'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%cancelled%') THEN
    ALTER TABLE connector_approvals ADD CONSTRAINT connector_approvals_status_check
      CHECK (status IN ('pending', 'approved', 'rejected', 'consumed', 'cancelled'));
  END IF;
END $$;
