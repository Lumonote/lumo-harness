-- leader 的广播地址：follower 据此把需要决策者的请求转发给 leader。
-- 与租约同行同语句写入，所以「谁是 leader」与「怎么找到它」不可能分叉。
ALTER TABLE scheduler_leader_lease ADD COLUMN IF NOT EXISTS advertise_url TEXT NOT NULL DEFAULT '';

-- 最近一次在节点目录里见到该节点的库端时刻（0 = 从未记录）。停滞判定的时钟：
-- 任务行与 attempt 行只在状态跃迁时前进，回答不了「它的节点还在不在」。
ALTER TABLE scheduler_nodes ADD COLUMN IF NOT EXISTS last_seen_at BIGINT NOT NULL DEFAULT 0;

-- 放置热路径的索引。事务内「按节点数活跃任务」、每轮的全表活跃计数、停滞与漂移
-- 扫描都只看活跃态；终态回报与漂移按 (task_id, attempt) 找派发行。此前这些查询
-- 没有可用索引，代价随任务历史线性增长。
CREATE INDEX IF NOT EXISTS idx_scheduler_tasks_active_node ON scheduler_tasks (node_id)
  WHERE state IN ('PLACED', 'RUNNING', 'CANCELLING');
CREATE INDEX IF NOT EXISTS idx_outbox_task_attempt ON scheduler_dispatch_outbox (task_id, attempt);

-- 抢占是「为谁腾的槽」（发起抢占的排队任务）。腾出的槽据此预留给发起者，同一个
-- 等待者也据此不会在第一个受害者停止期间再杀第二个。空 = 不是抢占，或升级前的行。
ALTER TABLE scheduler_control_commands ADD COLUMN IF NOT EXISTS waiter_task_id TEXT NOT NULL DEFAULT '';
