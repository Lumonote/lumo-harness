package domain

import (
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"
)

type ProjectDirectoryQuery struct {
	Query  string
	Status string
	Role   string
	Sort   string
	Limit  int
	Offset int
}

func (q ProjectDirectoryQuery) Normalize() (ProjectDirectoryQuery, error) {
	q.Query = strings.TrimSpace(q.Query)
	if utf8.RuneCountInString(q.Query) > 200 || strings.ContainsFunc(q.Query, unicode.IsControl) {
		return q, fmt.Errorf("q must contain at most 200 characters without control characters")
	}
	if q.Status != "" && q.Status != StatusActive && q.Status != StatusArchived {
		return q, fmt.Errorf("status must be active or archived")
	}
	if q.Role != "" && q.Role != RoleOwner && q.Role != RoleEditor && q.Role != RoleViewer {
		return q, fmt.Errorf("role must be owner, editor or viewer")
	}
	if q.Sort == "" {
		q.Sort = "recent"
	}
	if q.Sort != "recent" && q.Sort != "name" {
		return q, fmt.Errorf("sort must be recent or name")
	}
	if q.Limit < 1 || q.Limit > 100 || q.Offset < 0 || q.Offset > 100_000 {
		return q, fmt.Errorf("limit must be 1–100 and offset must be 0–100000")
	}
	return q, nil
}

type ProjectDirectoryItem struct {
	Project
	YourRole    string `json:"yourRole"`
	MemberCount int64  `json:"memberCount"`
}

type ProjectDirectorySummary struct {
	Total    int64 `json:"total"`
	Active   int64 `json:"active"`
	Archived int64 `json:"archived"`
}

type ProjectDirectory struct {
	Projects []ProjectDirectoryItem  `json:"projects"`
	Summary  ProjectDirectorySummary `json:"summary"`
	Total    int64                   `json:"total"`
	Limit    int                     `json:"limit"`
	Offset   int                     `json:"offset"`
	HasMore  bool                    `json:"hasMore"`
}
