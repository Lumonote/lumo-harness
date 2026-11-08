-- 任务进度是追加的、有归属的检查点，不改变执行状态与验收状态。
-- 与 governance Store.Init 的 taskProgressDDL 保持一致。
CREATE TABLE IF NOT EXISTS governance_task_progress (
  realm TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES governance_delegation_tasks(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES governance_task_runs(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL CHECK(revision > 0),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(realm,task_id,revision)
);
CREATE INDEX IF NOT EXISTS governance_task_progress_run_idx ON governance_task_progress(realm,run_id,revision DESC);
