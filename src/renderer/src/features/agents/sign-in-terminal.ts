import type { AgentStatus } from '@shared/agent-host'
import { newSession } from '@renderer/app/actions'
import { toast } from '@renderer/components/ui/toast'
import { signInFolder } from '@renderer/features/settings/agent-helpers'
import { focusedPane } from '@renderer/features/split/layout'
import { hostOfPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { createTerminal } from '@renderer/stores/terminals'
import {
  closeSettings,
  newSessionPanel,
  paneProjectPath,
  panelOf,
  sessionsShown,
  toggleTerminal,
  useViewStore,
} from '@renderer/stores/view'

/**
 * Runs the agent's terminal sign-in in the built-in terminal of the side panel in view, when it
 * works in a folder of this computer, else of New session in one; copies the command without one.
 */
export function signInTerminal(status: AgentStatus, command: string): void {
  const view = useViewStore.getState()
  const projects = useProjectsStore.getState().projects
  const focused = focusedPane(view.layout).view
  const focusedPath = paneProjectPath(focused, view.projectPath, projects)
  const here =
    sessionsShown(view.main) && focusedPath && hostOfPath(focusedPath) === null
      ? { projectPath: focusedPath, panel: panelOf(focused, view.projectPath, projects) }
      : null
  const projectPath =
    here?.projectPath ??
    signInFolder({
      selected: view.projectPath,
      projects: useProjectsStore.getState().projects,
      sessions: useSessionsStore.getState().byId,
    })
  if (!projectPath) {
    void navigator.clipboard.writeText(command).then(
      () => toast(i18n.t('settings:agents.signInCopied')),
      () => toast(i18n.t('settings:agents.signInCopyFailed'), undefined, { tone: 'warning' }),
    )
    return
  }
  closeSettings()
  if (!here) newSession(projectPath)
  const panel = here?.panel ?? newSessionPanel(projectPath)
  toggleTerminal(panel, true)
  void createTerminal(projectPath, panel, undefined, {
    text: command,
    run: true,
    signInAgent: status.id,
  })
}

/** The command the agent signs in with in a terminal, when it has one. */
export function terminalSignInCommand(status: AgentStatus): string | null {
  return status.authMethods.find((m) => m.type === 'terminal' && m.command)?.command ?? null
}
