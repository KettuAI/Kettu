import type { AgentStatus } from '@shared/agent-host'

export type AgentReadiness =
  | { kind: 'ready' }
  | { kind: 'sign-in' }
  | { kind: 'starting' }
  | { kind: 'restarting' }
  | { kind: 'failed'; message: string }
  | { kind: 'missing'; message: string; action: string; url: string | null }

export function readiness(status: AgentStatus): AgentReadiness {
  switch (status.state) {
    case 'not-installed':
      return {
        kind: 'missing',
        message: status.detail ?? 'Not found on PATH.',
        action: 'How to install',
        url: status.installUrl,
      }
    case 'node-missing':
    case 'node-outdated':
      return {
        kind: 'missing',
        message: status.detail ?? 'Needs Node.js 22 or later.',
        action: 'Install Node.js',
        url: status.installUrl,
      }
    case 'starting':
      return { kind: 'starting' }
    case 'crashed':
      return { kind: 'restarting' }
    case 'failed':
      return { kind: 'failed', message: status.detail ?? 'Could not start.' }
    default:
      return status.signIn === 'required' ? { kind: 'sign-in' } : { kind: 'ready' }
  }
}

/** The line under an agent's name: its version once known, else how it launches. */
export function agentSubline(status: AgentStatus): string {
  if (status.version) return `v${status.version}`
  if (status.binaryOverride) return status.binaryOverride
  return status.launchCommand
}
