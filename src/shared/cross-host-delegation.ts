// Shared pure state machine and payload builders for manual cross-host task delegation (#2581):
// constructs target `sessions.create` requests that never carry over origin permissions,
// tracks delegated remote sessions across status updates, deletions, and reconnects, extracts
// concise reply excerpts or error details from remote snapshots, and delivers completion or
// failure reports back to the origin session.

import type {
  HostMethod,
  HostParams,
  HostResult,
  RemoteDelegationRecordParams,
  SessionSummary,
} from './agent-host'
import type {
  AgentId,
  RemoteDelegationOutcome,
  SessionSnapshot,
  SessionStatus,
  UserContent,
} from './thread'

const MAX_PROMPT_PREVIEW_CHARS = 200
const MAX_SUMMARY_CHARS = 320
const MAX_ERROR_CHARS = 320

function clampLine(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, ' ').trim()
  if (cleaned.length <= maxChars) return cleaned
  return `${cleaned.slice(0, maxChars - 1).trimEnd()}…`
}

/** One-line task preview stored in the origin session's delegation notice. */
export function promptPreviewOf(task: string): string {
  return clampLine(task, MAX_PROMPT_PREVIEW_CHARS)
}

/**
 * Constructs `sessions.create` parameters for the target computer.
 *
 * Security boundary (#2581 / #2727):
 * - Always creates a normal top-level visible session (`parentId` omitted).
 * - NEVER passes `options` or any permission mode from the origin session, so the target session
 *   always starts with the target computer's own permission settings for `agentId`.
 */
export function buildTargetSessionCreateParams(input: {
  agentId: AgentId
  /** Target project path (qualified for `hostAt` or unqualified on local host), or null for No project. */
  projectPath: string | null
  promptText: string
}): HostParams<'sessions.create'> {
  const text = input.promptText.trim()
  const prompt: UserContent[] = [{ type: 'text', text }]
  return {
    agentId: input.agentId,
    projectPath: input.projectPath,
    prompt,
  }
}

/** Active delegated remote session tracked until its first delegated run settles. */
export interface ActiveCrossHostDelegation {
  delegationId: string
  originSessionId: string
  originHostId: string | null
  targetSessionId: string
  targetHostId: string | null
  targetHostName: string
  targetHostPlatform?: string
  /** Unqualified path on the target computer, or null when No project was selected. */
  targetProjectPath: string | null
  targetProjectName: string | null
  targetAgentId: AgentId
  targetAgentName: string
  targetTitle: string
  startedAt: number
  /** True once the target session was observed in an active state (`starting`/`running`/`awaiting_permission`). */
  sawActive: boolean
}

export interface ExecuteCrossHostDelegationInput {
  originSessionId: string
  originHostId: string | null
  targetHostId: string | null
  targetHostName: string
  targetHostPlatform?: string
  /** Qualified project path for `hostAt` (or null for No project). */
  targetProjectPath: string | null
  targetProjectName: string | null
  targetAgentId: AgentId
  targetAgentName: string
  /** Confirmed task text (used for preview/title fallback). */
  taskText: string
  /** Final confirmed prompt sent to the target computer (task + optional reviewed context). */
  promptText: string
}

export interface CrossHostDelegationOutcomeDetail {
  outcome: RemoteDelegationOutcome
  summary?: string
  error?: string
  title?: string
}

export interface CrossHostDelegationMessages {
  emptyTask: string
  untitledSession: string
  authRequired: (agent: string) => string
  failedGeneric: string
  sessionRemoved: string
  hostDisconnected: (host: string) => string
}

export const DEFAULT_CROSS_HOST_MESSAGES: CrossHostDelegationMessages = {
  emptyTask: 'Write a task before delegating',
  untitledSession: 'New session',
  authRequired: (agent) => `${agent} on the target computer requires sign-in`,
  failedGeneric: 'The delegated session failed on the target computer',
  sessionRemoved: 'The delegated session was removed before it finished',
  hostDisconnected: (host) => `Lost pairing with ${host} before the delegated session finished`,
}

export interface CrossHostDelegationDeps {
  requestAt: <M extends HostMethod>(
    hostId: string | null,
    method: M,
    params: HostParams<M>,
  ) => Promise<HostResult<M>>
  getSessionSummary: (sessionId: string) => SessionSummary | undefined
  upsertSession: (summary: SessionSummary) => void
  learnSessionHost: (hostId: string, sessionId: string) => void
  /** Strips any window-side host qualification prefix to store the target host's raw path. */
  unqualifyPath?: (projectPath: string) => string
  readStored: () => ActiveCrossHostDelegation[]
  writeStored: (items: ActiveCrossHostDelegation[]) => void
  newId: () => string
  now: () => number
  messages?: CrossHostDelegationMessages
  onWarn?: (message: string, error?: unknown) => void
}

