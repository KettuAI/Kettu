// Unified harness integration completeness checklist shown in Settings > Agents.
//
// Every harness shares the same ordered capability list with three explicit statuses:
// 'supported', 'partial', or 'unavailable'. A gapReason ('upstream' | 'kettu') is only
// recorded when verified directly against the harness protocol or codebase; unverified
// causes leave gapReason omitted.

import { harnessOf, type AgentId, type HarnessId } from './agents'

/** Fixed ordered checklist of Kettu integration capabilities shared by every harness. */
export const HARNESS_CAPABILITY_IDS = [
  'steering',
  'rewind',
  'fileRewind',
  'fork',
  'imageInput',
  'mcp',
  'contextBreakdown',
  'usageHistory',
  'planLimits',
  'sideChat',
  'workflowsAndRoutines',
] as const

export type HarnessCapabilityId = (typeof HARNESS_CAPABILITY_IDS)[number]

export type CapabilitySupport = 'supported' | 'partial' | 'unavailable'

/**
 * Verified cause of a partial or unavailable capability:
 * - 'upstream': the harness, vendor, or protocol does not expose or permit it
 * - 'kettu': Kettu has not wired this integration yet
 */
export type CapabilityGapReason = 'upstream' | 'kettu'

/** Localization keys under `settings:agents.capabilities.notes.<key>`. */
export type CapabilityNoteKey =
  | 'acpNoForkAtMessage'
  | 'acpNoRewind'
  | 'acpStdioAlwaysHttpDepends'
  | 'acpStdioOnlyNoHttp'
  | 'agyNoSilentDelete'
  | 'clineModelRequestsOnly'
  | 'clineSdkOnly'
  | 'codexEstimatesOnly'
  | 'codexPaginatedThreadsOnly'
  | 'deepseekBalanceOnly'
  | 'dependsOnAcpAdapter'
  | 'limitsAdministratorManaged'
  | 'limitsHarnessDoesNotOffer'
  | 'limitsModelProviderManaged'
  | 'limitsNotYetSupported'
  | 'limitsVendorDisallows'
  | 'noSilentSessionDelete'
  | 'piExtensionRequired'
  | 'routinesOnlyNoWorkflows'
  | 'sideChatHiddenCopyOnly'

export interface HarnessCapabilityEntry {
  readonly status: CapabilitySupport
  /** Only set when `status !== 'supported'` and the cause is verified. */
  readonly gapReason?: CapabilityGapReason
  /** Optional concise verified detail key under `agents.capabilities.notes`. */
  readonly note?: CapabilityNoteKey
}

export type HarnessCapabilityMap = Readonly<Record<HarnessCapabilityId, HarnessCapabilityEntry>>

export interface ResolvedHarnessCapability extends HarnessCapabilityEntry {
  readonly id: HarnessCapabilityId
}

export interface HarnessCapabilitySummary {
  readonly supported: number
  readonly partial: number
  readonly unavailable: number
  readonly total: number
}

/**
 * Optional runtime capabilities reported by `AgentStatus.capabilities` once an agent has
 * initialized, used only to refine runtime-negotiated ACP entries.
 */
export interface RuntimeCapabilitiesSnapshot {
  readonly steering?: boolean
  readonly forkSession?: boolean
  readonly forkAtMessage?: boolean
  readonly mcpHttp?: boolean | null
  readonly prompt?: { readonly image: boolean } | null
}

const SUPPORTED: HarnessCapabilityEntry = { status: 'supported' }
const UNAVAILABLE: HarnessCapabilityEntry = { status: 'unavailable' }

const UPSTREAM_UNAVAILABLE: HarnessCapabilityEntry = {
  status: 'unavailable',
  gapReason: 'upstream',
}

const ACP_NO_REWIND: HarnessCapabilityEntry = {
  status: 'unavailable',
  gapReason: 'upstream',
  note: 'acpNoRewind',
}

const ACP_DYNAMIC_FORK: HarnessCapabilityEntry = {
  status: 'partial',
  note: 'dependsOnAcpAdapter',
}

const ACP_DYNAMIC_IMAGE: HarnessCapabilityEntry = {
  status: 'partial',
  note: 'dependsOnAcpAdapter',
}

const ACP_DYNAMIC_MCP: HarnessCapabilityEntry = {
  status: 'partial',
  note: 'acpStdioAlwaysHttpDepends',
}

