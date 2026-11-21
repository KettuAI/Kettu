// Main's own port to this computer's agent host for the notch island: requests of the island's
// methods alone, with a time limit each, and the host's events.

import type { HostEvent, HostParams, HostResult } from '@shared/agent-host'
import { hostRequestLimit } from '@shared/host-request-limits'
import type { FromPort, PortError } from '@shared/port-rpc'
import { t } from '../i18n'
import { isIslandHostMethod, type IslandHostMethod } from './host-feed'

/** The members of Electron's `MessagePortMain` the client uses, which tests replace. */
export interface IslandPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  start(): void
  close(): void
}

interface Pending {
  resolve(value: unknown): void
  reject(error: PortError): void
  timer: ReturnType<typeof setTimeout> | null
}

export class IslandHostPort {
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private closed = false

  constructor(
    private readonly port: IslandPort,
    private readonly onEvent: (event: HostEvent) => void,
    private readonly onClose: () => void,
  ) {
    port.on('message', ({ data }) => this.receive(data))
    port.on('close', () => this.ended())
    port.start()
  }

  request<M extends IslandHostMethod>(method: M, params: HostParams<M>): Promise<HostResult<M>> {
    if (!isIslandHostMethod(method)) {
      return Promise.reject({ code: 'forbidden', message: `${String(method)} is not allowed` })
    }
    if (this.closed) {
      return Promise.reject({
        code: 'host_restarted',
        message: t('island.hostNotConnected'),
        log: 'The agent host is not connected',
      } satisfies PortError)
    }
    const id = this.nextId++
    return new Promise<HostResult<M>>((resolve, reject) => {
      const limit = hostRequestLimit(method)
      const timer =
        limit === null
          ? null
          : setTimeout(() => {
              this.pending.delete(id)
              reject({
                code: 'timeout',
                message: t('island.hostSilent'),
                log: `${method} got no answer within ${limit} ms`,
              })
            }, limit)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.port.postMessage({ type: 'request', id, method, params })
    })
  }

  close(): void {
    if (this.closed) return
    this.port.close()
    this.ended()
  }

  private receive(data: unknown): void {
    if (typeof data !== 'object' || data === null) return
    const message = data as FromPort<HostEvent>
    if (message.type === 'event') {
      this.onEvent(message.event)
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (pending.timer) clearTimeout(pending.timer)
    if (message.type === 'response') pending.resolve(message.result)
    else pending.reject(message.error)
  }

  private ended(): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject({
        code: 'host_restarted',
        message: t('island.hostStopped'),
        log: 'The agent host stopped',
      })
    }
    this.pending.clear()
    this.onClose()
  }
}
