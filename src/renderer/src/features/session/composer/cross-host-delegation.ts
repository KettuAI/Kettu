// Pure helpers for manual cross-host task delegation (#2581):
// filters paired computers under the same Kettu account (excluding the origin host), computes
// composer `+` menu visibility/disabled state, selects available target agents, builds an
// explicit editable origin context preview, composes confirmed prompts, and constructs target
// session creation parameters that never carry over origin permissions.

import type { AccountStatus } from '@shared/account'
import type { AgentStatus, Project } from '@shared/agent-host'
import { buildTargetSessionCreateParams, promptPreviewOf } from '@shared/cross-host-delegation'
import type { Platform } from '@shared/platform'
import { foldedHost, type HostConnection, type HostsStatus } from '@shared/remote/hosts'
import { harnessOf, type AgentId, type HarnessId, type ThreadState } from '@shared/thread'
import { hostOfPath } from '@renderer/lib/host-paths'
import type { HostAgents } from '@renderer/stores/agents'
import { isProjectArchived } from '@renderer/stores/projects'
import { isDelegatableAgentStatus } from './delegation'

export { buildTargetSessionCreateParams, promptPreviewOf }

/** Connection availability of a paired computer under the same Kettu account. */
export type PairedHostAvailability =
  'online' | 'connecting' | 'offline' | 'update_client' | 'update_host'

/** A paired computer under the same Kettu account that may be chosen as a delegation target. */
export interface PairedHostTarget {
  /** Remote host id, or null when targeting the local computer from a remote origin session. */
  hostId: string | null
  name: string
  platform: Platform
  availability: PairedHostAvailability
  selectable: boolean
}

export interface PairedHostFilterInput {
  accountStatus: AccountStatus | null
  hostsStatus: HostsStatus | null
  /** Host where the origin session lives; null for this computer. Always excluded from targets. */
  originHostId: string | null
  isWebClient: boolean
  /** Fallback display name for this computer when `hostsStatus.self.name` is unavailable. */
  selfName: string
  selfPlatform: Platform
}

function availabilityOf(connection: HostConnection): PairedHostAvailability {
  switch (connection.state) {
    case 'online':
      return 'online'
    case 'connecting':
      return 'connecting'
    case 'stopped':
      if (connection.reason === 'update_client') return 'update_client'
      if (connection.reason === 'update_host') return 'update_host'
      return 'offline'
    default:
      return 'offline'
  }
}

/**
 * Returns paired computers signed into the same Kettu account as this computer, excluding the
 * host where the origin session already runs. Online targets sort first, then offline ones.
 */
