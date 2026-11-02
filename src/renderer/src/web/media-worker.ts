// The web client's service worker: it answers the page's media URLs, every part read by the page
// that holds the channel, and lets every other request through untouched.

import { mediaToken, respondMedia, type Part, type PartAsk } from './media-ranges'

// The DOM library has no service worker types, and the WebWorker one clashes with it; these are
// the parts this worker uses.
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void
}
interface FetchEvent extends ExtendableEvent {
  readonly request: Request
  readonly clientId: string
  respondWith(response: Promise<Response>): void
}
interface WindowClient {
  readonly id: string
  postMessage(message: unknown, transfer: Transferable[]): void
}
interface WorkerScope {
  readonly location: Location
  readonly clients: {
    get(id: string): Promise<WindowClient | undefined>
    matchAll(options: { type: 'window' }): Promise<WindowClient[]>
    claim(): Promise<void>
  }
  skipWaiting(): Promise<void>
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void
}

const worker = self as unknown as WorkerScope

/** How long the page has to answer for a part before the read fails. */
const PART_TIMEOUT_MS = 120_000

worker.addEventListener('install', (event) => event.waitUntil(worker.skipWaiting()))
// A page open before the worker came uses it at once, without a reload.
worker.addEventListener('activate', (event) => event.waitUntil(worker.clients.claim()))

worker.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== worker.location.origin) return
  const token = mediaToken(url.pathname)
  if (!token) return
  const answer = answerFor(event, token, url.searchParams.has('save'))
  event.respondWith(answer.then(({ response }) => response))
  event.waitUntil(answer.then(({ done }) => done))
})

async function answerFor(event: FetchEvent, token: string, save: boolean) {
  const client = await pageOf(event.clientId, token)
  if (!client) return { response: new Response(null, { status: 404 }), done: Promise.resolve() }
  return respondMedia(
    event.request,
    (offset, length, signal) => ask(client, { type: 'kettu-media', token, offset, length }, signal),
    save,
  )
}

/**
 * The page whose URL it is: the one that asked, or for a download, which no page asks for, the
 * page that knows the token.
 */
async function pageOf(clientId: string, token: string): Promise<WindowClient | null> {
  const asking = clientId ? await worker.clients.get(clientId) : undefined
  if (asking) return asking
  for (const client of await worker.clients.matchAll({ type: 'window' })) {
    const about = await ask(client, { type: 'kettu-media', token, offset: 0, length: 0 })
    if (about.kind === 'granted') return client
  }
  return null
}

function ask(client: WindowClient, part: PartAsk, signal?: AbortSignal): Promise<Part> {
  return new Promise((resolve) => {
    const { port1, port2 } = new MessageChannel()
    const settle = (answer: Part) => {
      clearTimeout(timer)
      port1.close()
      resolve(answer)
    }
    const timer = setTimeout(() => settle({ kind: 'failed' }), PART_TIMEOUT_MS)
    port1.onmessage = (message) => settle(message.data as Part)
    signal?.addEventListener('abort', () => {
      port1.postMessage('cancel')
      settle({ kind: 'cancelled' })
    })
    client.postMessage(part, [port2])
  })
}
