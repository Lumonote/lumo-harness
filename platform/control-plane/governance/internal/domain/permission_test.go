package domain

import "testing"

func boolPtr(value bool) *bool { return &value }

func TestEvaluatePermissionUsesMinimumIntersection(t *testing.T) {
	base := PermissionRequest{
		Actor:    PermissionActor{UserID: "u-1", Realm: "acme"},
		Action:   ActionTaskDelegate,
		Resource: PermissionResource{Realm: "acme", ProjectID: "p-1", SpaceID: "s-1"},
		Context:  PermissionContext{RealmAllowed: true, ProjectAllowed: boolPtr(true), SpaceAllowed: boolPtr(true)},
	}
	if decision := EvaluatePermission(base); !decision.Allowed {
		t.Fatalf("decision = %#v, want allow", decision)
	}
	for name, mutate := range map[string]func(*PermissionRequest){
		"realm":   func(req *PermissionRequest) { req.Context.RealmAllowed = false },
		"project": func(req *PermissionRequest) { req.Context.ProjectAllowed = boolPtr(false) },
		"space":   func(req *PermissionRequest) { req.Context.SpaceAllowed = nil },
	} {
		t.Run(name, func(t *testing.T) {
			req := base
			mutate(&req)
			if decision := EvaluatePermission(req); decision.Allowed {
				t.Fatalf("decision = %#v, want deny", decision)
			}
		})
	}
}
