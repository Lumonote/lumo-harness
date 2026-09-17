-- project_spaces 的「同项目内 Space 名唯一」不变量。
--
-- 两个写入方共用这张表，且同库、同时在线：Go 的 control-plane/projects 与
-- dsh-plugins/project（TS，跑在 dsh-node 里，standalone/cluster 两种形态都会装载）。
-- 两者都用 CREATE TABLE IF NOT EXISTS，先到先得。此前 Go 侧把唯一性写成建表时的
-- 内联 UNIQUE、TS 侧完全没有 —— 于是「同项目重名」能不能被拒取决于谁先启动，而
-- projects 服务把 UpsertSpace 的错误映射成 409「space conflict」，那条分支在 TS
-- 先建表时静默失效。
--
-- 两侧现在都改成同一条具名唯一索引：CREATE TABLE IF NOT EXISTS 对既有库是空操作，
-- 内联约束加不上去（同 002/004 的理由）；具名索引则既能在既有库上补上，又不会与
-- PG 给内联 UNIQUE 的自动名并存出两套索引集。
--
-- 注意：若既有库里已经存在重名行，本语句会**报错**而不是静默通过 —— 这是有意的，
-- 需要人工决定保留哪一行。服务侧 DDL 也执行同一条语句，所以从不跑 migrate.sh 的
-- Compose 部署同样收敛到这个形状（同 004 的约定）。
CREATE UNIQUE INDEX IF NOT EXISTS project_spaces_project_name_uq
  ON project_spaces (project_id, name);
