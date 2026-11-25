// The web client's relay of a frame's capability messages. Each message the frame's page posts on
// the port it was handed goes over the encrypted channel, as it is, with the frame's folder, which
// names the artifact; each answer comes back to the port. The relay reads only a message's kind
// and id, to route the answers, and never acts on one.

import type { HostEvent } from '@shared/agent-host'
import {
  errorAnswer,
  isCapabilityKind,
  messageHeader,
  RUNTIME_VERSION,
  type RuntimeAnswer,
} from '@shared/artifact-capabilities'
import type { HostLink } from '@shared/remote/link'

let relays = 0

/**
 * Relays the capability messages of the frame at `frameUrl` that arrive on `port`; the editor's
 * own messages on the same port are left to it. Returns the detach, which ends the frame's streams.
 */
export function attachRuntimePort(
  link: HostLink,
  frameUrl: string,
  port: MessagePort,
  allowCapability?: (frameUrl: string, cap: string) => boolean,
): () => void {
  const path = URL.parse(frameUrl)?.pathname ?? ''
  const relay = ++relays
  const streams = new Set<string>()
  let attached = true
  const post = (answer: RuntimeAnswer): void => {
    if (attached) port.postMessage(answer)
  }
  const offEvents = link.onHostEvent((value) => {
    const event = value as HostEvent
    if (event.type !== 'artifacts.runtime' || !streams.has(event.stream)) return
    post(event.answer)
  })
  const send = (message: unknown, stream?: string): Promise<RuntimeAnswer> =>
    (
      link.request('artifacts.frameRuntime', {
        path,
        message,
        ...(stream === undefined ? {} : { stream }),
      }) as Promise<RuntimeAnswer>
    ).catch(() => errorAnswer(messageHeader(message), 'failed', 'The host did not answer.'))
  const onMessage = (event: MessageEvent): void => {
    const message: unknown = event.data
    const payload = (typeof message === 'object' && message !== null ? message : {}) as {
      kind?: unknown
      cap?: unknown
    }
    const kind = payload.kind
    if (!isCapabilityKind(kind)) return
    const header = messageHeader(message)
    const { id } = header
    if (kind === 'cancel') {
      const stream = `${relay}:${id}`
      if (streams.delete(stream)) void send(message, stream)
      return
    }
    // Strict isolation guard: never relay host/project data capabilities from a lax frame.
    if (
      allowCapability &&
      typeof payload.cap === 'string' &&
      !allowCapability(frameUrl, payload.cap)
    ) {
      post(
        kind === 'use'
          ? { ...header, ok: true, value: null }
          : errorAnswer(header, 'not_allowed', 'Reload in strict sandbox to use this capability.'),
      )
      return
    }
    if (kind !== 'stream') {
      void send(message).then(post)
      return
    }
    const stream = `${relay}:${id}`
    streams.add(stream)
    void send(message, stream).then((last) => {
      if (!streams.delete(stream)) return
      post(last)
    })
  }
  port.addEventListener('message', onMessage)
  port.start()
  return () => {
    attached = false
    port.removeEventListener('message', onMessage)
    offEvents()
    for (const stream of streams) {
      void send(
        { v: RUNTIME_VERSION, id: stream.slice(stream.indexOf(':') + 1), kind: 'cancel' },
        stream,
      )
    }
    streams.clear()
  }
}