const NO_SILENT_DELETE: HarnessCapabilityEntry = {
  status: 'unavailable',
  gapReason: 'upstream',
  note: 'noSilentSessionDelete',
}

const LIMITS_VENDOR_DISALLOWS: HarnessCapabilityEntry = {
  status: 'unavailable',
  gapReason: 'upstream',
  note: 'limitsVendorDisallows',
}

const LIMITS_HARNESS_NO_OFFER: HarnessCapabilityEntry = {
  status: 'unavailable',
  gapReason: 'upstream',
  note: 'limitsHarnessDoesNotOffer',
}

const LIMITS_ADMIN_MANAGED: HarnessCapabilityEntry = {
  status: 'unavailable',
  gapReason: 'upstream',
  note: 'limitsAdministratorManaged',
}

const LIMITS_PROVIDER_MANAGED: HarnessCapabilityEntry = {
  status: 'unavailable',
  gapReason: 'upstream',
  note: 'limitsModelProviderManaged',
}

const LIMITS_NOT_YET_SUPPORTED: HarnessCapabilityEntry = {
  status: 'unavailable',
  gapReason: 'kettu',
  note: 'limitsNotYetSupported',
}

/**
 * Baseline capability profile for harnesses driven over generic ACP (`acp` / `acp-folders`),
 * grounded in `src/agent-host/acp/connection.ts` and `src/agent-host/acp/hidden-sessions.ts`.
 */
function acpProfile(
  planLimits: HarnessCapabilityEntry,
  overrides: Partial<HarnessCapabilityMap> = {},
): HarnessCapabilityMap {
  return {
    steering: UNAVAILABLE,
    rewind: ACP_NO_REWIND,
    fileRewind: UPSTREAM_UNAVAILABLE,
    fork: ACP_DYNAMIC_FORK,
    imageInput: ACP_DYNAMIC_IMAGE,
    mcp: ACP_DYNAMIC_MCP,
    contextBreakdown: UNAVAILABLE,
    usageHistory: UNAVAILABLE,
    planLimits,
    sideChat: UNAVAILABLE,
    workflowsAndRoutines: UNAVAILABLE,
    ...overrides,
  }
}

/**
 * Exhaustive integration capability matrix keyed by every built-in `HarnessId`.
 * Adding a new harness to `HARNESS_IDS` requires a matching entry here at compile time.
 */
