package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// ErrCursorAdvanced 表示提交时游标已被别人推进（CAS 未命中）。
//
// 这不是故障：多个生产者副本可能同时读到同一个到期游标，先提交的那个赢，
// 后提交的看到 next_fire_at 已经越过自己读到的时刻，于是什么都不做。
// 触发因此是 exactly-once，不需要额外的 claim 列。
var ErrCursorAdvanced = errors.New("cron cursor was already advanced")

// Cursor 是一个 cron 自动化的调度游标。
type Cursor struct {
	AutomationID string `json:"automation_id"`
	Realm        string `json:"realm"`
	ProjectID    string `json:"project_id"`
	// Spec 是建立游标时看到的 trigger_spec。spec 变了说明用户改了表达式，
	// 协调阶段会重置游标，而不是拿旧表达式去追溯补跑。
	Spec string `json:"spec"`
	// LastFiredAt 是上一次为它触发过的时刻，也是 Due 计算的起点。
	LastFiredAt time.Time `json:"last_fired_at"`
	// NextFireAt 是下一次应触发的时刻。停滞的游标不会被选中，所以它不会一直到期。
	NextFireAt time.Time `json:"next_fire_at"`
	// LastError 非空表示游标已停滞：表达式非法、或表达式永远不会触发。
	// 停滞的游标只有改了 spec 或先禁用再启用才会恢复（见 schedule 包的 reconcile）。
	LastError string `json:"last_error,omitempty"`
}

// CronAutomation 是协调阶段期望存在的 cron 自动化。
type CronAutomation struct {
	AutomationID string
	Realm        string
	ProjectID    string
	Spec         string
}

// Fire 是一次待提交的触发。
type Fire struct {
	Cursor Cursor
	// Payload 是交给流程的事件体，必须是合法 JSON。
	Payload json.RawMessage
	// Fired 是本次触发的「计划时刻」。追赶漏跑时它会早于 Now。
	Fired time.Time
	// Next 是推进后游标上的下一次触发时刻，必须晚于 Now 才能收住追赶，
	// 否则下一轮会立刻再次到期、把落后的每一次都补一遍。
	Next time.Time
	// Now 是提交时的墙上时间，同时用作 CAS 谓词的上界。
	Now time.Time
}

// ListCronAutomations 返回「已发布流程上的启用 cron 自动化」。
//
// 只认已发布快照（published / targeted）与启用状态，与 PrepareTriggerBindings 的
// 运行面口径一致：草稿流程的 cron 自动化不该产生触发。
func (s *Store) ListCronAutomations(ctx context.Context) ([]CronAutomation, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT a.automation_id, a.project_id, f.realm, a.trigger_spec
		FROM project_automations a
			JOIN flows f ON f.id = a.flow_ref AND f.project_id = a.project_id
			JOIN projects p ON p.id = a.project_id AND p.realm = f.realm AND p.status = 'active'
			JOIN flow_versions v ON v.flow_id = f.id AND v.version = f.version
		WHERE a.trigger_kind = 'cron' AND a.enabled AND f.status IN ('published','targeted')
		ORDER BY a.automation_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CronAutomation{}
	for rows.Next() {
		var automation CronAutomation
		if err := rows.Scan(&automation.AutomationID, &automation.ProjectID, &automation.Realm, &automation.Spec); err != nil {
			return nil, err
		}
		out = append(out, automation)
	}
	return out, rows.Err()
}

// LoadCronCursors 返回全部现有游标。
func (s *Store) LoadCronCursors(ctx context.Context) ([]Cursor, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT automation_id, realm, project_id, spec, last_fired_at, next_fire_at, last_error
		FROM flow_cron_cursors ORDER BY automation_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectCursors(rows)
}

// ListCronCursors 按项目列出调度游标，供巡检查看停滞的自动化。
//
// 与 LoadCronCursors 的区别：这里按 realm + project 收窄并带上 last_error，
// 所以可以直接暴露给项目成员——跨租户、跨项目的游标不会被带出来。
func (s *Store) ListCronCursors(ctx context.Context, realm, projectID string) ([]Cursor, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT automation_id, realm, project_id, spec, last_fired_at, next_fire_at, last_error
		FROM flow_cron_cursors WHERE realm = $1 AND project_id = $2
		ORDER BY automation_id`, realm, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectCursors(rows)
}

// DueCronCursors 返回未停滞且 next_fire_at <= now 的游标。
func (s *Store) DueCronCursors(ctx context.Context, now time.Time, limit int) ([]Cursor, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		SELECT automation_id, realm, project_id, spec, last_fired_at, next_fire_at, last_error
		FROM flow_cron_cursors
		WHERE last_error = '' AND next_fire_at <= $1
		ORDER BY next_fire_at, automation_id LIMIT $2`, now, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return collectCursors(rows)
}

