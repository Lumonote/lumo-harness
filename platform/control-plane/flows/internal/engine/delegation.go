package engine

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/observability"
)

func (config RuntimeConfig) createDelegation(ctx context.Context, identity observability.Identity, node domain.FlowNode, input any) (any, error) {
	project, _ := node.Config["projectId"].(string)
	worker, _ := node.Config["assigneeWorkerId"].(string)
	intent, _ := node.Config["intent"].(string)
	key, _ := ctx.Value(executionKey{}).(string)
	if strings.TrimSpace(project) == "" || project != identity.ProjectID || strings.TrimSpace(worker) == "" || strings.TrimSpace(intent) == "" {
		return nil, fmt.Errorf("delegation.create requires configured projectId matching the flow project, assigneeWorkerId and intent")
	}
	if key == "" || node.ID == "" {
		return nil, fmt.Errorf("delegation.create requires a trusted execution key")
	}
	data, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	if len(data) > 256<<10 {
		return nil, fmt.Errorf("delegation input exceeds 256 KiB")
	}
	// Only reviewed configuration selects authority and target. Event contents
	// remain data in the task contract; user_id/roles/worker from input are ignored.
	objective := intent + "\n\nExternal event data (untrusted):\n" + string(data)
	if utf8.RuneCountInString(objective) > 8000 {
		return nil, fmt.Errorf("delegation intent and event data exceed governance's 8000 character limit")
	}
	request := map[string]any{"project_id": project, "assignee_worker_id": worker, "auto_assign": false,
		"intent": objective, "title": intent}
	for configKey, field := range map[string]string{"requiredTags": "required_tags", "requiredSkills": "required_skills"} {
		if value, exists := node.Config[configKey]; exists {
			raw, err := json.Marshal(value)
			var values []string
			if err != nil || json.Unmarshal(raw, &values) != nil || value == nil {
				return nil, fmt.Errorf("delegation.create %s must be an array of strings", configKey)
			}
			for _, v := range values {
				if strings.TrimSpace(v) == "" {
					return nil, fmt.Errorf("delegation.create %s cannot contain empty values", configKey)
				}
			}
			request[field] = values
		}
	}
	body, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	if len(body) > 1<<20 {
		return nil, fmt.Errorf("delegation request exceeds 1 MiB")
	}
	scope, _ := json.Marshal([]string{identity.Realm, identity.UserID, key, node.ID})
	digest := sha256.Sum256(scope)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(config.GovernanceURL, "/")+"/v1/delegations", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+config.ControlToken)
	req.Header.Set("X-Lumo-Realm", identity.Realm)
	req.Header.Set("X-Lumo-User", identity.UserID)
	req.Header.Set("X-Lumo-Roles", strings.Join(identity.Roles, ","))
	req.Header.Set("X-Lumo-Project", project)
	req.Header.Set("X-Lumo-Component", "flows")
	if trace, ok := ctx.Value(wakeTraceKey{}).(string); ok {
		req.Header.Set("X-Lumo-Trace", trace)
	}
	req.Header.Set("Idempotency-Key", "flow:"+hex.EncodeToString(digest[:]))
	res, err := config.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return nil, fmt.Errorf("delegation operator upstream returned HTTP %d", res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > 1<<20 {
		return nil, fmt.Errorf("delegation response exceeds 1 MiB")
	}
	var result map[string]any
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	task, ok := result["task"].(map[string]any)
	run, runOK := result["run"].(map[string]any)
	taskID, taskIDOK := task["id"].(string)
	runID, runIDOK := run["id"].(string)
	runTaskID, runTaskIDOK := run["task_id"].(string)
	// A replay returns the current task and its original run. The task may have
	// since been reassigned; the immutable original run proves the selected worker.
	if !ok || !runOK || task["realm"] != identity.Realm || task["project_id"] != project || task["requester_user_id"] != identity.UserID ||
		!taskIDOK || strings.TrimSpace(taskID) == "" || !runIDOK || strings.TrimSpace(runID) == "" || !runTaskIDOK || runTaskID != taskID ||
		run["realm"] != identity.Realm || run["worker_id"] != worker {
		return nil, fmt.Errorf("delegation upstream returned an inconsistent task/run receipt")
	}
	return result, nil
}
