-- session-control 的两张共用表：收敛插件时代遗留的异构同名表。
--
-- 2026-09-17 之前 `@lumo/control` 插件也建 `session_control_state` /
-- `session_control_audit`，列集与状态词表都不同（见 docs/implementation-status.md
-- 「C5 下发链路」）。那次修的是**代码**：插件侧现在只拥有 `session_controllers`。
-- 但 `CREATE TABLE IF NOT EXISTS` 对已存在的表是空操作 —— **已经建过表的库不会因为
-- 那次修改变回来**，而失败全是静默的：
--
--   - 插件那句 CHECK 只认 'running'/'paused'/'stopping'/'aborted'，Go 写
--     'awaiting-approval' / 'stopped' 报 23514；
--   - 审计表的 request_id / allowed / role 是 NOT NULL 且无默认，而 Go 的 INSERT 不列
--     这三列 → not-null 违例（错误只指向约束名，不指向「库里还有第二份 DDL」）；
--   - 状态行若以 realm='' 落库最阴：realm 写后不可变，该会话此后每条真实指令都拿
--     realm_mismatch，表现为「操作者暂停过的会话，谁都控不动」。
--
-- 本文件与服务端 `internal/store/store.go` 的 `const DDL` **必须保持同文**：Compose
-- 不跑 migrate.sh，服务端 DDL 是那类部署唯一的收敛点；跑迁移的部署两条路径都要经得起。
-- 两条路径产出的表形状必须逐列等价（含默认值）——不等价时**只有老库会坏**，
-- governance 的 `session_id` 就是这么坏的（建表带 DEFAULT、收敛不带，登录直接 23502）。

CREATE TABLE IF NOT EXISTS session_control_state (
  session_ref    TEXT PRIMARY KEY,
  realm          TEXT NOT NULL,
  state          TEXT NOT NULL,
  revision       BIGINT NOT NULL DEFAULT 0,
  last_command   TEXT NOT NULL DEFAULT '',
  last_actor     TEXT NOT NULL DEFAULT '',
  last_reason    TEXT NOT NULL DEFAULT '',
  correlation_id TEXT NOT NULL DEFAULT '',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_control_audit (
  id             BIGSERIAL PRIMARY KEY,
  session_ref    TEXT NOT NULL,
  realm          TEXT NOT NULL,
  command        TEXT NOT NULL,
  outcome        TEXT NOT NULL,
  from_state     TEXT NOT NULL,
  to_state       TEXT NOT NULL,
  actor          TEXT NOT NULL DEFAULT '',
  actor_role     TEXT NOT NULL DEFAULT '',
  reason         TEXT NOT NULL DEFAULT '',
  correlation_id TEXT NOT NULL DEFAULT '',
  revision       BIGINT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 投影到复制式 SessionEvent 日志（§4.2）的待办尾巴。只用一列，不加 attempts /
  -- next_attempt_at / claimed_at：投影器（E7b 一族）还没落地，而**没人读的列与
  -- 有人忘了读的列在表结构上长得一样**，等投影器真的写出来再加退避列。
  projected_at   TIMESTAMPTZ
);

-- ── 收敛既有库里的异构同名表（插件形状 → 本服务形状） ───────────────────────
--
-- 2026-09-17 之前 @lumo/control 插件也建这两张表，列集与状态词表都不同：先建表的一方
-- 赢，后到者静默拿到一张自己不认识的表（见 docs/implementation-status.md）。那次修的是
-- 代码——插件侧现在只拥有 session_controllers。但 CREATE TABLE IF NOT EXISTS 对已存在
-- 的表是空操作，**已经建过表的库不会因为那次修改变回来**，而失败全是静默的：
--
--   - state 表的 CHECK 只认 'running'/'paused'/'stopping'/'aborted' → Go 写
--     'awaiting-approval' / 'stopped' 报 23514；
--   - audit 表的 request_id / allowed / role 是 NOT NULL 且无默认，而 Go 的 INSERT 不列
--     这三列 → not-null 违例（错误只指向约束名，不指向「库里还有第二份 DDL」）；
--   - state 行若以 realm='' 落库最阴：realm 写后不可变（见 Commit 的隔离校验），该会话
--     此后每条真实指令都拿 realm_mismatch —— 表现为「操作者暂停过的会话，谁都控不动」。
--
-- 加列与删列都是幂等的，直接写；**引用旧列名的语句必须按列是否存在分流**——它们在全新库
-- 上会以 42703 失败，而这段 DDL 在全新库上必须整段通过（control-schema-contract.spec.ts
-- 就把它整段丢给真 PG）。分流看列/约束在不在，不看版本号：库可能是迁移跑到一半的任意中间态。
ALTER TABLE session_control_state
  ADD COLUMN IF NOT EXISTS realm          TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS revision       BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_command   TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_actor     TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_reason    TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS correlation_id TEXT NOT NULL DEFAULT '';

ALTER TABLE session_control_audit
  ADD COLUMN IF NOT EXISTS id             BIGSERIAL,
  ADD COLUMN IF NOT EXISTS outcome        TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS from_state     TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS to_state       TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS actor_role     TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS correlation_id TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS revision       BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS projected_at   TIMESTAMPTZ;

DO $$
DECLARE c record;
BEGIN
  -- 插件那句 CHECK 只认四个状态，Go 的两个值会被它拒（23514）。它必须**第一个**被删掉：
  -- 下面那条幽灵状态换算也要写 'stopped'，而约束还在时它自己就会被拒——实测报
  -- 「new row ... violates check constraint "session_control_state_state_check"」，
  -- 错误指向换算语句，病根是它跑在了删约束之前。
  -- 按**定义**找而不是按名字找：内联 CHECK 的约束名由 PG 生成，改名或换库版本都不该让
  -- 这条收敛落空。
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'session_control_state'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%stopping%'
  LOOP
    EXECUTE format('ALTER TABLE session_control_state DROP CONSTRAINT %I', c.conname);
  END LOOP;

  -- 幽灵状态换算。'stopping' 不在 Go 的词表里（Go 的 stop 落点是 'stopped'），而不换算
  -- 的后果是闸门 fail-closed 全拒：一个已经停下来的会话变成「什么都不许做」，且没人能从
  -- 状态词看出原因。
  UPDATE session_control_state SET state = 'stopped' WHERE state = 'stopping';

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'session_control_state'
                AND column_name = 'reason') THEN
    -- 插件的 reason/actor 就是本服务的 last_reason/last_actor，同义列不留两份：
    -- 搬过去再删（没人读的列与有人忘了读的列在表结构上长得一样）。
    UPDATE session_control_state SET last_reason = reason WHERE reason <> '';
    UPDATE session_control_state SET last_actor  = actor  WHERE actor  <> '';
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'session_control_audit'
                AND column_name = 'decided_at') THEN
    -- realm 回填必须在 decided_at 被删之前做：插件把 realm 记在审计行上，状态行没有。
    -- 一条审计都没有的会话留 '' —— 那是「从未被任何 realm 主张过」的真实状态。
    UPDATE session_control_state s
       SET realm = a.realm
      FROM (SELECT DISTINCT ON (session_ref) session_ref, realm
              FROM session_control_audit
             WHERE realm <> ''
             ORDER BY session_ref, decided_at DESC) a
     WHERE a.session_ref = s.session_ref AND s.realm = '';

    -- 旧行只记得一个布尔 + 自由文本拒因，本服务的结论词表更细（applied/noop/
    -- policy_denied/policy_unavailable/…），无法逐一对上：按最接近的一档归类，且这些行
    -- 只是历史记录——「指令有没有生效」一律由控制面当场裁决给出，不读旧行。
    UPDATE session_control_audit
       SET actor_role = role,
           created_at = decided_at,
           outcome    = CASE WHEN allowed THEN 'applied' ELSE 'policy_denied' END
     WHERE request_id IS NOT NULL;
  END IF;
