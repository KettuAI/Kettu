import type { HostEvent } from '@shared/agent-host'
import {
  followShownSession,
  removeEmptySessions,
  sessionRemoved,
  takeReturnedMessages,
  usePendingSession,
} from '@renderer/app/actions'
import { launchTarget } from '@renderer/app/restore'
import { restoreDraftAttachments } from '@renderer/features/session/composer/attachments'
import { host } from '@renderer/lib/host'
import { whenHostHas } from '@renderer/lib/host-features'
import { isWeb, platform } from '@renderer/lib/platform'
import { initAccount } from '@renderer/stores/account'
import { loadAgentOptions, receiveAgentOptions } from '@renderer/stores/agent-options'
import { initBrowser } from '@renderer/stores/browser'
import {
  hostRestarted,
  preparedRemoved,
  receivePrepared,
} from '@renderer/features/session/new-session/prepared'
import { useAgentsStore } from '@renderer/stores/agents'
import { artifactsChanged } from '@renderer/stores/artifacts'
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
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { initSettings, useSettingsStore } from '@renderer/stores/settings'
import { initHosts } from '@renderer/stores/hosts'
import { initRemote } from '@renderer/stores/remote'
import { initSharing } from '@renderer/stores/sharing'
import { initTerminals } from '@renderer/stores/terminals'
import { initThemes } from '@renderer/stores/themes'
import { keepWatched, receiveBatch, rewatchAll } from '@renderer/stores/threads'
import { initUpdates } from '@renderer/stores/updates'
import {
  loadToday,
  loadUsageStatus,
  receiveUsageStatus,
  usageChanged,
} from '@renderer/stores/usage'
import {
  lastSessionId,
  layoutSessions,
  openSession,
  resetLayout,
  restoreLayout,
  savedLayout,
  shownLayoutSessions,
  useViewStore,
} from '@renderer/stores/view'
import { installPerfCounters } from './perf'

function onHostEvent(event: HostEvent): void {
  switch (event.type) {
    case 'session.patches':
      receiveBatch(event.batch)
      break
    case 'session.summary':
      // A prepared session is New session's alone until its first message.
      if (event.summary.prepared) receivePrepared(event.summary)
      else useSessionsStore.getState().upsert(event.summary)
      break
    case 'session.removed':
      if (!preparedRemoved(event.sessionId)) sessionRemoved(event.sessionId)
      break
    case 'session.returned':
      void takeReturnedMessages(event.sessionId)
      break
    case 'agent.status':
      useAgentsStore.getState().setOne(event.status)
      break
    case 'agent.removed':
      useAgentsStore.getState().remove(event.agentId)
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
    case 'artifacts.changed':
      artifactsChanged()
      break
    case 'routine.changed':
      useRoutinesStore.getState().receive(event.routine)
      break
    case 'routine.removed':
      useRoutinesStore.getState().removed(event.routineId)
      break
    case 'routine.run':
      useRoutinesStore.getState().receiveRun(event.run)
      break
  }
}

/** What the shell needs before it can show a session. */
function loadSessionState(): Promise<unknown> {
  return Promise.allSettled([
    useProjectsStore.getState().refresh(),
    useSessionsStore.getState().refresh(),
    useRoutinesStore.getState().load(),
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
 * allows, else for New session.
 */
function finishLaunch(): void {
  launched = true
  if (usePendingSession.getState().pending) return
  const target = launchTarget({
    enabled: useSettingsStore.getState().settings.general.restoreLastSession,
    layout: savedLayout,
    lastSessionId,
    main: useViewStore.getState().main,
    byId: useSessionsStore.getState().byId,
  })
  if (target?.kind === 'layout') restoreLayout(target.layout)
  else if (target?.kind === 'session') {
    resetLayout(target.summary.projectPath, null)
    openSession(target.summary.id, target.summary.projectPath)
  } else if (target) {
    // New session alone, with the default agent, in the selected project.
    resetLayout(
      useViewStore.getState().projectPath,
      useSettingsStore.getState().settings.general.defaultAgent,
    )
  }
}

let shownSessions = ''

/**
 * Tells the host the sessions the panes in view show; a turn that ends anywhere else leaves it
 * unread. Every session of the split stays watched, folded panes included.
 */
function showFront(again = false): void {
  const state = useViewStore.getState()
  const sessionIds = shownLayoutSessions(state)
  keepWatched(layoutSessions(state.layout))
  const key = sessionIds.join('\n')
  if (key === shownSessions && !again) return
  shownSessions = key
  void host('sessions.show', { sessionIds }).catch(() => {})
}

let wasDisconnected = false

/**
 * Starts loading what the shell shows; resolves once the settings and the themes are in, or
 * failed to load.
 */
export function bootstrap(): Promise<unknown> {
  // Platform styles, such as the Windows scrollbars, key off these.
  document.documentElement.dataset.platform = platform
  document.documentElement.dataset.client = window.kettu.client
  installPerfCounters()
  const agents = window.kettu.agents
  agents.onEvent(onHostEvent)
  agents.onConnection((state) => {
    useConnectionStore.setState({ agentHost: state })
    // The host keeps the session through the drop: nothing is read again.
    if (state === 'resuming') return
    if (state !== 'connected') {
      wasDisconnected = true
      return
    }
    if (!wasDisconnected) return
    wasDisconnected = false
    // A host that stopped before it recorded the removal runs it now; one that did does nothing.
    void removeEmptySessions()
    void loadHostState()
    artifactsChanged()
    hostRestarted()
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
  const themesReady = initThemes()
  void initRemote()
  // A host without them, as the daemon, is never asked.
  whenHostHas('sharing', () => void initSharing())
  whenHostHas('updates', () => {
    initUpdates().catch((error: unknown) => console.error('Could not read the updates', error))
  })
  // What the desktop app's main does for its windows; the web client has none of it.
  if (!isWeb) {
    initHosts()
    initBrowser()
    void initAccount()
  }
  initTerminals()
  // Before any composer shows, so each finds its draft's attachments.
  void restoreDraftAttachments()
  void takeReturnedMessages()
  // Asked first, so the host reads the threads before the ones the launch opens.
  void removeEmptySessions()
  const sessionState = loadSessionState()
  void loadGitTools()
  // Leaving the launch view waits for the session list, not for git tools, whose
  // `gh auth status` can take seconds on a slow network.
  void Promise.allSettled([settingsReady, sessionState]).then(finishLaunch)

  window.addEventListener('focus', refreshShownProject)
  return Promise.allSettled([settingsReady, themesReady])
}
