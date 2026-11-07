-- 请求集群与实际执行集群分离；排队退避与跨批公平状态。
-- 服务自带 DDL 使用相同语句，Compose 与集中迁移保持收敛。
ALTER TABLE scheduler_tasks ADD COLUMN IF NOT EXISTS requested_cluster_id TEXT NOT NULL DEFAULT '';
ALTER TABLE scheduler_tasks ADD COLUMN IF NOT EXISTS assigned_cluster_id TEXT NOT NULL DEFAULT '';
ALTER TABLE scheduler_tasks ADD COLUMN IF NOT EXISTS next_check_at BIGINT NOT NULL DEFAULT 0;
ALTER TABLE scheduler_tasks ADD COLUMN IF NOT EXISTS schedule_checks INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduler_tasks ADD COLUMN IF NOT EXISTS pending_reason TEXT NOT NULL DEFAULT 'awaiting-placement';

CREATE TABLE IF NOT EXISTS scheduler_queue_fairness (
  realm TEXT NOT NULL, queue TEXT NOT NULL, virtual_finish DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY(realm,queue)
);
CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_due ON scheduler_tasks(next_check_at,realm,queue)
  WHERE state='PENDING';
UPDATE scheduler_tasks SET requested_cluster_id=cluster_id WHERE requested_cluster_id='' AND cluster_id<>'';

ALTER TABLE scheduler_task_attempts ADD COLUMN IF NOT EXISTS assigned_cluster_id TEXT NOT NULL DEFAULT '';
UPDATE scheduler_tasks t SET assigned_cluster_id=n.cluster_id FROM scheduler_nodes n
 WHERE t.node_id=n.node_id AND t.realm=n.realm AND t.assigned_cluster_id='';
UPDATE scheduler_task_attempts a SET assigned_cluster_id=n.cluster_id FROM scheduler_nodes n
 WHERE a.node_id=n.node_id AND a.realm=n.realm AND a.assigned_cluster_id='';
