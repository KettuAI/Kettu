import type { HostEvent } from '@shared/agent-host'
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
import { initSettings } from '@renderer/stores/settings'
import { initTerminals } from '@renderer/stores/terminals'
import { forgetSession, receiveBatch, rewatchAll } from '@renderer/stores/threads'
import { initUpdates } from '@renderer/stores/updates'

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
  }
}

/** Loads everything the shell shows; also runs after the agent host comes back. */
async function loadHostState(): Promise<void> {
  await Promise.allSettled([
    useProjectsStore.getState().refresh(),
    useSessionsStore.getState().refresh(),
    useAgentsStore.getState().refresh(),
    loadGitTools(),
  ])
}

let wasDisconnected = false

export function bootstrap(): void {
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
    rewatchGit()
  })

  void initSettings()
  void initUpdates()
  initTerminals()
  void loadHostState()

  // The ambient field pauses while the window is in the background.
  const setActive = () => {
    document.documentElement.dataset.windowActive = String(
      document.visibilityState === 'visible' && document.hasFocus(),
    )
  }
  setActive()
  window.addEventListener('focus', () => {
    setActive()
    refreshShownProject()
  })
  window.addEventListener('blur', setActive)
  document.addEventListener('visibilitychange', setActive)
}
