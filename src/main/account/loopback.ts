// The loopback redirect a desktop sign-in comes back on (RFC 8252 section 7.3): a server on
// 127.0.0.1 with a port of the system's choosing, waiting for the browser at `/callback`.

import { createServer, type ServerResponse } from 'node:http'

export type CallbackResult =
  | { kind: 'code'; code: string }
  /** The user cancelled on the sign-in page. */
  | { kind: 'denied' }
  | { kind: 'error'; error: string }
  | { kind: 'timeout' }
  /** Closed here before anything came, as by Cancel. */
  | { kind: 'closed' }

export type LoopbackReply = { location: string } | { status: number; text: string }

export interface Loopback {
  redirectUri: string
  /** The first callback that carries the state, or why none came. */
  result: Promise<CallbackResult>
  /** Answers the browser that brought a code or an error, then stops listening. */
  answer(reply: LoopbackReply): void
  close(): void
}

const TEXT_HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'close',
}

function send(response: ServerResponse, reply: LoopbackReply, done?: () => void): void {
  if ('location' in reply) {
    // The page the browser goes on to never sees the code in a referrer.
    response.writeHead(302, {
      location: reply.location,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      connection: 'close',
    })
    response.end(done)
  } else {
    response.writeHead(reply.status, TEXT_HEADERS)
    response.end(reply.text, done)
  }
}

/** Listens for the browser to come back with `state`, for at most `timeoutMs`. */
export function listenLoopback({
  state,
  timeoutMs,
}: {
  state: string
  timeoutMs: number
}): Promise<Loopback> {
  const server = createServer()
  let settled = false
  let waiting: ServerResponse | null = null
  let resolve!: (result: CallbackResult) => void
  const result = new Promise<CallbackResult>((done) => (resolve = done))

  const stop = (): void => {
    server.close()
    server.closeAllConnections()
  }
  const settle = (value: CallbackResult): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    resolve(value)
  }
  const timer = setTimeout(() => {
    settle({ kind: 'timeout' })
    stop()
  }, timeoutMs)

  server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' || url.pathname !== '/callback') {
      send(response, { status: 404, text: 'Not found' })
      return
    }
    if (settled) {
      send(response, { status: 410, text: 'This sign-in is over. Go back to Kettu.' })
      return
    }
    // Anything else on this computer can reach the port, so only the state counts; the wait goes on.
    if (url.searchParams.get('state') !== state) {
      send(response, {
        status: 400,
        text: 'This is not the sign-in Kettu is waiting for. Go back to Kettu and sign in again.',
      })
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (!error && !code) {
      send(response, { status: 400, text: 'The sign-in came back without a code.' })
      return
    }
    waiting = response
    settle(
      error
        ? error === 'access_denied'
          ? { kind: 'denied' }
          : { kind: 'error', error }
        : { kind: 'code', code: code! },
    )
  })

  return new Promise((done, fail) => {
    server.once('error', (error) => {
      clearTimeout(timer)
      fail(error)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        stop()
        fail(new Error('The loopback server has no port'))
        return
      }
      done({
        redirectUri: `http://127.0.0.1:${address.port}/callback`,
        result,
        answer: (reply) => {
          const response = waiting
          waiting = null
          if (response) send(response, reply, stop)
          else stop()
        },
        close: () => {
          settle({ kind: 'closed' })
          const response = waiting
          waiting = null
          if (response) send(response, { status: 410, text: 'Kettu stopped this sign-in.' }, stop)
          else stop()
        },
      })
    })
  })
}
