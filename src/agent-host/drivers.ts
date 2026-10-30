// The driver of each protocol an agent speaks, and the one an agent starts through.

import type { AgentId } from '@shared/thread'
import { ACP_DRIVER } from './acp/driver'
import { CLAUDE_SDK_DRIVER } from './claude/driver'
import { protocolOf, type AgentDefinition, type AgentProtocol } from './catalog'
import { CODEX_DRIVER } from './codex/driver'
import type { AgentDriver } from './driver'

export const DRIVERS: Readonly<Record<AgentProtocol, AgentDriver>> = {
  acp: ACP_DRIVER,
  'claude-sdk': CLAUDE_SDK_DRIVER,
  'codex-app-server': CODEX_DRIVER,
}

/** What replaces the catalog's protocols or the built-in drivers, as a test does. */
export interface DriverOverrides {
  /** Each agent's protocol over the catalog's, such as the fake ACP agent under another's id. */
  protocols?: Partial<Record<AgentId, AgentProtocol>>
  drivers?: Partial<Record<AgentProtocol, AgentDriver>>
}

export function driverOf(def: AgentDefinition, overrides: DriverOverrides = {}): AgentDriver {
  const protocol = overrides.protocols?.[def.id] ?? protocolOf(def)
  return overrides.drivers?.[protocol] ?? DRIVERS[protocol]
}