END $$;

ALTER TABLE session_control_state DROP COLUMN IF EXISTS reason;
ALTER TABLE session_control_state DROP COLUMN IF EXISTS actor;
ALTER TABLE session_control_audit   DROP COLUMN IF EXISTS request_id;
ALTER TABLE session_control_audit   DROP COLUMN IF EXISTS allowed;
ALTER TABLE session_control_audit   DROP COLUMN IF EXISTS denied_cause;
ALTER TABLE session_control_audit   DROP COLUMN IF EXISTS role;
ALTER TABLE session_control_audit   DROP COLUMN IF EXISTS decided_at;

-- 主键也要落到同一处：旧形状的 PK 在 request_id 上（已删列），新形状在 id 上。
-- 两条都在隐式事务里，中间不存在「没有主键」的可见状态。
ALTER TABLE session_control_audit DROP CONSTRAINT IF EXISTS session_control_audit_pkey;
ALTER TABLE session_control_audit ADD CONSTRAINT session_control_audit_pkey PRIMARY KEY (id);

-- 默认值也要收敛成一样，否则「新建库」与「老库收敛」产出两张形状不同的表——这正是
-- governance 的 session_id 坏掉的方式（建表语句带 DEFAULT、收敛语句不带，只有老库会
-- 坏）。这两条与各自建表语句里的定义严格对应：审计的 actor 有默认，状态表的 realm 没有。
ALTER TABLE session_control_audit ALTER COLUMN actor SET DEFAULT '';
ALTER TABLE session_control_state ALTER COLUMN realm DROP DEFAULT;
-- 这四列是「加列时必须带默认值（老库要填既有行）、建表时不带」的那一批，收敛完再抹平。
ALTER TABLE session_control_audit ALTER COLUMN outcome    DROP DEFAULT;
ALTER TABLE session_control_audit ALTER COLUMN from_state DROP DEFAULT;
ALTER TABLE session_control_audit ALTER COLUMN to_state   DROP DEFAULT;
ALTER TABLE session_control_audit ALTER COLUMN reason SET DEFAULT '';

-- 索引必须排在收敛**之后**：它们引用 id / created_at / projected_at，而这三列在老库上
-- 正是由上面那批 ADD COLUMN 才存在的。放在收敛之前时，老库上是「CREATE TABLE」空操作
-- （表已存在）→ 紧接着的 CREATE INDEX ... (session_ref, id DESC) 报 42703
-- 「column "id" does not exist」——**报错指向索引，病根却是前面两行没建出表**，这条假线索
-- 让定位绕了一大圈。每张表先到齐，再建索引。
CREATE INDEX IF NOT EXISTS idx_session_control_audit_timeline
  ON session_control_audit (session_ref, id DESC);
CREATE INDEX IF NOT EXISTS idx_session_control_audit_realm_time
  ON session_control_audit (realm, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_session_control_audit_pending
  ON session_control_audit (id) WHERE projected_at IS NULL;
