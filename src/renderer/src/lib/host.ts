import type { HostMethod, HostParams, HostResult } from '@shared/agent-host'
import type { TerminalMethod, TerminalParams, TerminalResult } from '@shared/terminal-host'

export function host<M extends HostMethod>(
  method: M,
  params: HostParams<M>,
): Promise<HostResult<M>> {
  return window.overbench.agents.request(method, params)
}

export function terminals<M extends TerminalMethod>(
  method: M,
  params: TerminalParams<M>,
): Promise<TerminalResult<M>> {
  return window.overbench.terminals.request(method, params)
}

/** The code of a host or port error, if it has one. */
export function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code
    return typeof code === 'string' ? code : null
  }
  return null
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