function isActiveStatus(status: SessionStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'awaiting_permission'
}

/** Extracts the final outcome, reply excerpt, or error detail from a remote session snapshot. */
export function extractSnapshotOutcome(
  snapshot: SessionSnapshot,
  fallbackOutcome: RemoteDelegationOutcome,
  messages: CrossHostDelegationMessages = DEFAULT_CROSS_HOST_MESSAGES,
): CrossHostDelegationOutcomeDetail {
  const { session, entries } = snapshot
  const title = session.title?.trim() || undefined

  if (session.status === 'auth_required') {
    return {
      outcome: 'failed',
      error: session.error?.message
        ? clampLine(session.error.message, MAX_ERROR_CHARS)
        : messages.authRequired(session.agentId),
      ...(title ? { title } : {}),
    }
  }
  if (session.status === 'failed' || session.error) {
    return {
      outcome: 'failed',
      error: session.error?.message
        ? clampLine(session.error.message, MAX_ERROR_CHARS)
        : messages.failedGeneric,
      ...(title ? { title } : {}),
    }
  }

  let outcome: RemoteDelegationOutcome = fallbackOutcome
  let error: string | undefined
  let summary: string | undefined

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!
    if (!summary && entry.kind === 'agent' && entry.markdown.trim()) {
      summary = clampLine(entry.markdown, MAX_SUMMARY_CHARS)
    }
    if (
      !error &&
      entry.kind === 'notice' &&
      (entry.severity === 'error' || entry.cause === 'turn_failed')
    ) {
      const detail = entry.description ? `${entry.title}: ${entry.description}` : entry.title
      error = clampLine(detail, MAX_ERROR_CHARS)
      outcome = 'failed'
    }
    if (entry.kind === 'turn_end') {
      if (entry.stopReason === 'end_turn') {
        if (!error) outcome = 'completed'
      } else if (entry.stopReason === 'cancelled') {
        outcome = 'stopped'
      } else {
        outcome = 'failed'
        error ??= entry.stopReason
      }
      if (summary || error) break
    }
  }

  return {
    outcome,
    ...(summary ? { summary } : {}),
    ...(error ? { error } : {}),
    ...(title ? { title } : {}),
  }
}

/**
 * Evaluates a `SessionSummary` update for an active cross-host delegation.
 * Returns a preliminary outcome when the remote turn has settled, or `null` while still running.
 */
export function classifySummaryTransition(
  item: ActiveCrossHostDelegation,
  summary: SessionSummary,
  messages: CrossHostDelegationMessages = DEFAULT_CROSS_HOST_MESSAGES,
): { outcome: RemoteDelegationOutcome; error?: string } | null {
  if (summary.status === 'failed' || summary.attention === 'error') {
    return { outcome: 'failed' }
  }
  if (summary.status === 'auth_required') {
    return {
      outcome: 'failed',
      error: messages.authRequired(item.targetAgentName),
    }
  }
  if (isActiveStatus(summary.status)) {
    return null
  }
  if (summary.status === 'ready' || summary.status === 'closed') {
    const lastTurn = summary.lastTurn ?? null
    if (lastTurn !== null) {
      if (lastTurn.reason === 'end_turn') return { outcome: 'completed' }
      if (lastTurn.reason === 'cancelled') return { outcome: 'stopped' }
      return {
        outcome: 'failed',
        error: lastTurn.error ? clampLine(lastTurn.error, MAX_ERROR_CHARS) : lastTurn.reason,
      }
    }
    // Older remote hosts may omit `lastTurn`; settle once we saw the session transition out of active.
    if (item.sawActive) return { outcome: 'completed' }
  }
  return null
}

/** Parses stored active cross-host delegation records safely from JSON storage. */
export function parseStoredDelegations(raw: unknown): ActiveCrossHostDelegation[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((value): ActiveCrossHostDelegation[] => {
    if (typeof value !== 'object' || value === null) return []
    const v = value as Record<string, unknown>
    if (
      typeof v.delegationId !== 'string' ||
      typeof v.originSessionId !== 'string' ||
      (v.originHostId !== null && typeof v.originHostId !== 'string') ||
      typeof v.targetSessionId !== 'string' ||
      (v.targetHostId !== null && typeof v.targetHostId !== 'string') ||
      typeof v.targetHostName !== 'string' ||
      (v.targetProjectPath !== null && typeof v.targetProjectPath !== 'string') ||
      (v.targetProjectName !== null && typeof v.targetProjectName !== 'string') ||
      typeof v.targetAgentId !== 'string' ||
      typeof v.targetAgentName !== 'string' ||
      typeof v.targetTitle !== 'string' ||
      typeof v.startedAt !== 'number'
    ) {
      return []
    }
    return [
      {
        delegationId: v.delegationId,
        originSessionId: v.originSessionId,
        originHostId: v.originHostId,
        targetSessionId: v.targetSessionId,
        targetHostId: v.targetHostId,
        targetHostName: v.targetHostName,
        ...(typeof v.targetHostPlatform === 'string'
          ? { targetHostPlatform: v.targetHostPlatform }
          : {}),
        targetProjectPath: v.targetProjectPath,
        targetProjectName: v.targetProjectName,
        targetAgentId: v.targetAgentId as AgentId,
        targetAgentName: v.targetAgentName,
        targetTitle: v.targetTitle,
        startedAt: v.startedAt,
        sawActive: v.sawActive === true,
      },
    ]
  })
}

