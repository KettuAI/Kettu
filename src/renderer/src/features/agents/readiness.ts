import type { AgentStatus } from '@shared/agent-host'
import { i18n } from '@renderer/lib/i18n'

export type AgentReadiness =
  | { kind: 'ready' }
  | { kind: 'sign-in' }
  | { kind: 'installing' }
  | { kind: 'starting' }
  | { kind: 'failed'; message: string }
  | { kind: 'missing'; message: string; action: string; url: string | null }

export function readiness(status: AgentStatus): AgentReadiness {
  switch (status.state) {
    case 'not-installed':
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
 * listed with the agents to install, since installing is one click away.
 */
export function listedInstalled(status: AgentStatus): boolean {
  return readiness(status).kind !== 'missing' && !(status.package && !status.package.installed)
}
