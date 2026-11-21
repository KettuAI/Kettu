import type { AgentStatus } from '@shared/agent-host'
import { i18n } from '@renderer/lib/i18n'
import { awaitsPackage, hasProgram } from '@renderer/stores/agents'
import { harnessProblem, type HarnessProblem } from './harness-problem'

export type AgentReadiness =
  | { kind: 'ready' }
  | { kind: 'sign-in' }
  | { kind: 'installing' }
  | { kind: 'starting' }
  | { kind: 'failed'; message: string }
  | { kind: 'missing'; message: string; problem: HarnessProblem }

/**
 * The oldest version the user's program must be, when it is on the machine but older than Kettu
 * needs: updating it is the fix, not installing anything. Null otherwise.
 */
export function cliOutdated(status: AgentStatus): string | null {
  const problem = status.cli?.installed?.problem
  return problem?.kind === 'too-old' ? problem.minimum : null
}

export function readiness(status: AgentStatus): AgentReadiness {
  switch (status.state) {
    case 'not-installed':
    case 'node-missing':
    case 'node-outdated': {
      const problem = harnessProblem(status)!
      return { kind: 'missing', message: problem.text, problem }
    }
    case 'installing':
      return { kind: 'installing' }
    case 'starting':
      return { kind: 'starting' }
    case 'failed':
      return { kind: 'failed', message: status.detail ?? i18n.t('agents:readiness.couldNotStart') }
    default:
      return status.signIn === 'required' ? { kind: 'sign-in' } : { kind: 'ready' }
  }
}

/**
 * Listed under Installed: it can run now. A package agent whose adapter is not installed yet is
 * listed with the agents to install, since installing is one click away. Claude Code's SDK is no
 * such case beside the user's own CLI: its first start installs it, and nothing waits on the user.
 */
export function listedInstalled(status: AgentStatus): boolean {
  if (readiness(status).kind === 'missing') return false
  const pkg = status.package
  return !(pkg && !pkg.installed && !(pkg.isSdk && status.cli?.installed))
}

/**
 * The user's own program runs, and how it was installed reports no newer versions, so only its
 * own installer updates it and no check of Kettu's can say it is current.
 */
export function programUnchecked(status: AgentStatus): boolean {
  return (
    status.cli?.checkable === false &&
    !!status.cli.installed &&
    !status.package &&
    !status.release?.registry
  )
}

/**
 * Up to date only once the harness is on the machine. A check from when it could run does not make
 * a missing program, such as Pi's `pi`, current.
 */
export function showsCurrent(status: AgentStatus): boolean {
  if (status.uninstalled || !hasProgram(status) || awaitsPackage(status)) return false
  // A program that cannot run is not current, whatever a check said.
  if (readiness(status).kind === 'missing') return false
  if (cliOutdated(status) !== null || status.versionWarning || programUnchecked(status))
    return false
  return status.updateCheckedAt !== null || status.cli !== null
}
