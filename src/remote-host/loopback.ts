// Channels that come through SSH: TCP on 127.0.0.1 alone, which only this machine reaches, so
// whoever can log in over SSH reaches the daemon without its direct port being open to anyone.
// ssh -W on the user's computer forwards each one here.

import { createServer, type Server, type Socket } from 'node:net'
import type { LogFn } from '../agent-host/storage'
import type { RemoteServer } from './server'
import { streamTransport } from './stream-transport'

const LOOPBACK = '127.0.0.1'

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ port, host: LOOPBACK }, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

export class LoopbackListener {
  private constructor(
    private readonly listener: Server | null,
    /** The port it listens on, or null when it could not listen at all. */
    readonly port: number | null,
  ) {}

  /**
   * Listens on `port`, kept from the run before so the computers that added this one over SSH
   * find it at once, or on any free port when that one is taken or there is none yet.
   */
  static async start(
    server: Pick<RemoteServer, 'accept'>,
    port: number | null,
    log: LogFn,
  ): Promise<LoopbackListener> {
    const take = (socket: Socket): void => {
      socket.setNoDelay(true)
      socket.on('error', () => {})
      server.accept(streamTransport(socket))
    }
    for (const tried of port === null ? [0] : [port, 0]) {
      const listener = createServer(take)
      try {
        await listen(listener, tried)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        log('warn', `Channels through SSH cannot listen on ${LOOPBACK}:${tried}: ${code}`)
        continue
      }
      listener.on('error', (error) => log('warn', `Channels through SSH: ${error.message}`))
      const address = listener.address()
      return new LoopbackListener(
        listener,
        typeof address === 'object' && address ? address.port : tried,
      )
    }
    return new LoopbackListener(null, null)
  }

  /** Stops taking connections; the channels stay for the remote host to end with a reason. */
  stop(): void {
    this.listener?.close()
  }
}
