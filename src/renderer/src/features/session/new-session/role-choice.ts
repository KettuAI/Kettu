import { create } from 'zustand'
import type { AgentStatus, KettuRole } from '@shared/agent-host'
import { harnessOf } from '@shared/agents'
import type { AgentId, ConfigOption } from '@shared/thread'
import { isSelect } from '@renderer/features/session/composer/options'
import { setOption } from './prepared'

// The role New session starts the next session as, by its reference. It lasts until that session
// starts or the user picks it again to drop it; what it suggests is applied to the tray once.

/** A suggestion of the role that the tray could not take, and what it starts with instead. */
export interface RoleNotice {
  kind: 'agent' | 'model' | 'effort'
  wanted: string
  actual: string
}

interface RoleChoiceStore {
  ref: string | null
  /** What of the role's suggestions was applied for this agent already. */
  applied: { key: string; model: boolean; effort: boolean } | null
  notices: RoleNotice[]
}

export const useRoleChoice = create<RoleChoiceStore>(() => ({
  ref: null,
  applied: null,
  notices: [],
}))

/** Picks the role, or drops it when it is the one chosen. */
export function toggleRole(ref: string): void {
  useRoleChoice.setState((s) => ({
    ref: s.ref === ref ? null : ref,
    applied: null,
    notices: [],
  }))
}

/** The session started; the next one starts with no role. */
export function roleStarted(): void {
  useRoleChoice.setState({ ref: null, applied: null, notices: [] })
}

/** The agent a role suggests among the host's: by its id, or the first of the harness named. */
export function suggestedAgent(
  agents: readonly Pick<AgentStatus, 'id'>[],
  suggested: string | undefined,
): AgentId | null {
  if (!suggested) return null
  const exact = agents.find((agent) => agent.id === suggested)
  if (exact) return exact.id
  return agents.find((agent) => harnessOf(agent.id) === suggested)?.id ?? null
}

/** The value of the choice a suggestion names, by its value or its name, ignoring case. */
function matchChoice(option: ConfigOption | undefined, suggested: string): string | null {
  if (!isSelect(option)) return null
  const wanted = suggested.toLowerCase()
  const found = option.choices.find(
    (choice) => choice.value.toLowerCase() === wanted || choice.name.toLowerCase() === wanted,
  )
  return found?.value ?? null
}

const shown = (option: ConfigOption | undefined): string =>
  isSelect(option) ? (option.choices.find((c) => c.value === option.value)?.name ?? '') : ''

/**
 * Puts what the role suggests on the tray: its model, then once that shows, its effort, each
 * only once for a role and agent, so the user's own change after it stays. What the agent does
 * not offer is kept as a notice. Does nothing while the agent's options are not known, or when
 * the user chose another agent than the role suggests.
 */
export function applyRole(
  role: KettuRole,
  agentId: AgentId | null,
  agents: readonly Pick<AgentStatus, 'id'>[],
  hostId: string | null,
  config: readonly ConfigOption[] | null,
): void {
  const { suggests } = role
  const store = useRoleChoice.getState()
  const fits =
    !suggests.agent || (agentId !== null && suggestedAgent(agents, suggests.agent) === agentId)
  if (!agentId || !fits) {
    if (store.applied || store.notices.length > 0)
      useRoleChoice.setState({ applied: null, notices: [] })
    return
  }
  if (!config) return
  const key = `${role.ref}|${agentId}`
  const fresh = store.applied?.key !== key
  const applied =
    fresh || !store.applied ? { key, model: false, effort: false } : { ...store.applied }
  const found: RoleNotice[] = []
  const model = config.find((o) => o.category === 'model' && isSelect(o))
  const effort = config.find((o) => o.category === 'thought_level' && isSelect(o))
  let waits = false
  if (!applied.model) {
    applied.model = true
    if (suggests.model) {
      const value = matchChoice(model, suggests.model)
      if (value === null) {
        found.push({ kind: 'model', wanted: suggests.model, actual: shown(model) })
      } else if (model && value !== model.value) {
        setOption(hostId, agentId, model.id, value)
        // The model's own efforts show once it is picked.
        waits = true
      }
    }
  }
  if (!applied.effort && !waits) {
    applied.effort = true
    if (suggests.effort) {
      const value = matchChoice(effort, suggests.effort)
      if (value === null) {
        found.push({ kind: 'effort', wanted: suggests.effort, actual: shown(effort) })
      } else if (effort && value !== effort.value) {
        setOption(hostId, agentId, effort.id, value)
      }
    }
  }
  useRoleChoice.setState({ applied, notices: [...(fresh ? [] : store.notices), ...found] })
}
