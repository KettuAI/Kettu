// Main's relay of a page's capability requests: `POST /_kettu/v1` on the artifact's own origin,
// passed to the agent host untouched with the artifact the origin names. Main reads nothing in a
// message beyond its kind, which picks one JSON answer or a stream of them.

import {
  errorAnswer,
  isCapabilityKind,
  isLastAnswer,
  messageHeader,
  RUNTIME_MESSAGE_BYTES,
  RUNTIME_PATH,
  type RuntimeAnswer,
} from '@shared/artifact-capabilities'
import { artifactHeaders } from './policy'

/** How long one answer may take; a question to the user waits under this, and a stream has none. */
export const ANSWER_WAIT_MS = 60_000

export interface RuntimeRelay {
  /** Sends the message to the host; each answer goes to `answer`. Returns the cancel. */
  send(artifactId: string, message: unknown, answer: (answer: RuntimeAnswer) => void): () => void
  /**
   * A page of the origin asked for a capability that reads beyond it: from now on the origin
   * loads nothing from the CDNs, whatever its pages' policy says.
   */
  reading(artifactId: string): void
}

/** Whether a request is the runtime's: its path on an artifact origin, `/_kettu/v1`. */
export function isRuntimeRequest(url: string): boolean {
  return URL.parse(url)?.pathname === RUNTIME_PATH
}

/** The body, at most the largest message a page may send; null for one longer. */
export async function readBody(
  request: Request,
  limit = RUNTIME_MESSAGE_BYTES,
): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function json(answer: RuntimeAnswer, status = 200): Response {
  const headers = { ...artifactHeaders(true), 'Content-Type': 'application/json; charset=utf-8' }
  return new Response(JSON.stringify(answer), { status, headers })
}

/** The answer carries the page's own id and version, whatever the host put there. */
function stamped(header: { v: number; id: string }, answer: RuntimeAnswer): RuntimeAnswer {
  return { ...answer, v: header.v, id: header.id }
}

const CAPABILITIES_READING: ReadonlySet<unknown> = new Set(['files', 'sample'])

/**
 * Answers a page's capability message, already read as JSON: through `relay`, or for a frame no
 * runtime serves, such as a thumbnail's, as a capability that is not there.
 */
export function relayMessage(
  message: unknown,
  artifactId: string,
  relay: RuntimeRelay | null,
  signal: AbortSignal,
): Promise<Response> | Response {
  const header = messageHeader(message)
  const { kind, cap } = (typeof message === 'object' && message !== null ? message : {}) as {
    kind?: unknown
    cap?: unknown
  }
  if (!isCapabilityKind(kind)) return json(errorAnswer(header, 'invalid', 'Unknown kind.'), 400)
  // Closing a stream's request is its cancel; a cancel message has nothing left to end here.
  if (kind === 'cancel') return json({ ...header, ok: true, value: null })
  if (!relay) {
    return json(
      kind === 'use'
        ? { ...header, ok: true, value: null }
        : errorAnswer(header, 'unsupported', 'Nothing is offered here.'),
    )
  }
  if (CAPABILITIES_READING.has(cap)) relay.reading(artifactId)
  if (kind === 'stream') return streamed(message, artifactId, relay, signal, header)
  return new Promise<Response>((resolve) => {
    let cancel = (): void => {}
    const timer = setTimeout(() => {
      cancel()
      resolve(json(errorAnswer(header, 'failed', 'Kettu took too long to answer.')))
    }, ANSWER_WAIT_MS)
    cancel = relay.send(artifactId, message, (answer) => {
      if (!isLastAnswer(answer)) return
      clearTimeout(timer)
      resolve(json(stamped(header, answer)))
    })
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      cancel()
    })
  })
}

function streamed(
  message: unknown,
  artifactId: string,
  relay: RuntimeRelay,
  signal: AbortSignal,
  header: { v: number; id: string },
): Response {
  const encoder = new TextEncoder()
  let cancel = (): void => {}
  let open = true
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const end = (): void => {
        if (!open) return
        open = false
        cancel()
        controller.close()
      }
      cancel = relay.send(artifactId, message, (answer) => {
        if (!open) return
        controller.enqueue(encoder.encode(`${JSON.stringify(stamped(header, answer))}\n`))
        if (isLastAnswer(answer)) {
          open = false
          controller.close()
        }
      })
      signal.addEventListener('abort', end)
    },
    cancel() {
      open = false
      cancel()
    },
  })
  const headers = {
    ...artifactHeaders(true),
    'Content-Type': 'application/x-ndjson; charset=utf-8',
  }
  return new Response(body, { headers })
}

/**
 * Answers `POST /_kettu/v1` for the artifact on the request's origin: the body is one message,
 * which goes to the host as it is. Messages of other kinds are the editor's, for `editor`.
 */
export async function respondRuntime(
  request: Request,
  artifactId: string,
  relay: RuntimeRelay | null,
  editor?: (message: unknown, bytes: number) => Response,
): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { ...artifactHeaders(true), Allow: 'POST' } })
  }
  const text = await readBody(request)
  if (text === null) {
    return json(errorAnswer({ v: 1, id: '' }, 'too_large', 'The message is too large.'), 413)
  }
  let message: unknown
  try {
    message = JSON.parse(text) as unknown
  } catch {
    return json(errorAnswer({ v: 1, id: '' }, 'invalid', 'The message is not JSON.'), 400)
  }
  const kind = (typeof message === 'object' && message !== null ? message : {}) as {
    kind?: unknown
  }
  if (editor && !isCapabilityKind(kind.kind)) return editor(message, Buffer.byteLength(text))
  return relayMessage(message, artifactId, relay, request.signal)
}
