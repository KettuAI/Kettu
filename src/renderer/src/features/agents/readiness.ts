import type { AgentStatus } from '@shared/agent-host'
import { i18n } from '@renderer/lib/i18n'
import { awaitsPackage, hasProgram } from '@renderer/stores/agents'

export type AgentReadiness =
  | { kind: 'ready' }
  | { kind: 'sign-in' }
  | { kind: 'installing' }
  | { kind: 'starting' }
  | { kind: 'failed'; message: string }
  | { kind: 'missing'; message: string; action: string; url: string | null }

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
      if (cliOutdated(status) !== null) {
        return {
          kind: 'missing',
          message: status.detail ?? i18n.t('agents:readiness.outdated'),
          action: i18n.t('agents:readiness.update'),
          url: null,
        }
      }
      return {
        kind: 'missing',
        message: status.detail ?? i18n.t('agents:readiness.notFound'),
        action: i18n.t('agents:readiness.howToInstall'),
        url: status.installUrl,
      }
    case 'node-missing':
    case 'node-outdated':
      return {
        kind: 'missing',
        message: status.detail ?? i18n.t('agents:readiness.needsNode'),
        action: i18n.t('agents:readiness.installNode'),
        url: status.installUrl,
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
 * Up to date only once the harness is on the machine. A check from when it could run does not make
 * a missing program, such as Pi's `pi`, current.
 */
export function showsCurrent(status: AgentStatus): boolean {
  if (status.uninstalled || !hasProgram(status) || awaitsPackage(status)) return false
  if (cliOutdated(status) !== null || status.versionWarning) return false
  return status.updateCheckedAt !== null || status.cli !== null
}
