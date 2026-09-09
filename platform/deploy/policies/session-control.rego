package lumo.session_control

import rego.v1

default allow := false

commands := {
  "operator": {"pause", "resume", "stop", "replay"},
  "approver": {"approve", "reject", "degrade"},
  "admin": {"pause", "resume", "stop", "abort", "approve", "reject", "replay", "degrade"},
  "realm_admin": {"pause", "resume", "stop", "abort", "approve", "reject", "replay", "degrade"},
  "platform_admin": {"pause", "resume", "stop", "abort", "approve", "reject", "replay", "degrade"},
}

allow if {
  input.realm != ""
  input.actor != ""
  input.sessionRef != ""
  input.command in commands[input.role]
}
