import type { HostMethod, HostParams, HostResult } from '@shared/agent-host'
import type { TerminalMethod, TerminalParams, TerminalResult } from '@shared/terminal-host'
import { i18n } from './i18n'

export function host<M extends HostMethod>(
  method: M,
  params: HostParams<M>,
): Promise<HostResult<M>> {
  return window.kettu.agents.request(method, params)
}

export function terminals<M extends TerminalMethod>(
  method: M,
  params: TerminalParams<M>,
): Promise<TerminalResult<M>> {
  return window.kettu.terminals.request(method, params)
}

/** The code of a host or port error, if it has one. */
export function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code
    return typeof code === 'string' ? code : null
  }
  return null
}

/** What to show for a failed request: the host's own words, or the port's in the user's language. */
export function errorMessage(error: unknown): string {
  // The preload cannot translate, so its one error a user meets is worded here.
  if (errorCode(error) === 'host_restarted') return i18n.t('errors.hostRestarted')
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