export const HARNESS_CAPABILITIES: Readonly<Record<HarnessId, HarnessCapabilityMap>> = {
  'claude-code': {
    steering: SUPPORTED,
    rewind: SUPPORTED,
    fileRewind: UNAVAILABLE,
    fork: SUPPORTED,
    imageInput: SUPPORTED,
    mcp: SUPPORTED,
    contextBreakdown: SUPPORTED,
    usageHistory: SUPPORTED,
    planLimits: SUPPORTED,
    sideChat: SUPPORTED,
    workflowsAndRoutines: SUPPORTED,
  },
  codex: {
    steering: SUPPORTED,
    rewind: {
      status: 'partial',
      gapReason: 'upstream',
      note: 'codexPaginatedThreadsOnly',
    },
    fileRewind: UPSTREAM_UNAVAILABLE,
    fork: SUPPORTED,
    imageInput: SUPPORTED,
    mcp: SUPPORTED,
    contextBreakdown: {
      status: 'partial',
      gapReason: 'upstream',
      note: 'codexEstimatesOnly',
    },
    usageHistory: SUPPORTED,
    planLimits: SUPPORTED,
    sideChat: SUPPORTED,
    workflowsAndRoutines: SUPPORTED,
  },
  opencode: {
    steering: SUPPORTED,
    rewind: SUPPORTED,
    fileRewind: SUPPORTED,
    fork: SUPPORTED,
    imageInput: SUPPORTED,
    mcp: SUPPORTED,
    contextBreakdown: UNAVAILABLE,
    usageHistory: SUPPORTED,
    planLimits: SUPPORTED,
    sideChat: SUPPORTED,
    workflowsAndRoutines: {
      status: 'partial',
      gapReason: 'kettu',
      note: 'routinesOnlyNoWorkflows',
    },
  },
  pi: {
    steering: SUPPORTED,
    rewind: SUPPORTED,
    fileRewind: UPSTREAM_UNAVAILABLE,
    fork: SUPPORTED,
    imageInput: SUPPORTED,
    mcp: {
      status: 'partial',
      gapReason: 'upstream',
      note: 'piExtensionRequired',
    },
    contextBreakdown: UNAVAILABLE,
    usageHistory: SUPPORTED,
    planLimits: LIMITS_PROVIDER_MANAGED,
    sideChat: SUPPORTED,
    workflowsAndRoutines: SUPPORTED,
  },
  cline: {
    steering: {
      status: 'partial',
      note: 'clineSdkOnly',
    },
    rewind: {
      status: 'partial',
      gapReason: 'upstream',
      note: 'clineSdkOnly',
    },
    fileRewind: UNAVAILABLE,
    fork: UPSTREAM_UNAVAILABLE,
    imageInput: SUPPORTED,
    mcp: SUPPORTED,
    contextBreakdown: UNAVAILABLE,
    usageHistory: {
      status: 'partial',
      gapReason: 'kettu',
      note: 'clineModelRequestsOnly',
    },
    planLimits: SUPPORTED,
    sideChat: NO_SILENT_DELETE,
    workflowsAndRoutines: UNAVAILABLE,
  },
  deepseek: {
    steering: UPSTREAM_UNAVAILABLE,
    rewind: UPSTREAM_UNAVAILABLE,
    fileRewind: UPSTREAM_UNAVAILABLE,
    fork: UPSTREAM_UNAVAILABLE,
    imageInput: SUPPORTED,
    mcp: SUPPORTED,
    contextBreakdown: UNAVAILABLE,
    usageHistory: UNAVAILABLE,
    planLimits: {
      status: 'partial',
      gapReason: 'upstream',
      note: 'deepseekBalanceOnly',
    },
    sideChat: NO_SILENT_DELETE,
    workflowsAndRoutines: UNAVAILABLE,
  },
  antigravity: acpProfile(SUPPORTED, {
    steering: SUPPORTED,
    mcp: SUPPORTED,
    contextBreakdown: SUPPORTED,
    usageHistory: SUPPORTED,
    sideChat: {
      status: 'unavailable',
      gapReason: 'upstream',
      note: 'agyNoSilentDelete',
    },
  }),
  'fake-agent': acpProfile(SUPPORTED, {
    fork: SUPPORTED,
    contextBreakdown: SUPPORTED,
    sideChat: SUPPORTED,
  }),

  // ACP harnesses with verified plan-limits readers.
  auggie: acpProfile(SUPPORTED),
  copilot: acpProfile(SUPPORTED),
  cursor: acpProfile(SUPPORTED),
  devin: acpProfile(SUPPORTED),
  droid: acpProfile(SUPPORTED),
  grok: acpProfile(SUPPORTED),
  junie: acpProfile(SUPPORTED, {
    sideChat: {
      status: 'partial',
      note: 'sideChatHiddenCopyOnly',
    },
  }),
  kilo: acpProfile(SUPPORTED),
  kimi: acpProfile(SUPPORTED),
  minimax: acpProfile(SUPPORTED),
  'mistral-vibe': acpProfile(SUPPORTED),
  qoder: acpProfile(SUPPORTED),
  'qoder-cn': acpProfile(SUPPORTED),

  // ACP harnesses with verified upstream plan-limits constraints.
  gemini: acpProfile(LIMITS_VENDOR_DISALLOWS),
  codebuddy: acpProfile(LIMITS_HARNESS_NO_OFFER),
  muse: acpProfile(LIMITS_HARNESS_NO_OFFER),
  poolside: acpProfile(LIMITS_HARNESS_NO_OFFER),
  qwen: acpProfile(LIMITS_HARNESS_NO_OFFER),
  'cortex-code': acpProfile(LIMITS_ADMIN_MANAGED),
  codewhale: acpProfile(LIMITS_PROVIDER_MANAGED),
  'crow-cli': acpProfile(LIMITS_PROVIDER_MANAGED),
  deepagents: acpProfile(LIMITS_PROVIDER_MANAGED),
  dirac: acpProfile(LIMITS_PROVIDER_MANAGED),
  'fast-agent': acpProfile(LIMITS_PROVIDER_MANAGED),
  goose: acpProfile(LIMITS_PROVIDER_MANAGED),
  harn: acpProfile(LIMITS_PROVIDER_MANAGED),
  minion: acpProfile(LIMITS_PROVIDER_MANAGED),
  sigit: acpProfile(LIMITS_PROVIDER_MANAGED),
  vtcode: acpProfile(LIMITS_PROVIDER_MANAGED),

  // ACP harnesses whose plan limits Kettu has not wired yet (`limitsReason: 'not-yet-supported'`).
  agoragentic: acpProfile(LIMITS_NOT_YET_SUPPORTED),
  amp: acpProfile(LIMITS_NOT_YET_SUPPORTED),
  autohand: acpProfile(LIMITS_NOT_YET_SUPPORTED),
  bob: acpProfile(LIMITS_NOT_YET_SUPPORTED),
  'corust-agent': acpProfile(LIMITS_NOT_YET_SUPPORTED),
  dimcode: acpProfile(LIMITS_NOT_YET_SUPPORTED),
  glm: acpProfile(LIMITS_NOT_YET_SUPPORTED),
  hermes: acpProfile(LIMITS_NOT_YET_SUPPORTED),
  kimchi: acpProfile(LIMITS_NOT_YET_SUPPORTED),
  nova: acpProfile(LIMITS_NOT_YET_SUPPORTED),
  omp: acpProfile(LIMITS_NOT_YET_SUPPORTED),
  stakpak: acpProfile(LIMITS_NOT_YET_SUPPORTED),
}