export interface CrossHostDelegationTracker {
  /** Executes manual cross-host delegation, records the origin notice, and begins tracking. */
  delegate(input: ExecuteCrossHostDelegationInput): Promise<{
    delegationId: string
    summary: SessionSummary
  }>
  /** Processes a session summary update from any host. */
  onSessionSummary(summary: SessionSummary): Promise<void>
  /** Processes a session deletion event from any host. */
  onSessionRemoved(sessionId: string): Promise<void>
  /** Reconciles tracked delegations targeting `hostId` after its connection opens and lists sync. */
  onHostOpened(hostId: string): Promise<void>
  /** Fails tracked delegations targeting a host whose pairing was removed. */
  onHostGone(hostId: string): Promise<void>
  /** Hydrates persisted active delegations from storage (safe to call once at bootstrap). */
  hydrate(): void
  /** Snapshot of currently tracked active delegations (for tests/diagnostics). */
  active(): ActiveCrossHostDelegation[]
}

/** Creates an isolated cross-host delegation tracker with injectable host/store dependencies. */
export function createCrossHostDelegationTracker(
  deps: CrossHostDelegationDeps,
): CrossHostDelegationTracker {
  const messages = deps.messages ?? DEFAULT_CROSS_HOST_MESSAGES
  const unqualifyPath = deps.unqualifyPath ?? ((p: string) => p)
  const activeByTarget = new Map<string, ActiveCrossHostDelegation>()
  const settling = new Set<string>()
  let hydrated = false

  const persist = () => {
    deps.writeStored([...activeByTarget.values()])
  }

  const recordInOrigin = async (
    originHostId: string | null,
    params: RemoteDelegationRecordParams,
  ): Promise<void> => {
    try {
      await deps.requestAt(originHostId, 'sessions.recordRemoteDelegation', params)
    } catch (error) {
      deps.onWarn?.(
        `Could not record cross-host delegation ${params.phase} in session ${params.sessionId}`,
        error,
      )
    }
  }

  const settle = async (
    item: ActiveCrossHostDelegation,
    initial: CrossHostDelegationOutcomeDetail,
    fetchSnapshot: boolean,
  ): Promise<void> => {
    if (settling.has(item.delegationId)) return
    settling.add(item.delegationId)
    try {
      let detail: CrossHostDelegationOutcomeDetail = { ...initial }
      if (fetchSnapshot) {
        try {
          const snapshot = await deps.requestAt(item.targetHostId, 'sessions.snapshot', {
            sessionId: item.targetSessionId,
          })
          const extracted = extractSnapshotOutcome(snapshot, initial.outcome, messages)
          detail = {
            outcome: extracted.outcome,
            summary: extracted.summary ?? initial.summary,
            error: extracted.error ?? initial.error,
            title: extracted.title ?? initial.title,
          }
        } catch {
          // Best-effort excerpt only: never block or drop the report when snapshot read fails.
        }
      }

      const finalTitle = detail.title?.trim() || item.targetTitle
      await recordInOrigin(item.originHostId, {
        sessionId: item.originSessionId,
        delegationId: item.delegationId,
        phase: 'report',
        targetHostId: item.targetHostId,
        targetHostName: item.targetHostName,
        ...(item.targetHostPlatform ? { targetHostPlatform: item.targetHostPlatform } : {}),
        targetSessionId: item.targetSessionId,
        targetProjectPath: item.targetProjectPath,
        targetProjectName: item.targetProjectName,
        targetAgentId: item.targetAgentId,
        targetAgentName: item.targetAgentName,
        targetTitle: finalTitle,
        outcome: detail.outcome,
        ...(detail.summary ? { summary: detail.summary } : {}),
        ...(detail.error ? { error: detail.error } : {}),
        at: deps.now(),
      })

      activeByTarget.delete(item.targetSessionId)
      persist()
    } finally {
      settling.delete(item.delegationId)
    }
  }

  const checkSummary = async (summary: SessionSummary): Promise<void> => {
    const item = activeByTarget.get(summary.id)
    if (!item || settling.has(item.delegationId)) return

    let changed = false
    const latestTitle = summary.title?.trim()
    if (latestTitle && latestTitle !== item.targetTitle) {
      item.targetTitle = latestTitle
      changed = true
    }
    if (isActiveStatus(summary.status) && !item.sawActive) {
      item.sawActive = true
      changed = true
    }
    if (changed) persist()

    const transition = classifySummaryTransition(item, summary, messages)
    if (!transition) return

    await settle(
      item,
      {
        outcome: transition.outcome,
        ...(transition.error ? { error: transition.error } : {}),
        ...(latestTitle ? { title: latestTitle } : {}),
      },
      true,
    )
  }

  return {
    hydrate() {
      if (hydrated) return
      hydrated = true
      for (const item of deps.readStored()) {
        activeByTarget.set(item.targetSessionId, item)
      }
    },

    active() {
      return [...activeByTarget.values()]
    },

    async delegate(input) {
      const promptText = input.promptText.trim()
      if (!promptText) {
        throw new Error(messages.emptyTask)
      }

      // Security boundary: create a normal visible top-level session on the target host without
      // passing any origin permission mode or options, so the target computer's own defaults apply.
      const createParams = buildTargetSessionCreateParams({
        agentId: input.targetAgentId,
        projectPath: input.targetProjectPath,
        promptText,
      })
      const created = await deps.requestAt(input.targetHostId, 'sessions.create', createParams)
      if (input.targetHostId !== null) {
        deps.learnSessionHost(input.targetHostId, created.id)
      }
      deps.upsertSession(created)

      const delegationId = deps.newId()
      const startedAt = deps.now()
      const targetTitle = created.title?.trim() || messages.untitledSession
      const unqualifiedProjectPath =
        input.targetProjectPath === null ? null : unqualifyPath(created.projectPath)
      const promptPreview = promptPreviewOf(input.taskText)

      const tracked: ActiveCrossHostDelegation = {
        delegationId,
        originSessionId: input.originSessionId,
        originHostId: input.originHostId,
        targetSessionId: created.id,
        targetHostId: input.targetHostId,
        targetHostName: input.targetHostName,
        ...(input.targetHostPlatform ? { targetHostPlatform: input.targetHostPlatform } : {}),
        targetProjectPath: unqualifiedProjectPath,
        targetProjectName: input.targetProjectName,
        targetAgentId: input.targetAgentId,
        targetAgentName: input.targetAgentName,
        targetTitle,
        startedAt,
        sawActive: isActiveStatus(created.status),
      }

      activeByTarget.set(created.id, tracked)
      persist()

      await recordInOrigin(input.originHostId, {
        sessionId: input.originSessionId,
        delegationId,
        phase: 'started',
        targetHostId: input.targetHostId,
        targetHostName: input.targetHostName,
        ...(input.targetHostPlatform ? { targetHostPlatform: input.targetHostPlatform } : {}),
        targetSessionId: created.id,
        targetProjectPath: unqualifiedProjectPath,
        targetProjectName: input.targetProjectName,
        targetAgentId: input.targetAgentId,
        targetAgentName: input.targetAgentName,
        targetTitle,
        ...(promptPreview ? { promptPreview } : {}),
        at: startedAt,
      })

      // Handle immediate settlement (e.g. instant auth_required, failure, or fast test completion).
      void checkSummary(created)

      return { delegationId, summary: created }
    },

    async onSessionSummary(summary) {
      await checkSummary(summary)
    },

    async onSessionRemoved(sessionId) {
      const item = activeByTarget.get(sessionId)
      if (!item) return
      await settle(
        item,
        {
          outcome: 'failed',
          error: messages.sessionRemoved,
        },
        false,
      )
    },

    async onHostOpened(hostId) {
      const matching = [...activeByTarget.values()].filter((item) => item.targetHostId === hostId)
      for (const item of matching) {
        const current = deps.getSessionSummary(item.targetSessionId)
        if (current) {
          await checkSummary(current)
        } else {
          await settle(
            item,
            {
              outcome: 'failed',
              error: messages.sessionRemoved,
            },
            false,
          )
        }
      }
    },

    async onHostGone(hostId) {
      const matching = [...activeByTarget.values()].filter((item) => item.targetHostId === hostId)
      for (const item of matching) {
        await settle(
          item,
          {
            outcome: 'failed',
            error: messages.hostDisconnected(item.targetHostName),
          },
          false,
        )
      }
    },
  }
}
