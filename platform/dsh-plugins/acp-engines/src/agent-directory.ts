import { roomRole } from './role-room-model.ts'
import { sameScope, type SessionScope } from './session-scope.ts'

export interface AgentProfile extends SessionScope { id: string; name: string; engineId: string; instruction: string; modelId?: string }
export const agentProfile = (value: unknown, scope: SessionScope): AgentProfile => {
  const role = roomRole(value)
  const { agentId: _agentId, sessionId: _sessionId, ...config } = role
  return { ...config, ...scope }
}
export const scopedAgents = (profiles: AgentProfile[], scope: SessionScope): AgentProfile[] => profiles.filter(p => sameScope(p, scope))
