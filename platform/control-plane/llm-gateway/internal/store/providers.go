package store

// provider 注册表的管理面读写（E8）。
//
// 与 store.go 里 Provider() 的关系：那个是**路由面**读（只认启用行、必须带出密钥），
// 这里是**管理面**读写（要看得见停用行、永不带出密钥）。两者刻意不共用查询：
// 路由面加 `AND enabled` 是它的语义，管理面若复用就会看不见停用行——运维也就再也
// 无法重新启用一个被停用的模型。

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/lumo-harness/platform/llm-gateway/internal/domain"
)

// providerCols 管理面列清单的**单一来源**：SELECT 与 RETURNING 共用。
// 扫描顺序与列序强绑定，两处各写一份就会漂移，而漂移的表现是「字段串位」——
// 价格显示成主机名这种错，读代码看不出来。
const providerCols = `
	model,
	upstream_base_url,
	api_key <> '' AS api_key_set,
	price_in_per_mtok::float8,
	price_out_per_mtok::float8,
	enabled,
	created_at,
	updated_at`

// rowScanner pgx.Row 与 pgx.Rows 都满足（一行与多行共用同一个扫描器）。
type rowScanner interface{ Scan(dest ...any) error }

func scanProvider(sc rowScanner) (*domain.ProviderConfig, error) {
	var c domain.ProviderConfig
	if err := sc.Scan(
		&c.Model, &c.UpstreamBaseURL, &c.APIKeySet,
		&c.PriceInPerMtok, &c.PriceOutPerMtok, &c.Enabled,
		&c.CreatedAt, &c.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return &c, nil
}

// Providers 列出全部 provider（含停用行），按 model 排序。
//
// 排序是硬要求而非美观：Go 侧会把它按序回给客户端，无序输出会让「配置有没有变」
// 这件事在 diff 里永远显示为变了。
func (s *Store) Providers(ctx context.Context) ([]domain.ProviderConfig, error) {
	rows, err := s.pool.Query(ctx, `SELECT`+providerCols+` FROM llm_providers ORDER BY model`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []domain.ProviderConfig{}
	for rows.Next() {
		c, err := scanProvider(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

// ProviderConfig 读单个 provider（含停用行）。不存在 → domain.ErrProviderNotFound。
func (s *Store) ProviderConfig(ctx context.Context, model string) (*domain.ProviderConfig, error) {
	c, err := scanProvider(s.pool.QueryRow(ctx,
		`SELECT`+providerCols+` FROM llm_providers WHERE model = $1`, model))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, domain.ErrProviderNotFound
	}
	if err != nil {
		return nil, err
	}
	return c, nil
}

// upsertProviderSQL 建行或改行，一条语句完成。
//
// 要点一：**不是**「先读再写」。读改写会把并发 PUT 变成丢失更新（A 读到旧值、B 写入、
// A 再写回它读到的旧值——B 的修改静默消失）。ON CONFLICT DO UPDATE 由 PG 在行锁下
// 完成，两次并发 PUT 串行落地，各自完整生效。
//
// 要点二：指针字段省略 = 保持原值，靠 COALESCE($n, 现有列) 表达。显式给空串/0/false
// 则**会**写入（COALESCE 只兜 NULL，不兜零值），所以「清掉密钥」「把价格改成 0」
// 都有出口。
//
// 要点三：$2 在 VALUES 里回落到**该行已存在的值**（子查询），而不是直接送 NULL。
//
// 原写法是 `VALUES ($1, $2::text, …)`，指望「省略 URL 时撞 NOT NULL」同时充当
// 「这是新建行」的判据。**这个判据是错的**：PG 在解析 ON CONFLICT 之前就对**拟插入
// 的那一行**做 NOT NULL 检查，所以改行省略 URL 也会抛 23502 —— 于是「改行可省略」
// 这条路径根本不可达，E8 的「省略即保持原值」对 upstreamBaseUrl 从来没生效过。
// 实测（PG 16.15，最小复现）：
//
//	INSERT INTO t (model, url) VALUES ('m', NULL)   -- 'm' 已存在
//	  ON CONFLICT (model) DO UPDATE SET url = COALESCE(NULL, t.url);
//	→ ERROR: null value in column "url" violates not-null constraint
//
// 改成子查询回落后，两种情况各归各位：行已存在 → 拟插入行带着旧值，合法，冲突分支
// 照常更新（且 SET 里的 COALESCE 保住旧值）；行不存在 → 子查询给 NULL，NOT NULL 照
// 常抛出，**「建行必须给 URL」的判据仍然由库一条语句原子判定**，不需要另发存在性查询，
// 也就没有「查完被删」的竞态。
//
// 要点四：$2..$6 都显式标注类型。省略的指针参数会被送成无类型 NULL，PG 在某些组合
// 下推不出参数类型而直接报错——这类错只在真库上出现，本地假存储永远测不出来。
//
// 要点五：created_at 不进 SET（它是行的出生时刻，改行不该动它）；updated_at 每次都推。
const upsertProviderSQL = `
INSERT INTO llm_providers (model, upstream_base_url, api_key, price_in_per_mtok, price_out_per_mtok, enabled)
VALUES ($1,
        COALESCE($2::text, (SELECT upstream_base_url FROM llm_providers WHERE model = $1)),
        COALESCE($3::text, ''), COALESCE($4::numeric, 0), COALESCE($5::numeric, 0), COALESCE($6::boolean, true))
ON CONFLICT (model) DO UPDATE SET
  upstream_base_url  = COALESCE($2::text, llm_providers.upstream_base_url),
  api_key            = COALESCE($3::text, llm_providers.api_key),
  price_in_per_mtok  = COALESCE($4::numeric, llm_providers.price_in_per_mtok),
  price_out_per_mtok = COALESCE($5::numeric, llm_providers.price_out_per_mtok),
  enabled            = COALESCE($6::boolean, llm_providers.enabled),
  updated_at         = now()
RETURNING` + providerCols

// UpsertProvider 写入并回读该行（回读的值就是客户端下一步会读到的值）。
//
// up 应当是 domain.ProviderUpsert.Validate 的**返回值**：那里的规范化保证了
// 「校验通过」与「落库内容」逐字节一致。
func (s *Store) UpsertProvider(ctx context.Context, model string, up domain.ProviderUpsert) (*domain.ProviderConfig, error) {
	c, err := scanProvider(s.pool.QueryRow(ctx, upsertProviderSQL,
		model, up.UpstreamBaseURL, up.APIKey, up.PriceInPerMtok, up.PriceOutPerMtok, up.Enabled))
	if err != nil {
		if isMissingUpstreamBaseURL(err) {
			return nil, fmt.Errorf("%w: 新建 provider 必须给出 upstreamBaseUrl（只有改已有行才能省略）", domain.ErrInvalidProvider)
		}
		return nil, fmt.Errorf("写入 provider %q 失败: %w", model, err)
	}
	return c, nil
}

// isMissingUpstreamBaseURL 认 23502（not-null 违约）且违约列是 upstream_base_url。
//
// 用列名而不是约束名：NOT NULL 的约束名是 PG 自动生成的
// （llm_providers_upstream_base_url_not_null），依赖它等于依赖命名规则不变；
// 列名是语义的一部分，稳得多。
func isMissingUpstreamBaseURL(err error) bool {
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return false
	}
	return pgErr.Code == "23502" && pgErr.ColumnName == "upstream_base_url"
}

// DeleteProvider 物理删除该行。不存在 → domain.ErrProviderNotFound。
//
// 不带 `IF EXISTS`：这里靠 RowsAffected 区分「删掉了」与「本来就没有」，
// 而 `DELETE ... IF EXISTS` 会把后者也报成成功——404 就永远发不出去。
//
// 也不带 `AND enabled`：停用行同样可删。否则一行录错并被停用后就成了删不掉的孤儿，
// 而「删掉重录」恰恰是修录入错误最直接的手段。
//
// 「让模型退出路由」的常规手段是**停用**（PUT {"enabled": false}）而不是删除：
// 停用保留费率与启用历史，删除只该用于「这行本来就录错了」。注意删掉行不会让历史
// 账目失去依据（计费事件存的是 costUsd 快照，不是指向本表的外键），但会失去
// 「当时按什么费率算的」这个解释——所以删除必须是显式动作，不能是停用的副作用。
func (s *Store) DeleteProvider(ctx context.Context, model string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM llm_providers WHERE model = $1`, model)
	if err != nil {
		return fmt.Errorf("删除 provider %q 失败: %w", model, err)
	}
	if tag.RowsAffected() == 0 {
		return domain.ErrProviderNotFound
	}
	return nil
}
