// The driver of each protocol an agent speaks, and the one an agent starts through.

import type { AgentId } from '@shared/thread'
import { ACP_DRIVER } from './acp/driver'
import { CLAUDE_SDK_DRIVER } from './claude/driver'
import { CLINE_SDK_DRIVER } from './cline/driver'
import { protocolOf, type AgentDefinition, type AgentProtocol } from './catalog'
import { CODEX_DRIVER } from './codex/driver'
import { DSH_DRIVER } from './dsh/driver'
import type { AgentDriver } from './driver'
import { heldBack, inNpmRange, type HarnessRule } from './harness-manifest'
import { OPENCODE_SERVER_DRIVER } from './opencode/driver'
import { PI_DRIVER } from './pi/driver'

export const DRIVERS: Readonly<Record<AgentProtocol, AgentDriver>> = {
  acp: ACP_DRIVER,
  'claude-sdk': CLAUDE_SDK_DRIVER,
  'cline-sdk': CLINE_SDK_DRIVER,
  'codex-app-server': CODEX_DRIVER,
  'dsh-sdk': DSH_DRIVER,
  'opencode-server': OPENCODE_SERVER_DRIVER,
  'pi-rpc': PI_DRIVER,
}

/** What replaces the catalog's protocols or the built-in drivers, as a test does. */
export interface DriverOverrides {
  /** Each agent's protocol over the catalog's, such as the fake ACP agent under another's id. */
  protocols?: Partial<Record<AgentId, AgentProtocol>>
  drivers?: Partial<Record<AgentProtocol, AgentDriver>>
}

/**
 * The harness's preferred interface when a start can run on it: its program is a `version` the
 * interface was checked on, the manifest's `rule` does not hold that version back, and a start
 * over it has not `failed` for that version. Null for a start on the definition's protocol.
 */
export function preferredProtocol(
  def: AgentDefinition,
  version: string | null,
  rule: HarnessRule | null,
  failed: string | null,
): AgentProtocol | null {
  const preferred = def.preferred
  if (!preferred || version === null || failed === version) return null
  if (!inNpmRange(version, preferred.checked) || heldBack(rule, version)) return null
  return preferred.protocol
}

/** The protocol a launch speaks: the preferred one it `chose`, else the agent's own. */
export function protocolFor(
  def: AgentDefinition,
  overrides: DriverOverrides = {},
  chosen: AgentProtocol | null = null,
): AgentProtocol {
  return chosen ?? overrides.protocols?.[def.id] ?? protocolOf(def)
}

export function driverOf(
  def: AgentDefinition,
  overrides: DriverOverrides = {},
  chosen: AgentProtocol | null = null,
): AgentDriver {
  const protocol = protocolFor(def, overrides, chosen)
  return overrides.drivers?.[protocol] ?? DRIVERS[protocol]
}
