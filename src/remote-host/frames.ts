// The artifact frames the direct port serves the web client: each opened by a device's session
// under a random token, which its URL carries, since a sandboxed frame sends no credentials of the
// page's. A token names one artifact and lasts until the frame closes or the session ends.

import { addLogSecret } from '@shared/log/process-log'
import { randomBytes } from 'node:crypto'

/** The path every frame's files lie under, as `/frame/<token>/`. */
export const FRAME_PATH = '/frame/'

/** 32 random bytes in base64url. */
export const FRAME_TOKEN = /^[A-Za-z0-9_-]{43}$/

/** The frames one session keeps open; opening more closes its oldest. */
export const MAX_FRAMES = 64

export interface Frame<S> {
  session: S
  artifactId: string
  /**
   * A page of the frame loaded with the CDNs in its policy, so it could send out what it reads:
   * it is offered nothing that reads beyond the artifact until it is opened anew.
   */
  lax: boolean
}

export class ArtifactFrames<S> {
  private readonly frames = new Map<string, Frame<S>>()

  /** A new token for a frame of `artifactId`, for `session`. */
  open(session: S, artifactId: string): string {
    const own = [...this.frames].filter(([, frame]) => frame.session === session)
    for (const [token] of own.slice(0, Math.max(0, own.length - MAX_FRAMES + 1))) {
      this.frames.delete(token)
    }
    const token = randomBytes(32).toString('base64url')
    addLogSecret(token)
    this.frames.set(token, { session, artifactId, lax: false })
    return token
  }

  /** Ends a frame `session` opened; another session's token is left alone. */
  close(session: S, token: string): void {
    if (this.frames.get(token)?.session === session) this.frames.delete(token)
  }

  /** The session ended, and every frame it opened with it. */
  closeAll(session: S): void {
    for (const [token, frame] of [...this.frames]) {
      if (frame.session === session) this.frames.delete(token)
    }
  }

  find(token: string): Frame<S> | undefined {
    return FRAME_TOKEN.test(token) ? this.frames.get(token) : undefined
  }
}