func collectCursors(rows pgx.Rows) ([]Cursor, error) {
	out := []Cursor{}
	for rows.Next() {
		var cursor Cursor
		if err := rows.Scan(&cursor.AutomationID, &cursor.Realm, &cursor.ProjectID, &cursor.Spec,
			&cursor.LastFiredAt, &cursor.NextFireAt, &cursor.LastError); err != nil {
			return nil, err
		}
		out = append(out, cursor)
	}
	return out, rows.Err()
}

// UpsertCronCursor 建立或重置游标。
func (s *Store) UpsertCronCursor(ctx context.Context, cursor Cursor) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO flow_cron_cursors
		  (automation_id, realm, project_id, spec, last_fired_at, next_fire_at, last_error, updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7, now())
		ON CONFLICT (automation_id) DO UPDATE SET
		  realm = EXCLUDED.realm, project_id = EXCLUDED.project_id, spec = EXCLUDED.spec,
		  last_fired_at = EXCLUDED.last_fired_at, next_fire_at = EXCLUDED.next_fire_at,
		  last_error = EXCLUDED.last_error, updated_at = now()`,
		cursor.AutomationID, cursor.Realm, cursor.ProjectID, cursor.Spec,
		cursor.LastFiredAt, cursor.NextFireAt, cursor.LastError)
	return err
}

// DeleteCronCursors 删除不再适用的游标。
func (s *Store) DeleteCronCursors(ctx context.Context, automationIDs []string) error {
	if len(automationIDs) == 0 {
		return nil
	}
	_, err := s.pool.Exec(ctx, `DELETE FROM flow_cron_cursors WHERE automation_id = ANY($1)`, automationIDs)
	return err
}

// StallCronCursor 标记游标不可调度。保留 next_fire_at 不动，靠 last_error 把它
// 挡在 DueCronCursors 之外，这样巡检还能看到它原本打算什么时候跑。
func (s *Store) StallCronCursor(ctx context.Context, automationID, reason string) error {
	_, err := s.pool.Exec(ctx, `
		UPDATE flow_cron_cursors SET last_error = $2, updated_at = now() WHERE automation_id = $1`,
		automationID, reason)
	return err
}

// FireCronCursor 在同一个事务里入队触发并推进游标。
//
// 这是 cron 调度的核心不变式：推进游标与入队必须同时成功或同时失败，否则崩溃点
// 落在两者之间就会漏跑或重复跑。这里用一条带 CTE 的语句完成，PG 保证它是一个事务。
//
// 并发正确性靠 CAS 而不是显式锁：UPDATE 的 WHERE 里带 next_fire_at <= fire.Now，
// 所以两个生产者副本同时读到同一个到期游标时，只有先提交的那个能改到行；后提交的
// 改到 0 行、不产生任何触发，返回 ErrCursorAdvanced。
//
// event_name 填 automation_id：outbox 的该列是 NOT NULL，且要作为 Bus 主题名，
// 用 automation_id 既唯一又能在日志里认出来。绑定阶段不看它，看 source/cron_automation_id。
func (s *Store) FireCronCursor(ctx context.Context, fire Fire) (uint64, error) {
	var id uint64
	err := s.pool.QueryRow(ctx, `
		WITH advanced AS (
			UPDATE flow_cron_cursors
			   SET last_fired_at = $3, next_fire_at = $4, updated_at = now()
			 WHERE automation_id = $1 AND realm = $2 AND spec = $5 AND last_error = ''
			   AND next_fire_at <= $6
			RETURNING realm, automation_id
		), queued AS (
			INSERT INTO flow_trigger_outbox (realm, event_name, payload, source, cron_automation_id)
			SELECT advanced.realm, advanced.automation_id, $7::jsonb, 'cron', advanced.automation_id
			  FROM advanced
			RETURNING id
		)
		SELECT id FROM queued`,
		fire.Cursor.AutomationID, fire.Cursor.Realm, fire.Fired, fire.Next,
		fire.Cursor.Spec, fire.Now, fire.Payload).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ErrCursorAdvanced
	}
	return id, err
}