export function pairedHostTargets(input: PairedHostFilterInput): PairedHostTarget[] {
  if (input.isWebClient) return []
  const currentAccountId =
    input.accountStatus?.state === 'signed-in' ? input.accountStatus.account.id : null
  if (currentAccountId === null) return []

  const targets: PairedHostTarget[] = []

  // When viewing a session on a paired remote computer, this computer itself is a valid online
  // target under the same signed-in Kettu account.
  if (input.originHostId !== null) {
    const selfName = input.hostsStatus?.self.name?.trim() || input.selfName
    const selfPlatform = input.hostsStatus?.self.platform ?? input.selfPlatform
    targets.push({
      hostId: null,
      name: selfName,
      platform: selfPlatform,
      availability: 'online',
      selectable: true,
    })
  }

  for (const host of input.hostsStatus?.hosts ?? []) {
    if (host.id === input.originHostId) continue
    if (host.removed) continue
    if (
      host.connection.state === 'stopped' &&
      (host.connection.reason === 'removed' || host.connection.reason === 'other_account')
    ) {
      continue
    }
    if (foldedHost(host, currentAccountId)) continue
    // Require verified same-account ownership so unpaired or non-account hosts are excluded.
    if (host.account !== currentAccountId) continue

    const availability = availabilityOf(host.connection)
    targets.push({
      hostId: host.id,
      name: host.name,
      platform: host.platform,
      availability,
      selectable: availability === 'online',
    })
  }

  return targets.sort((a, b) => {
    if (a.selectable !== b.selectable) return a.selectable ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export interface CrossHostMenuState {
  visible: boolean
  disabled: boolean
  reason?: 'all_offline'
}

/**
 * Determines whether the composer `+` menu shows "Delegate to another computer…" and whether it
 * is enabled. Hidden for single-computer / signed-out setups; disabled with an explanation when
 * paired same-account computers exist but none are currently online.
 */
export function crossHostMenuState({
  canDelegate,
  targets,
}: {
  canDelegate: boolean
  targets: readonly PairedHostTarget[]
}): CrossHostMenuState {
  if (!canDelegate || targets.length === 0) {
    return { visible: false, disabled: false }
  }
  if (targets.some((target) => target.selectable)) {
    return { visible: true, disabled: false }
  }
  return { visible: true, disabled: true, reason: 'all_offline' }
}

/** Active (non-archived) projects belonging to `targetHostId`. */
export function targetHostProjects(
  projects: readonly Project[],
  targetHostId: string | null,
): Project[] {
  return projects.filter(
    (project) => !isProjectArchived(project) && hostOfPath(project.path) === targetHostId,
  )
}

export type RemoteTargetAgentState = 'ready' | 'needs_sign_in' | 'installing' | 'failed'

export interface RemoteTargetAgent {
  id: AgentId
  name: string
  harnessId: HarnessId
  harnessName: string
  state: RemoteTargetAgentState
  selectable: boolean
}

function remoteAgentState(status: AgentStatus): RemoteTargetAgentState {
  if (
    status.state === 'installing' ||
    (status.task?.kind === 'install' && status.task.state === 'running')
  ) {
    return 'installing'
  }
  if (status.state === 'failed') return 'failed'
  if (status.signIn === 'required') return 'needs_sign_in'
  return 'ready'
}

/**
 * Lists installed, enabled, visible agents on a target computer in menu order, marking actively
 * installing or errored agents as non-selectable.
 */
export function selectDelegatableHostAgents(agents: HostAgents): RemoteTargetAgent[] {
  const result: RemoteTargetAgent[] = []
  for (const id of agents.order) {
    const status = agents.byId[id]
    if (!status || !isDelegatableAgentStatus(status)) continue
    const state = remoteAgentState(status)
    result.push({
      id: status.id,
      name: status.name,
      harnessId: status.harnessId,
      harnessName: status.harnessName,
      state,
      selectable: state === 'ready' || state === 'needs_sign_in',
    })
  }
  return result
}

/** Picks the default agent on the target computer, preferring the origin session's harness. */
export function defaultTargetAgentId(
  agents: readonly RemoteTargetAgent[],
  preferredAgentId?: AgentId,
): AgentId | null {
  const preferredHarness = preferredAgentId ? harnessOf(preferredAgentId) : null
  if (preferredAgentId) {
    const exactReady = agents.find(
      (agent) => agent.id === preferredAgentId && agent.state === 'ready',
    )
    if (exactReady) return exactReady.id
  }
  if (preferredHarness) {
    const sameHarnessReady = agents.find(
      (agent) => agent.harnessId === preferredHarness && agent.state === 'ready',
    )
    if (sameHarnessReady) return sameHarnessReady.id
  }
  const firstReady = agents.find((agent) => agent.state === 'ready')
  if (firstReady) return firstReady.id
  return agents.find((agent) => agent.selectable)?.id ?? null
}

const DEFAULT_CONTEXT_PREVIEW_CHARS = 3_000
const MAX_PREVIEW_MESSAGES = 8
const MAX_SINGLE_MESSAGE_CHARS = 600

function trimText(text: string, maxChars: number): string {
  const normalized = text.trim()
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`
}

/**
 * Builds a concise, human-readable context excerpt from the origin session's loaded thread for the
 * user to explicitly review and edit before opting in to share it with the target computer.
 * Never transmits anything automatically; only populates the editable context field when requested.
 */
export function buildOriginContextPreview(
  thread: ThreadState | null | undefined,
  options: {
    sessionTitle: string
    projectName: string | null
    maxChars?: number
  },
): string {
  const maxChars = options.maxChars ?? DEFAULT_CONTEXT_PREVIEW_CHARS
  const headerParts = [`Origin session: ${options.sessionTitle}`]
  if (options.projectName) headerParts.push(`Origin project: ${options.projectName}`)

  const snippets: string[] = []
  if (thread) {
    for (let i = thread.order.length - 1; i >= 0 && snippets.length < MAX_PREVIEW_MESSAGES; i--) {
      const entry = thread.byId[thread.order[i]!]
      if (!entry) continue
      if (entry.kind === 'user') {
        if (entry.approval || entry.from?.ended) continue
        const text = entry.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n')
          .trim()
        if (!text) continue
        snippets.push(`User: ${trimText(text, MAX_SINGLE_MESSAGE_CHARS)}`)
      } else if (entry.kind === 'agent') {
        const text = entry.markdown.trim()
        if (!text) continue
        snippets.push(`Assistant: ${trimText(text, MAX_SINGLE_MESSAGE_CHARS)}`)
      }
    }
  }
  snippets.reverse()

  const body =
    snippets.length > 0 ? [...headerParts, '', ...snippets].join('\n') : headerParts.join('\n')
  return trimText(body, maxChars)
}

/**
 * Composes the exact prompt text sent to the target computer from the user's confirmed task and
 * (only when explicitly enabled and non-empty) their reviewed/edited context.
 */
export function composeCrossHostPrompt(input: {
  task: string
  includeContext: boolean
  contextText: string
  originHostName: string
  originSessionTitle: string
}): string {
  const task = input.task.trim()
  if (!task) return ''
  const context = input.includeContext ? input.contextText.trim() : ''
  if (!context) return task
  return `${task}\n\n---\nShared context from ${input.originHostName} (${input.originSessionTitle}):\n${context}`
}
