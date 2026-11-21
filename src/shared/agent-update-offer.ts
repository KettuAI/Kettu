// The update a harness offers through one of its agents, which the sidebar's card and the notch
// island both offer.

import type { AgentStatus, ProgramMethod } from './agent-host'
import type { AgentId } from './thread'

/** One harness's update on offer, as the card and its popover name it. */
export interface AgentUpdateOffer {
  agentId: AgentId
  name: string
  /** The version that runs now; null when unknown. */
  from: string | null
  to: string
  /** The command that updates the user's own program; null when Kettu updates its package. */
  command: string | null
  /** How the user installed their program, which the command follows. */
  method: ProgramMethod | null
  /** Kettu's package the update installs; `versions` when `from` and `to` are its own. */
  package: { name: string; versions: boolean } | null
}

/** The update a harness offers through this agent, or null when it is up to date. */
export function updateOffer(status: AgentStatus): AgentUpdateOffer | null {
  const base = { agentId: status.id, name: status.harnessName }
  const cli = status.cli
  if (cli?.update) {
    return {
      ...base,
      from: cli.installed?.version ?? null,
      to: cli.update.version,
      command: cli.update.command,
      method: cli.method,
      package: null,
    }
  }
  const { update } = status
  // A release Kettu installed from the registry moves to the version the registry lists.
  if (update && status.release) {
    const { version } = status.release
    return {
      ...base,
      from: version,
      to: update.adapterVersion,
      command: null,
      method: null,
      package: null,
    }
  }
  if (!update || !status.package) return null
  const current = cli ? (cli.installed?.version ?? null) : status.version
  // An update that brings no newer agent changes only the package, so it names the package's
  // versions.
  const agent = update.cliVersion !== null && update.cliVersion !== current
  return {
    ...base,
    from: agent ? current : status.package.version,
    to: agent ? update.cliVersion! : update.adapterVersion,
    command: null,
    method: null,
    package: { name: status.package.name, versions: !agent },
  }
}
