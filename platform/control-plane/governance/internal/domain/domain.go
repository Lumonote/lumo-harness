// Package domain contains the Cluster-only organization and capability
// governance contracts. It intentionally keeps the feature gate and skill
// precedence pure so every HTTP/storage adapter has one behavior to test.
package domain

import (
	"errors"
	"fmt"
	"sort"
	"time"
)

type DeploymentMode string

const (
	ModeLocal      DeploymentMode = "local"
	ModeStandalone DeploymentMode = "standalone"
	ModeCluster    DeploymentMode = "cluster"
)

const ClusterReady = "ready"

var ErrClusterOnly = errors.New("CLUSTER_ONLY")

// Features is the server-authoritative capability descriptor. A UI may use it
// to hide unavailable controls, but handlers must still call RequireCluster.
type Features struct {
	DeploymentMode         DeploymentMode `json:"deployment_mode"`
	ClusterStatus          string         `json:"cluster_status"`
	OrganizationGovernance bool           `json:"organization_governance"`
	SkillDistribution      bool           `json:"skill_distribution"`
	DesktopWorkers         bool           `json:"desktop_workers"`
	ArtifactRollouts       bool           `json:"artifact_rollouts"`
	CrossNodeDelegation    bool           `json:"cross_node_delegation"`
}

func NewFeatures(mode DeploymentMode, clusterStatus string) Features {
	enabled := mode == ModeCluster && clusterStatus == ClusterReady
	return Features{
		DeploymentMode: mode, ClusterStatus: clusterStatus,
		OrganizationGovernance: enabled, SkillDistribution: enabled,
		DesktopWorkers: enabled, ArtifactRollouts: enabled, CrossNodeDelegation: enabled,
	}
}

func RequireCluster(mode DeploymentMode, clusterStatus string) error {
	if mode != ModeCluster || clusterStatus != ClusterReady {
		return ErrClusterOnly
	}
	return nil
}

type User struct {
	ID            string    `json:"id"`
	Realm         string    `json:"realm"`
	DisplayName   string    `json:"display_name"`
	PrimaryDeptID string    `json:"primary_dept_id,omitempty"`
	Status        string    `json:"status"`
	Source        string    `json:"source"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type Department struct {
	ID            string `json:"id"`
	Realm         string `json:"realm"`
	ParentDeptID  string `json:"parent_dept_id,omitempty"`
	Name          string `json:"name"`
	ManagerUserID string `json:"manager_user_id,omitempty"`
	Path          string `json:"path"`
	Level         int    `json:"level"`
	Status        string `json:"status"`
}

type Role struct {
	ID          string `json:"id"`
	Realm       string `json:"realm"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Status      string `json:"status"`
}

type SkillKind string

const (
	SkillPrompt    SkillKind = "prompt"
	SkillWorkflow  SkillKind = "workflow"
	SkillTool      SkillKind = "tool"
	SkillConnector SkillKind = "connector"
)

func (k SkillKind) Valid() bool {
	return k == SkillPrompt || k == SkillWorkflow || k == SkillTool || k == SkillConnector
}

type Skill struct {
	ID             string    `json:"id"`
	Realm          string    `json:"realm"`
	Name           string    `json:"name"`
	Kind           SkillKind `json:"kind"`
	Visibility     string    `json:"visibility"`
	CurrentVersion string    `json:"current_version"`
	CreatedBy      string    `json:"created_by"`
	CreatedAt      time.Time `json:"created_at"`
}

type SubjectType string

const (
	SubjectUser       SubjectType = "user"
	SubjectRole       SubjectType = "role"
	SubjectDepartment SubjectType = "department"
	SubjectProject    SubjectType = "project"
	SubjectAgent      SubjectType = "agent"
)

func (s SubjectType) Valid() bool {
	return s == SubjectUser || s == SubjectRole || s == SubjectDepartment || s == SubjectProject || s == SubjectAgent
}

