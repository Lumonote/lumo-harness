package crdt

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os/exec"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
)

// YrsProcessMerger delegates semantic Yjs updates to the yrs Rust kernel.
// The wire format deliberately contains only base64 so arbitrary Yjs v1 bytes
// never pass through a text encoding boundary.
type YrsProcessMerger struct{ binary string }

func NewYrsProcessMerger(binary string) *YrsProcessMerger { return &YrsProcessMerger{binary: binary} }
func (m *YrsProcessMerger) Name() string                  { return "yrs-process" }

type yrsRequest struct {
	State   string      `json:"state,omitempty"`
	Updates []yrsUpdate `json:"updates"`
}
type yrsUpdate struct {
	Payload string `json:"payload"`
}
type yrsResponse struct {
	State   string `json:"state"`
	Content string `json:"content"`
	Error   string `json:"error,omitempty"`
}

func (m *YrsProcessMerger) Merge(state []byte, updates []domain.Update) ([]byte, error) {
	return m.merge(context.Background(), state, updates)
}

func (m *YrsProcessMerger) merge(ctx context.Context, state []byte, updates []domain.Update) ([]byte, error) {
	if m == nil || m.binary == "" {
		return nil, &ErrKernelUnavailable{Detail: "未配置 yrs kernel binary"}
	}
	req := yrsRequest{Updates: make([]yrsUpdate, 0, len(updates))}
	if len(state) > 0 {
		req.State = base64.StdEncoding.EncodeToString(state)
	}
	for _, update := range updates {
		if len(update.Payload) == 0 {
			continue
		}
		req.Updates = append(req.Updates, yrsUpdate{Payload: base64.StdEncoding.EncodeToString(update.Payload)})
	}
	payload, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("yrs request encode: %w", err)
	}
	cmd := exec.CommandContext(ctx, m.binary)
	cmd.Stdin = bytes.NewReader(append(payload, '\n'))
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("yrs kernel: %w", err)
	}
	var resp yrsResponse
	if err := json.Unmarshal(bytes.TrimSpace(out), &resp); err != nil {
		return nil, fmt.Errorf("yrs response decode: %w", err)
	}
	if resp.Error != "" {
		return nil, &ErrKernelUnavailable{Detail: resp.Error}
	}
	merged, err := base64.StdEncoding.DecodeString(resp.State)
	if err != nil {
		return nil, fmt.Errorf("yrs state decode: %w", err)
	}
	return merged, nil
}

// CheckKernel performs a cheap startup probe without changing a document.
func (m *YrsProcessMerger) CheckKernel(ctx context.Context) error {
	_, err := m.merge(ctx, nil, nil)
	return err
}