/** Looks up the static capability map for a default or added agent via its underlying harness. */
export function harnessCapabilities(id: AgentId): HarnessCapabilityMap {
  return HARNESS_CAPABILITIES[harnessOf(id)]
}

/**
 * Refines a single runtime-negotiated ACP capability entry once the agent has initialized
 * (`prompt !== null` or `mcpHttp !== null`). Static non-ACP entries are returned unchanged.
 */
function refineWithRuntime(
  id: HarnessCapabilityId,
  entry: HarnessCapabilityEntry,
  runtime: RuntimeCapabilitiesSnapshot,
): HarnessCapabilityEntry {
  const observed =
    (runtime.prompt !== null && runtime.prompt !== undefined) ||
    (runtime.mcpHttp !== null && runtime.mcpHttp !== undefined)

  if (id === 'steering' && entry === UNAVAILABLE && runtime.steering === true) {
    return SUPPORTED
  }

  if (id === 'fork' && entry.note === 'dependsOnAcpAdapter' && observed) {
    if (runtime.forkSession === true) {
      return runtime.forkAtMessage === true
        ? SUPPORTED
        : { status: 'partial', gapReason: 'upstream', note: 'acpNoForkAtMessage' }
    }
    if (runtime.forkSession === false) {
      return UPSTREAM_UNAVAILABLE
    }
  }

  if (id === 'imageInput' && entry.note === 'dependsOnAcpAdapter' && runtime.prompt) {
    return runtime.prompt.image ? SUPPORTED : UPSTREAM_UNAVAILABLE
  }

  if (
    id === 'mcp' &&
    entry.note === 'acpStdioAlwaysHttpDepends' &&
    runtime.mcpHttp !== null &&
    runtime.mcpHttp !== undefined
  ) {
    return runtime.mcpHttp
      ? SUPPORTED
      : { status: 'partial', gapReason: 'upstream', note: 'acpStdioOnlyNoHttp' }
  }

  return entry
}

/**
 * Resolves the fixed ordered capability checklist for any default or added agent.
 * When `runtime` holds observed capabilities from an initialized ACP agent, runtime-negotiated
 * entries (`steering`, `fork`, `imageInput`, `mcp`) are refined automatically.
 */
export function resolveHarnessCapabilities(
  id: AgentId,
  runtime?: RuntimeCapabilitiesSnapshot | null,
): ResolvedHarnessCapability[] {
  const map = harnessCapabilities(id)
  return HARNESS_CAPABILITY_IDS.map((capId) => {
    const base = map[capId]
    const resolved = runtime ? refineWithRuntime(capId, base, runtime) : base
    return { id: capId, ...resolved }
  })
}

/** Counts how many capabilities are supported, partial, and unavailable. */
export function summarizeHarnessCapabilities(
  items: readonly Pick<HarnessCapabilityEntry, 'status'>[],
): HarnessCapabilitySummary {
  let supported = 0
  let partial = 0
  let unavailable = 0
  for (const item of items) {
    if (item.status === 'supported') supported++
    else if (item.status === 'partial') partial++
    else unavailable++
  }
  return { supported, partial, unavailable, total: items.length }
}
