// Where a session's browser calls run: on the page of the desktop app that sent its latest turn,
// through that app's port, or in main, whose browser serves the host's own windows and, on a
// desktop host, the devices that have none. A navigation to a dev server on this host names the
// forward the app's page needs to reach it.

import type { HostEvent } from '@shared/agent-host'
import {
  isBrowserForwardPort,
  loopbackForward,
  MAX_COMPANION_FORWARDS,
  type BrowserCallAnswer,
  type BrowserCallRequest,
  type BrowserDeviceCall,
  type BrowserForward,
} from '@shared/browser'
import type { PortDevice } from '@shared/remote/device'
import type { TurnSender } from './sessions'

const ERROR_CODES = new Set([
  'user_has_control',
  'stopped',
  'not_allowed',
  'needs_allow',
  'stale_ref',
  'timeout',
  'navigation_failed',
  'no_page',
  'invalid',
  'unavailable',
])

/** What an agent is told when the desktop app that sent the turn is no longer connected. */
export const BROWSER_GONE =
  'The browser is unavailable: the Kettu desktop app that sent this turn is not connected to ' +
  'this host now. Ask the user to check the page themselves, or try again once they are back.'

/** What main or a desktop app answered a browser call: its result, or the error that refused it. */
export function answerOf(result: unknown, problem: unknown): BrowserCallAnswer {
  const error = problem as { code?: unknown; message?: unknown; tab?: unknown } | undefined
  if (error && typeof error === 'object') {
    const code = typeof error.code === 'string' && ERROR_CODES.has(error.code) ? error.code : null
    if (code) {
      const tab = code === 'needs_allow' ? tabOf(error.tab) : null
      // A tab of the user's that cannot be named cannot be asked about either.
      if (code === 'needs_allow' && !tab) {
        return { error: { code: 'invalid', message: 'Main gave no answer to the call.' } }
      }
      return {
        error: {
          code: code as Extract<BrowserCallAnswer, { error: unknown }>['error']['code'],
          message: typeof error.message === 'string' ? error.message : 'The call failed.',
          ...(tab ? { tab } : {}),
        },
      }
    }
  }
  const value = result as { text?: unknown; value?: unknown; image?: unknown } | undefined
  if (
    value &&
    typeof value === 'object' &&
    typeof value.text === 'string' &&
    typeof value.value === 'object' &&
    value.value !== null
  ) {
    return {
      result: {
        text: value.text,
        value: value.value as Record<string, unknown>,
        ...(typeof value.image === 'string' ? { image: value.image } : {}),
      },
    }
  }
  return { error: { code: 'invalid', message: 'Main gave no answer to the call.' } }
}

const MAX_TAB_ID = 64
const MAX_TAB_TITLE = 200

/** The user's tab a `needs_allow` names, as far as it can be one. */
function tabOf(value: unknown): { id: string; title: string } | null {
  const { id, title } = (value ?? {}) as { id?: unknown; title?: unknown }
  if (typeof id !== 'string' || id === '' || id.length > MAX_TAB_ID) return null
  return { id, title: typeof title === 'string' ? title.slice(0, MAX_TAB_TITLE) : id }
}

/** The ports the host serves, as far as the browser's routing reads them. */
export interface BrowserPorts {
  deviceOf(portId: string): PortDevice | null
  browserPort(deviceId: string): string | null
}

/** Main, a desktop app's port, or none: the app that sent the turn has gone. */
export type BrowserTarget = { kind: 'main' } | { kind: 'device'; portId: string } | { kind: 'gone' }

/**
 * Where the calls of a session whose latest turn `sender` sent go: a desktop app's own port, or
 * another of the same app's once that one closed; main for a window, a device without a browser
 * and a turn nobody sent, as a routine's.
 */
export function browserTarget(sender: TurnSender | null, ports: BrowserPorts): BrowserTarget {
  if (!sender?.device) return { kind: 'main' }
  if (!sender.device.browser) return { kind: 'main' }
  if (ports.deviceOf(sender.portId)?.browser) return { kind: 'device', portId: sender.portId }
  const portId = ports.browserPort(sender.device.id)
  return portId ? { kind: 'device', portId } : { kind: 'gone' }
}

export interface DeviceBrowserDeps {
  send(portId: string, event: HostEvent): void
  /** The artifacts service's port, which no page may reach. */
  servicePort(): number | null
}

/** Browser calls sent to desktop apps' ports, until each app answers or its port closes. */
export class DeviceBrowserCalls {
  private readonly calls = new Map<
    number,
    { portId: string; resolve: (answer: BrowserCallAnswer) => void }
  >()

  constructor(private readonly deps: DeviceBrowserDeps) {}

  /** Sends the call to the app's port; it settles with the app's answer. */
  call(portId: string, request: BrowserCallRequest): Promise<BrowserCallAnswer> {
    const url = request.tool === 'browser_navigate' ? request.args.url : undefined
    const forward = typeof url === 'string' ? loopbackForward(url) : null
    const servicePort = this.deps.servicePort()
    if (forward && forward.port === servicePort) {
      return Promise.resolve({
        error: {
          code: 'not_allowed',
          message: 'That port is Kettu’s own service on this host, which pages may not open.',
        },
      })
    }
    const forwards: BrowserForward[] = []
    if (forward && Array.isArray(request.args.forward_ports)) {
      const seen = new Set<number>([forward.port])
      for (const value of request.args.forward_ports.slice(0, MAX_COMPANION_FORWARDS)) {
        if (!isBrowserForwardPort(value)) continue
        if (value === servicePort) {
          return Promise.resolve({
            error: {
              code: 'not_allowed',
              message: 'That port is Kettu’s own service on this host, which pages may not open.',
            },
          })
        }
        if (seen.has(value)) continue
        seen.add(value)
        forwards.push({ host: forward.host, port: value })
      }
    }
    const call: BrowserDeviceCall = {
      ...request,
      ...(forward ? { forward } : {}),
      ...(forwards.length > 0 ? { forwards } : {}),
    }
    return new Promise((resolve) => {
      this.calls.set(request.callId, { portId, resolve })
      this.deps.send(portId, { type: 'browser.call', call })
    })
  }

  /** Whether `callId` is a call sent to `portId` that waits for its answer. */
  owns(portId: string, callId: number): boolean {
    return this.calls.get(callId)?.portId === portId
  }

  /** The app's answer to a call; false when the port was sent no such call. */
  answer(portId: string, callId: number, answer: unknown): boolean {
    if (!this.owns(portId, callId)) return false
    const { resolve } = this.calls.get(callId)!
    this.calls.delete(callId)
    const { result, error } = (answer ?? {}) as { result?: unknown; error?: unknown }
    resolve(answerOf(result, error))
    return true
  }

  /** The app's port closed: its calls fail, as nothing can answer them now. */
  portClosed(portId: string): void {
    for (const [callId, call] of [...this.calls]) {
      if (call.portId !== portId) continue
      this.calls.delete(callId)
      call.resolve({ error: { code: 'unavailable', message: BROWSER_GONE } })
    }
  }
}
