package domain

import (
	"fmt"
	"sort"
)

const MaxRoleDepth = 32

type PermissionActionInfo struct {
	Action      PermissionAction `json:"action"`
	Name        string           `json:"name"`
	Description string           `json:"description"`
}

func PermissionActionCatalog() []PermissionActionInfo {
	return []PermissionActionInfo{
		{ActionTaskDelegate, "任务委派", "查看、创建和管理任务委派；项目与 Space 授权仍需同时满足"},
		{ActionTaskExecutionUpdate, "执行状态更新", "报告任务执行状态和结果；不授予组织管理权限"},
	}
}

func SupportedPermissionAction(action PermissionAction) bool {
	return action == ActionTaskDelegate || action == ActionTaskExecutionUpdate
}

// Built-in defaults are compatibility facts, not a second editable policy store.
func LegacyRoleAllows(role string, action PermissionAction) bool {
	switch role {
	case "platform_admin", "realm_admin", "admin", "operator", "agent_operator":
		return SupportedPermissionAction(action)
	case "manager", "dept_manager", "owner":
		return action == ActionTaskDelegate
	}
	return false
}

type RolePermission struct {
	Action PermissionAction `json:"action"`
	Effect string           `json:"effect"`
}

type RolePolicyFact struct {
	RoleID       string           `json:"role_id"`
	ParentRoleID string           `json:"parent_role_id,omitempty"`
	Status       string           `json:"status"`
	Revision     int64            `json:"revision"`
	Permissions  []RolePermission `json:"permissions"`
}

type RoleActionDecision struct {
	Allowed         bool     `json:"allowed"`
	ExplicitDeny    bool     `json:"explicit_deny"`
	MatchedPolicies []string `json:"matched_policies"`
}

type RoleResolution struct {
	DirectRoles    []string                                `json:"direct_roles"`
	EffectiveRoles []string                                `json:"effective_roles"`
	Facts          []RolePolicyFact                        `json:"facts"`
	Actions        map[PermissionAction]RoleActionDecision `json:"actions"`
}

// ResolveRolePolicy is shared by runtime action checks, explanations and skills.
// DirectRoles stay separate: inherited administrator names must never become
// organization-administrator credentials in headers or login principals.
func ResolveRolePolicy(direct []string, catalog []RolePolicyFact) (RoleResolution, error) {
	byID := map[string]RolePolicyFact{}
	for _, role := range catalog {
		byID[role.RoleID] = role
	}
	result := RoleResolution{DirectRoles: []string{}, EffectiveRoles: []string{}, Facts: []RolePolicyFact{}, Actions: map[PermissionAction]RoleActionDecision{}}
	directSet, effective := map[string]bool{}, map[string]RolePolicyFact{}
	for _, id := range direct {
		if id != "" {
			directSet[id] = true
		}
	}
	for id := range directSet {
		result.DirectRoles = append(result.DirectRoles, id)
	}
	sort.Strings(result.DirectRoles)
	for _, root := range result.DirectRoles {
		path := map[string]bool{}
		for id, depth := root, 1; id != ""; depth++ {
			if depth > MaxRoleDepth || path[id] {
				return RoleResolution{}, fmt.Errorf("invalid role hierarchy")
			}
			path[id] = true
			role, exists := byID[id]
			if !exists {
				if depth != 1 {
					return RoleResolution{}, fmt.Errorf("missing parent role")
				}
				role = RolePolicyFact{RoleID: id, Status: "legacy", Permissions: []RolePermission{}}
			}
			if role.Status != "active" && role.Status != "legacy" {
				break
			}
			effective[id] = role
			id = role.ParentRoleID
		}
	}
	for id := range effective {
		result.EffectiveRoles = append(result.EffectiveRoles, id)
	}
	sort.Strings(result.EffectiveRoles)
	for _, id := range result.EffectiveRoles {
		result.Facts = append(result.Facts, effective[id])
	}
	for _, action := range PermissionActionCatalog() {
		decision := RoleActionDecision{MatchedPolicies: []string{}}
		for _, fact := range result.Facts {
			effect := "inherit"
			for _, rule := range fact.Permissions {
				if !SupportedPermissionAction(rule.Action) || (rule.Effect != "allow" && rule.Effect != "deny") {
					return RoleResolution{}, fmt.Errorf("invalid role permission")
				}
				if rule.Action == action.Action {
					effect = rule.Effect
				}
			}
			switch effect {
			case "deny":
				decision.ExplicitDeny = true
				decision.MatchedPolicies = append(decision.MatchedPolicies, "realm:role:"+fact.RoleID+":deny")
			case "allow":
				decision.Allowed = true
				decision.MatchedPolicies = append(decision.MatchedPolicies, "realm:role:"+fact.RoleID+":allow")
			default:
				if LegacyRoleAllows(fact.RoleID, action.Action) {
					decision.Allowed = true
					decision.MatchedPolicies = append(decision.MatchedPolicies, "realm:role:"+fact.RoleID)
				}
			}
		}
		if decision.ExplicitDeny {
			decision.Allowed = false
		}
		result.Actions[action.Action] = decision
	}
	return result, nil
}

// ValidateRoleHierarchy checks all descendants too: reparenting a shallow role
// must not push one of its existing children past the supported depth.
func ValidateRoleHierarchy(catalog []RolePolicyFact) error {
	byID := map[string]RolePolicyFact{}
	for _, role := range catalog {
		byID[role.RoleID] = role
	}
	for _, role := range catalog {
		seen := map[string]bool{}
		for id, depth := role.RoleID, 1; id != ""; depth++ {
			if depth > MaxRoleDepth || seen[id] {
				return fmt.Errorf("role hierarchy must be acyclic and at most %d levels", MaxRoleDepth)
			}
			seen[id] = true
			current, ok := byID[id]
			if !ok {
				return fmt.Errorf("parent role must exist in this realm")
			}
			id = current.ParentRoleID
		}
	}
	return nil
}
