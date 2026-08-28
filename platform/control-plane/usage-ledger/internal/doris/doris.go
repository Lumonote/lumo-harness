// Package doris writes the append-only usage ledger into a Doris aggregate cube.
// PG remains the source of truth; this package is a replayable projection.
package doris

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Config struct {
	BaseURL  string
	Database string
	Table    string
	User     string
	Password string
	Client   *http.Client
}

type Row struct {
	Ts        time.Time `json:"ts"`
	UserID    string    `json:"user_id"`
	ProjectID string    `json:"project_id"`
	CostType  string    `json:"cost_type"`
	Qty       float64   `json:"qty"`
	CostUSD   float64   `json:"cost_usd"`
	Tokens    int64     `json:"tokens"`
}

type CubeRow struct {
	Day       string  `json:"day"`
	UserID    string  `json:"user_id"`
	ProjectID string  `json:"project_id"`
	CostType  string  `json:"cost_type"`
	Qty       float64 `json:"qty"`
	CostUSD   float64 `json:"cost_usd"`
	Tokens    int64   `json:"tokens"`
}

type Client struct{ cfg Config }

func New(cfg Config) *Client {
	if cfg.Database == "" {
		cfg.Database = "lumo"
	}
	if cfg.Table == "" {
		cfg.Table = "usage_cube_daily"
	}
	if cfg.Client == nil {
		cfg.Client = &http.Client{Timeout: 20 * time.Second}
	}
	return &Client{cfg: cfg}
}

func (c *Client) EnsureTable(ctx context.Context) error {
	query := fmt.Sprintf(`CREATE TABLE IF NOT EXISTS %s.%s (
day DATE NOT NULL, user_id VARCHAR(128) NOT NULL, project_id VARCHAR(128) NOT NULL,
cost_type VARCHAR(64) NOT NULL, qty DECIMAL(20,6) SUM, cost_usd DECIMAL(20,8) SUM,
tokens BIGINT SUM) AGGREGATE KEY(day,user_id,project_id,cost_type)
DISTRIBUTED BY HASH(project_id) BUCKETS 8 PROPERTIES ("replication_num" = "1")`, c.cfg.Database, c.cfg.Table)
	return c.query(ctx, query)
}

// Load projects a batch into the cube. Stream Load is idempotent at the cube
// key level when the same day/dimension batch is replayed from PG.
func (c *Client) Load(ctx context.Context, rows []Row) error {
	if len(rows) == 0 {
		return nil
	}
	var body bytes.Buffer
	enc := json.NewEncoder(&body)
	for _, row := range rows {
		if err := enc.Encode(row); err != nil {
			return err
		}
	}
	url := fmt.Sprintf("%s/api/%s/%s/_stream_load", strings.TrimRight(c.cfg.BaseURL, "/"), c.cfg.Database, c.cfg.Table)
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, &body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("format", "json")
	req.Header.Set("strip_outer_array", "false")
	return c.do(req)
}

func (c *Client) Aggregate(ctx context.Context, from, to time.Time, projectID string) ([]CubeRow, error) {
	query := fmt.Sprintf(`SELECT DATE(ts) AS day, user_id, project_id, cost_type,
SUM(qty) AS qty, SUM(cost_usd) AS cost_usd, SUM(tokens) AS tokens
FROM usage_ledger WHERE ts >= '%s' AND ts < '%s'`, from.UTC().Format(time.RFC3339), to.UTC().Format(time.RFC3339))
	if projectID != "" {
		query += fmt.Sprintf(` AND project_id = '%s'`, escapeSQL(projectID))
	}
	query += ` GROUP BY DATE(ts), user_id, project_id, cost_type ORDER BY day, project_id, cost_type`
	return c.queryRows(ctx, query)
}

func (c *Client) query(ctx context.Context, query string) error {
	_, err := c.queryRaw(ctx, query)
	return err
}

func (c *Client) queryRows(ctx context.Context, query string) ([]CubeRow, error) {
	res, err := c.queryRaw(ctx, query)
	if err != nil {
		return nil, err
	}
	var envelope struct {
		Data []CubeRow `json:"data"`
	}
	if err := json.Unmarshal(res, &envelope); err != nil {
		return nil, fmt.Errorf("doris: query 响应解析失败: %w", err)
	}
	return envelope.Data, nil
}

func (c *Client) queryRaw(ctx context.Context, query string) ([]byte, error) {
	body, err := json.Marshal(map[string]string{"query": query})
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.cfg.BaseURL, "/")+"/api/query", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.doBytes(req)
}

func (c *Client) do(req *http.Request) error { _, err := c.doBytes(req); return err }
func (c *Client) doBytes(req *http.Request) ([]byte, error) {
	if c.cfg.User != "" {
		req.SetBasicAuth(c.cfg.User, c.cfg.Password)
	}
	res, err := c.cfg.Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("doris: 请求失败: %w", err)
	}
	defer res.Body.Close()
	raw, readErr := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if readErr != nil {
		return nil, readErr
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("doris: HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(raw)))
	}
	if bytes.Contains(raw, []byte(`"Status":"Fail"`)) || bytes.Contains(raw, []byte(`"status":"FAIL"`)) {
		return nil, fmt.Errorf("doris: 操作失败: %s", string(raw))
	}
	return raw, nil
}

func escapeSQL(value string) string { return strings.ReplaceAll(value, "'", "''") }
