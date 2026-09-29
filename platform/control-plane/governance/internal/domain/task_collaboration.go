package domain

import "time"

// TaskCollaborator is an explicit user or department grant on a task. A
// department grant can include its active descendants; task access is resolved
// against the user's current primary department at read time.
type TaskCollaborator struct {
	SubjectType     string    `json:"subject_type"`
	SubjectID       string    `json:"subject_id"`
	Access          string    `json:"access"`
	IncludeChildren bool      `json:"include_children,omitempty"`
	CreatedBy       string    `json:"created_by,omitempty"`
	CreatedAt       time.Time `json:"created_at,omitempty"`
}

// TaskArtifact is durable metadata for one immutable run deliverable. The
// storage key is only used by the Lumo host to stream content from object
// storage and is never serialized to browser clients.
type TaskArtifact struct {
	ID          string     `json:"id"`
	Realm       string     `json:"realm"`
	TaskID      string     `json:"task_id"`
	RunID       string     `json:"run_id"`
	Name        string     `json:"name"`
	ContentType string     `json:"content_type"`
	SizeBytes   int64      `json:"size_bytes"`
	SHA256      string     `json:"sha256"`
	CreatedBy   string     `json:"created_by"`
	Status      string     `json:"status"`
	CreatedAt   time.Time  `json:"created_at"`
	ReadyAt     *time.Time `json:"ready_at,omitempty"`
	StorageKey  string     `json:"-"`
}
