import type { HostEvent } from '@shared/agent-host'
import { usePendingSession } from '@renderer/app/actions'
import { sessionToRestore } from '@renderer/app/restore'
import { host } from '@renderer/lib/host'
import { platform } from '@renderer/lib/platform'
import { loadAgentOptions, receiveAgentOptions } from '@renderer/stores/agent-options'
import { useAgentsStore } from '@renderer/stores/agents'
import { useConnectionStore } from '@renderer/stores/connection'
import {
  loadGitTools,
  receiveCurrentPr,
  receiveGitStatus,
  refreshShownProject,
  rewatchGit,
  useGitStore,
} from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { initSettings, useSettingsStore } from '@renderer/stores/settings'
import { initTerminals } from '@renderer/stores/terminals'
import { forgetSession, receiveBatch, rewatchAll } from '@renderer/stores/threads'
import { initUpdates } from '@renderer/stores/updates'
import {
  loadToday,
  loadUsageStatus,
  receiveUsageStatus,
  usageChanged,
} from '@renderer/stores/usage'
import { lastSessionId, openSession, useViewStore } from '@renderer/stores/view'
import { installPerfCounters } from './perf'

function onHostEvent(event: HostEvent): void {
  switch (event.type) {
    case 'session.patches':
      receiveBatch(event.batch)
      break
    case 'session.summary':
      useSessionsStore.getState().upsert(event.summary)
      break
    case 'session.removed':
      useSessionsStore.getState().remove(event.sessionId)
      forgetSession(event.sessionId)
      break
    case 'agent.status':
      useAgentsStore.getState().setOne(event.status)
      break
    case 'agent.options':
      receiveAgentOptions(event.options)
      break
    case 'projects.changed':
      useProjectsStore.getState().setAll(event.projects)
      break
    case 'environment.changed':
      useAgentsStore.setState({ environment: event.info })
      break
    case 'git.changed':
      receiveGitStatus(event.status)
      break
    case 'git.pr':
      receiveCurrentPr(event.projectPath, event.pr)
      break
    case 'git.tools':
      useGitStore.setState({ tools: event.tools })
      break
    case 'usage.changed':
      usageChanged()
      break
    case 'usage.status':
      receiveUsageStatus(event.status)
      break
  }
}

/** What the shell needs before it can show a session. */
function loadSessionState(): Promise<unknown> {
  return Promise.allSettled([
    useProjectsStore.getState().refresh(),
    useSessionsStore.getState().refresh(),
    useAgentsStore.getState().refresh(),
    loadAgentOptions(),
  ])
}

/** Loads everything the shell shows; also runs after the agent host comes back. */
export async function loadHostState(): Promise<void> {
  await Promise.allSettled([loadSessionState(), loadGitTools(), loadUsageStatus(), loadToday()])
}

/** Reopens the session shown when the app last closed, as Settings › General allows. */
function restoreLastSession(): void {
  if (usePendingSession.getState().pending) return
  const summary = sessionToRestore({
    enabled: useSettingsStore.getState().settings.general.restoreLastSession,
    sessionId: lastSessionId,
    main: useViewStore.getState().main,
    byId: useSessionsStore.getState().byId,
  })
  if (summary) openSession(summary.id, summary.projectPath)
}

let shownSession: string | null = null

/** Tells the host which session is in front; a turn that ends anywhere else leaves it unread. */
function showFront(again = false): void {
  const { main, settings } = useViewStore.getState()
  const sessionId = main.kind === 'session' && !settings.open ? main.sessionId : null
  if (sessionId === shownSession && !again) return
  shownSession = sessionId
  void host('sessions.show', { sessionId }).catch(() => {})
}

let wasDisconnected = false

/** Starts loading what the shell shows; resolves once the settings are in, or failed to load. */
export function bootstrap(): Promise<unknown> {
  // Platform styles, such as the Windows scrollbars, key off this.
  document.documentElement.dataset.platform = platform
  installPerfCounters()
  const agents = window.overbench.agents
  agents.onEvent(onHostEvent)
  agents.onConnection((state) => {
    useConnectionStore.setState({ agentHost: state })
    if (state !== 'connected') {
      wasDisconnected = true
      return
    }
    if (!wasDisconnected) return
    wasDisconnected = false
    void loadHostState()
    rewatchAll()
    showFront(true)
    rewatchGit()
  })
  useViewStore.subscribe(() => showFront())

  const settingsReady = initSettings()
  void initUpdates()
  initTerminals()
  const sessionState = loadSessionState()
  void loadGitTools()
  // Restoring waits for the session list, not for git tools, whose `gh auth status` can take
  // seconds on a slow network.
  void Promise.allSettled([settingsReady, sessionState]).then(restoreLastSession)

  window.addEventListener('focus', refreshShownProject)
  return Promise.allSettled([settingsReady])
}
