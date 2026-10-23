import type { HostEvent } from '@shared/agent-host'
import {
  followShownSession,
  newSessionInPlace,
  removeEmptySessions,
  sessionRemoved,
  usePendingSession,
} from '@renderer/app/actions'
import { launchTarget } from '@renderer/app/restore'
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
import { receiveBatch, rewatchAll } from '@renderer/stores/threads'
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
      sessionRemoved(event.sessionId)
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

let launched = false

/**
 * Leaves the launch view for the session shown when the app last closed, as Settings › General
 * allows, else for New session; Welcome stays while there are no projects.
 */
function finishLaunch(): void {
  launched = true
  if (usePendingSession.getState().pending) return
  const target = launchTarget({
    enabled: useSettingsStore.getState().settings.general.restoreLastSession,
    sessionId: lastSessionId,
    main: useViewStore.getState().main,
    byId: useSessionsStore.getState().byId,
    hasProjects: useProjectsStore.getState().projects.length > 0,
  })
  if (target?.kind === 'session') openSession(target.summary.id, target.summary.projectPath)
  else if (target) newSessionInPlace()
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
    // A host that stopped before it recorded the removal runs it now; one that did does nothing.
    void removeEmptySessions()
    void loadHostState()
    rewatchAll()
    showFront(true)
    rewatchGit()
  })
  useViewStore.subscribe(() => showFront())
  followShownSession()
  // A project list that fills after launch, as after a failed first read, leaves the launch view.
  useProjectsStore.subscribe((state, previous) => {
    if (launched && state.projects !== previous.projects) finishLaunch()
  })

  const settingsReady = initSettings()
  void initUpdates()
  initTerminals()
  // Asked first, so the host reads the threads before the ones the launch opens.
  void removeEmptySessions()
  const sessionState = loadSessionState()
  void loadGitTools()
  // Leaving the launch view waits for the session list, not for git tools, whose
  // `gh auth status` can take seconds on a slow network.
  void Promise.allSettled([settingsReady, sessionState]).then(finishLaunch)

  window.addEventListener('focus', refreshShownProject)
  return Promise.allSettled([settingsReady])
}
