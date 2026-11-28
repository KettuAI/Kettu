// Renderer wiring for manual cross-host task delegation (#2581):
// binds the shared tracker state machine to the renderer's `hostAt`, session store, localStorage,
// i18n messages, and one-click navigation into remote sessions.

import type { SessionSummary } from '@shared/agent-host'
import {
  createCrossHostDelegationTracker,
  parseStoredDelegations,
  type ActiveCrossHostDelegation,
  type CrossHostDelegationOutcomeDetail,
  type ExecuteCrossHostDelegationInput,
} from '@shared/cross-host-delegation'
import { hostAt, learnSessionHosts } from '@renderer/lib/host'
import { hostPath, onHost } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { readJson, writeJson } from '@renderer/lib/storage'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'

export type {
  ActiveCrossHostDelegation,
  CrossHostDelegationOutcomeDetail,
  ExecuteCrossHostDelegationInput,
}

const ACTIVE_STORAGE_KEY = 'kettu.crossHostDelegations.active'

const defaultTracker = createCrossHostDelegationTracker({
  requestAt: (hostId, method, params) => hostAt(hostId, method, params),
  getSessionSummary: (sessionId) => useSessionsStore.getState().byId[sessionId],
  upsertSession: (summary) => useSessionsStore.getState().upsert(summary),
  learnSessionHost: (hostId, sessionId) => learnSessionHosts(hostId, [sessionId]),
  unqualifyPath: (projectPath) => hostPath(projectPath),
  readStored: () => parseStoredDelegations(readJson<unknown>(ACTIVE_STORAGE_KEY, [])),
  writeStored: (items) => writeJson(ACTIVE_STORAGE_KEY, items),
  newId: () =>
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `rdel-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  now: () => Date.now(),
  messages: {
    get emptyTask() {
      return i18n.t('composer:crossHostDelegation.emptyTask')
    },
    get untitledSession() {
      return i18n.t('app:newSession')
    },
    authRequired: (agent) => i18n.t('session:remoteDelegation.authRequired', { agent }),
    get failedGeneric() {
      return i18n.t('session:remoteDelegation.failedGeneric')
    },
    get sessionRemoved() {
      return i18n.t('session:remoteDelegation.sessionRemoved')
    },
    hostDisconnected: (host) => i18n.t('session:remoteDelegation.hostDisconnected', { host }),
  },
  onWarn: (message, error) => console.warn(message, error),
})

let initialized = false

/** Initializes the singleton cross-host delegation tracker once at renderer bootstrap. */
export function initCrossHostDelegationTracker(): void {
  if (initialized) return
  initialized = true
  defaultTracker.hydrate()
  useSessionsStore.subscribe((state, previous) => {
    if (state.byId === previous.byId) return
    for (const item of defaultTracker.active()) {
      const next = state.byId[item.targetSessionId]
      const prev = previous.byId[item.targetSessionId]
      if (next && next !== prev) {
        void defaultTracker.onSessionSummary(next)
      }
    }
  })
}

export function executeCrossHostDelegation(
  input: ExecuteCrossHostDelegationInput,
): Promise<{ delegationId: string; summary: SessionSummary }> {
  return defaultTracker.delegate(input)
}

export function handleCrossHostSessionRemoved(sessionId: string): void {
  void defaultTracker.onSessionRemoved(sessionId)
}

export function handleCrossHostOpened(hostId: string): void {
  void defaultTracker.onHostOpened(hostId)
}

export function handleCrossHostGone(hostId: string): void {
  void defaultTracker.onHostGone(hostId)
}

/**
 * Opens a remote delegated session in one click, using the live summary's qualified path when
 * available or reconstructing the qualified host path from the persisted record.
 */
export function openRemoteDelegatedSession(target: {
  targetHostId: string | null
  targetSessionId: string
  targetProjectPath: string | null
}): boolean {
  const existing = useSessionsStore.getState().byId[target.targetSessionId]
  if (existing) {
    openSession(existing.id, existing.projectPath)
    return true
  }
  if (target.targetProjectPath === null) return false
  if (target.targetHostId !== null) {
    learnSessionHosts(target.targetHostId, [target.targetSessionId])
  }
  openSession(target.targetSessionId, onHost(target.targetHostId, target.targetProjectPath))
  return true
}