type SkillGrant struct {
	ID                string      `json:"id"`
	Realm             string      `json:"realm"`
	SkillID           string      `json:"skill_id"`
	VersionConstraint string      `json:"version_constraint,omitempty"`
	SubjectType       SubjectType `json:"subject_type"`
	SubjectID         string      `json:"subject_id"`
	IncludeChildren   bool        `json:"include_children"`
	ExpiresAt         *time.Time  `json:"expires_at,omitempty"`
	GrantedBy         string      `json:"granted_by"`
}

type SkillRevocation struct {
	ID          string      `json:"id"`
	Realm       string      `json:"realm"`
	SkillID     string      `json:"skill_id"`
	SubjectType SubjectType `json:"subject_type"`
	SubjectID   string      `json:"subject_id"`
	Reason      string      `json:"reason"`
	ExpiresAt   *time.Time  `json:"expires_at,omitempty"`
	RevokedBy   string      `json:"revoked_by"`
}

// Candidate is a grant that has already been matched to a user context by the
// store. Priority encodes the documented precedence, while Source keeps the
// result explainable for the operator and UI.
type Candidate struct {
	Skill    Skill
	Version  string
	Source   string
	Priority int
}

type EffectiveSkill struct {
	SkillID  string    `json:"skill_id"`
	Name     string    `json:"name"`
	Kind     SkillKind `json:"kind"`
	Version  string    `json:"version"`
	Source   string    `json:"source"`
	Priority int       `json:"-"`
}

const (
	PriorityInheritedDepartment = 10
	PriorityDepartment          = 20
	PriorityRole                = 30
	PriorityProject             = 40
	PriorityUser                = 50
)

// ResolveEffectiveSkills applies the fail-closed version rule. Equal priority
// grants for the same skill must agree on an exact version; silently choosing
// the newest version would make authorization an upgrade side effect.
func ResolveEffectiveSkills(candidates []Candidate, revoked map[string]bool) ([]EffectiveSkill, error) {
	chosen := make(map[string]Candidate)
	for _, candidate := range candidates {
		if revoked[candidate.Skill.ID] {
			continue
		}
		if candidate.Version == "" {
			candidate.Version = candidate.Skill.CurrentVersion
		}
		current, ok := chosen[candidate.Skill.ID]
		if !ok || candidate.Priority > current.Priority {
			chosen[candidate.Skill.ID] = candidate
			continue
		}
		if candidate.Priority == current.Priority && candidate.Version != current.Version {
			return nil, fmt.Errorf("skill %s has conflicting versions %s and %s at priority %d", candidate.Skill.ID, current.Version, candidate.Version, candidate.Priority)
		}
	}

	out := make([]EffectiveSkill, 0, len(chosen))
	for _, candidate := range chosen {
		out = append(out, EffectiveSkill{
			SkillID: candidate.Skill.ID, Name: candidate.Skill.Name, Kind: candidate.Skill.Kind,
			Version: candidate.Version, Source: candidate.Source, Priority: candidate.Priority,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SkillID < out[j].SkillID })
	return out, nil
}

type DesktopNodeStatus string

const (
	NodePendingActivation DesktopNodeStatus = "PENDING_ACTIVATION"
	NodeOnline            DesktopNodeStatus = "ONLINE"
	NodeDraining          DesktopNodeStatus = "DRAINING"
	NodeOffline           DesktopNodeStatus = "OFFLINE"
	NodeRevoked           DesktopNodeStatus = "REVOKED"
)

type DesktopNode struct {
	ID                 string            `json:"id"`
	Realm              string            `json:"realm"`
	ClusterID          string            `json:"cluster_id"`
	OwnerUserID        string            `json:"owner_user_id"`
	DisplayName        string            `json:"display_name"`
	OS                 string            `json:"os"`
	Arch               string            `json:"arch"`
	ClientVersion      string            `json:"client_version"`
	Capacity           int               `json:"capacity"`
	Capabilities       []string          `json:"capabilities"`
	Residency          string            `json:"residency,omitempty"`
	Status             DesktopNodeStatus `json:"status"`
	SchedulingEligible bool              `json:"scheduling_eligible"`
	LastSeenAt         time.Time         `json:"last_seen_at"`
}
