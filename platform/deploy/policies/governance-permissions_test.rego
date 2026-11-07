package lumo.governance

import rego.v1

base_input := {
  "proposed": {"allowed": true},
  "request": {"actor": {"realm": "r1"}, "resource": {"realm": "r1"}, "action": "task:delegate", "context": {"realm_allowed": true}},
  "role_facts": {"actions": {"task:delegate": {"allowed": true}}},
}

test_allows_same_local_facts if { allow with input as base_input }
test_rejects_local_deny if { not allow with input as object.union(base_input, {"proposed": {"allowed": false}}) }
test_rejects_role_deny if { not allow with input as object.union(base_input, {"role_facts": {"actions": {"task:delegate": {"allowed": false}}}}) }
test_rejects_cross_realm if { not allow with input as object.union(base_input, {"request": object.union(base_input.request, {"resource": {"realm": "r2"}})}) }
test_requires_project_membership if { not allow with input as object.union(base_input, {"request": object.union(base_input.request, {"resource": {"realm": "r1", "project_id": "p1"}})}) }
test_requires_space_permission if { not allow with input as object.union(base_input, {"request": object.union(base_input.request, {"resource": {"realm": "r1", "space_id": "s1"}})}) }
test_allows_complete_scope if {
  request := object.union(base_input.request, {"resource": {"realm": "r1", "project_id": "p1", "space_id": "s1"}, "context": {"realm_allowed": true, "project_allowed": true, "space_allowed": true}})
  allow with input as object.union(base_input, {"request": request})
}
