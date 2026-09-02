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

func TestSkillVersionRequiresSourceAndBoundsIt(t *testing.T) {
	valid := SkillVersion{Realm: "dev", SkillID: "review", Version: "1.0.0", Content: "# Review", CreatedBy: "palmer"}
	if !valid.Valid() {
		t.Fatal("complete governed skill version should be valid")
	}
	valid.Content = ""
	if valid.Valid() {
		t.Fatal("empty content must not create a governed skill version")
	}
	valid.Content = string(make([]byte, 128<<10+1))
	if valid.Valid() {
		t.Fatal("oversized content must be rejected before persistence")
	}
}

func TestRankDelegationCandidatesIsExplainableAndBalancesLoad(t *testing.T) {
	inferredTags, inferredSkills, candidates := RankDelegationCandidates(DelegationSpec{
		Intent: "请跟进华东客户的合同复核",
	}, []UserProfile{
		{User: User{ID: "alice", DisplayName: "Alice", Status: "active"}, Tags: []string{"华东", "客户"}, Skills: []EffectiveSkill{{SkillID: "contract-review", Name: "合同复核"}}, ActiveTasks: 2},
		{User: User{ID: "bob", DisplayName: "Bob", Status: "active"}, Tags: []string{"华南"}, Skills: []EffectiveSkill{{SkillID: "contract-review", Name: "合同复核"}}, ActiveTasks: 0},
	})
	if len(inferredTags) != 2 || len(inferredSkills) != 1 {
		t.Fatalf("inference = %#v %#v", inferredTags, inferredSkills)
	}
	if len(candidates) != 2 || candidates[0].UserID != "alice" || !candidates[0].Eligible || !candidates[1].Eligible || candidates[0].Score <= candidates[1].Score {
		t.Fatalf("candidates = %#v", candidates)
	}
	if len(candidates[0].Rationale) == 0 {
		t.Fatal("eligible candidate must include rationale")
	}
}

func TestRankDelegationCandidatesRejectsMissingExplicitRequirement(t *testing.T) {
	_, _, candidates := RankDelegationCandidates(DelegationSpec{Intent: "合同复核", RequiredTags: []string{"华东"}}, []UserProfile{
		{User: User{ID: "bob", DisplayName: "Bob", Status: "active"}, Tags: []string{"华南"}, Skills: []EffectiveSkill{{SkillID: "contract-review", Name: "合同复核"}}},
	})
	if len(candidates) != 1 || candidates[0].Eligible {
		t.Fatalf("missing requirement must be ineligible: %#v", candidates)
	}
}

func TestRankDelegationCandidatesRejectsAgentOutsidePresetProjectScope(t *testing.T) {
	_, _, candidates := RankDelegationCandidates(DelegationSpec{Intent: "合同复核", ProjectID: "project-b", RequiredSkills: []string{"合同复核"}}, []UserProfile{{
		User: User{DisplayName: "合同 Agent", Status: "active"}, WorkerID: "agent:contract-review", WorkerKind: WorkerAgent,
		ProjectScopeID: "project-a", MaxConcurrency: 2,
		Skills: []EffectiveSkill{{SkillID: "contract-review", Name: "合同复核"}},
	}})
	if len(candidates) != 1 || candidates[0].Eligible {
		t.Fatalf("project-scoped agent must not be selectable outside its project: %#v", candidates)
	}
	if !containsFold(candidates[0].Rationale, "Agent preset 不在此项目的授权范围内") {
		t.Fatalf("candidate should explain project scope rejection: %#v", candidates[0].Rationale)
	}
}

func TestAgentPresetNormalizeAndValidate(t *testing.T) {
	preset := AgentPreset{
		ID: " agent-contract ", Realm: " realm-a ", Name: " 合同 Agent ", OwnerUserID: " owner ",
		Provider: " openai ", ModelRef: " gpt-5 ", ConnectorIDs: []string{"crm", " crm ", ""},
		KnowledgeSpaceIDs: []string{"legal", "legal"},
	}
	preset.Normalize()
	if !preset.Valid() {
		t.Fatalf("normalized preset should be valid: %#v", preset)
	}
	if preset.Status != "active" || preset.Version != "1.0.0" || preset.MaxConcurrency != 1 || preset.TimeoutSeconds != 3600 {
		t.Fatalf("defaults missing: %#v", preset)
	}
	if len(preset.ConnectorIDs) != 1 || preset.ConnectorIDs[0] != "crm" || len(preset.KnowledgeSpaceIDs) != 1 {
		t.Fatalf("references should be deduplicated: %#v", preset)
	}
	preset.MaxDelegationDepth = 17
	if preset.Valid() {
		t.Fatal("preset with excessive delegation depth must be rejected")
	}
}
