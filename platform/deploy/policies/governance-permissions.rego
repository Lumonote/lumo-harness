package lumo.governance

import rego.v1

# All grant and inheritance facts come from Governance PostgreSQL. OPA can
# add restrictions here but Governance never lets this response elevate deny.
default allow := false

allow if {
  input.proposed.allowed == true
  input.request.resource.realm == input.request.actor.realm
  input.request.context.realm_allowed == true
  input.role_facts.actions[input.request.action].allowed == true
  project_allowed
  space_allowed
}

project_allowed if { object.get(input.request.resource, "project_id", "") == "" }
project_allowed if { input.request.resource.project_id != ""; input.request.context.project_allowed == true }
space_allowed if { object.get(input.request.resource, "space_id", "") == "" }
space_allowed if { input.request.resource.space_id != ""; input.request.context.space_allowed == true }
