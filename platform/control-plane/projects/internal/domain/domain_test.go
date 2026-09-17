package domain

import (
	"testing"
)

// 判据 7（双实现）：与 TS 侧 projects.spec 的矩阵逐格一致。改一侧不改另一侧，
// 两侧的 18 格断言会同时红——契约漂移无处藏。
func TestCanProjectMatrix(t *testing.T) {
	cases := []struct {
		role string
		want map[string]bool
	}{
		{RoleOwner, map[string]bool{
			ActionRead: true, ActionEdit: true, ActionMembersManage: true,
			ActionArchive: true, ActionDelete: true, ActionBudgetConfig: true,
		}},
		{RoleEditor, map[string]bool{
			ActionRead: true, ActionEdit: true, ActionMembersManage: false,
			ActionArchive: false, ActionDelete: false, ActionBudgetConfig: false,
		}},
		{RoleViewer, map[string]bool{
			ActionRead: true, ActionEdit: false, ActionMembersManage: false,
			ActionArchive: false, ActionDelete: false, ActionBudgetConfig: false,
		}},
	}
	for _, c := range cases {
		for _, action := range []string{
			ActionRead, ActionEdit, ActionMembersManage,
			ActionArchive, ActionDelete, ActionBudgetConfig,
		} {
			got, err := CanProject(c.role, action)
			if err != nil {
				t.Fatalf("%s × %s: %v", c.role, action, err)
			}
			if got != c.want[action] {
				t.Fatalf("%s × %s = %v, want %v", c.role, action, got, c.want[action])
			}
		}
	}
}

func TestCanProjectClosedSets(t *testing.T) {
	if _, err := CanProject("admin", ActionRead); err == nil {
		t.Fatalf("闭集外角色应报错")
	}
	if _, err := CanProject(RoleOwner, "project.summon"); err == nil {
		t.Fatalf("闭集外动作应报错")
	}
}

func TestTransitionProject(t *testing.T) {
	cases := []struct{ status, event, want string }{
		{StatusActive, "archive", StatusArchived},
		{StatusArchived, "unarchive", StatusActive},
		// 自反转移幂等：重复 archive 是重放不是错误
		{StatusArchived, "archive", StatusArchived},
		{StatusActive, "unarchive", StatusActive},
	}
	for _, c := range cases {
		got, err := TransitionProject(c.status, c.event)
		if err != nil || got != c.want {
			t.Fatalf("%s --%s--> got %s err %v, want %s", c.status, c.event, got, err, c.want)
		}
	}
	for _, bad := range []struct{ status, event string }{
		{"deleted", "archive"},
		{StatusActive, "delete"},
	} {
		if _, err := TransitionProject(bad.status, bad.event); err == nil {
			t.Fatalf("%s --%s--> 应报错（闭集外）", bad.status, bad.event)
		}
	}
}
