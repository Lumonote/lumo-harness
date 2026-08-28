package domain

import "testing"

func TestClusterFeaturesAndGate(t *testing.T) {
	standalone := NewFeatures(ModeStandalone, ClusterReady)
	if standalone.OrganizationGovernance || standalone.DesktopWorkers {
		t.Fatal("standalone must not expose cluster-only capabilities")
	}
	if err := RequireCluster(ModeStandalone, ClusterReady); err != ErrClusterOnly {
		t.Fatalf("standalone gate = %v, want CLUSTER_ONLY", err)
	}

	cluster := NewFeatures(ModeCluster, ClusterReady)
	if !cluster.OrganizationGovernance || !cluster.SkillDistribution || !cluster.DesktopWorkers {
		t.Fatalf("ready cluster features = %+v, want all enabled", cluster)
	}
	if err := RequireCluster(ModeCluster, ClusterReady); err != nil {
		t.Fatalf("ready cluster rejected: %v", err)
	}
}

func TestResolveEffectiveSkills(t *testing.T) {
	skill := Skill{ID: "skill-review", Name: "review", Kind: SkillPrompt, CurrentVersion: "2.0.0"}
	out, err := ResolveEffectiveSkills([]Candidate{
		{Skill: skill, Version: "1.0.0", Source: "department:platform", Priority: PriorityDepartment},
		{Skill: skill, Version: "2.0.0", Source: "user:alice", Priority: PriorityUser},
	}, nil)
	if err != nil || len(out) != 1 || out[0].Version != "2.0.0" || out[0].Source != "user:alice" {
		t.Fatalf("resolution = %#v, %v", out, err)
	}

	blocked, err := ResolveEffectiveSkills([]Candidate{{Skill: skill, Source: "role:editor", Priority: PriorityRole}}, map[string]bool{skill.ID: true})
	if err != nil || len(blocked) != 0 {
		t.Fatalf("explicit revocation must win: %#v, %v", blocked, err)
	}
}

func TestResolveRejectsSamePriorityVersionConflict(t *testing.T) {
	skill := Skill{ID: "skill-a", CurrentVersion: "1.0.0"}
	_, err := ResolveEffectiveSkills([]Candidate{
		{Skill: skill, Version: "1.0.0", Priority: PriorityRole},
		{Skill: skill, Version: "2.0.0", Priority: PriorityRole},
	}, nil)
	if err == nil {
		t.Fatal("same-priority conflicting versions must fail closed")
	}
}
