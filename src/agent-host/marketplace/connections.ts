// The sign-ins of the Marketplace's OAuth servers: which are connected, the logins on their way,
// a fresh token for the proxy, and keeping each change with main, which stores it encrypted.
// No token leaves this module except toward the server it was issued for, through the proxy.

import { randomUUID } from 'node:crypto'
import type {
  ConnectStart,
  MarketConnection,
  MarketConnections,
  MarketServer,
  McpOAuth,
  McpSpec,
} from '@shared/marketplace'
import { HostError } from '../errors'
import type { LogFn } from '../storage'
import {
  browserLogin,
  deviceLogin,
  isCancelled,
  parseSignIn,
  probe,
  renew,
  timedFetch,
  type Login,
  type SignIn,
} from './oauth'

/** Renewed this long before it expires. */
export const RENEW_EARLY_MS = 5 * 60_000

/** How a server reaches its agents: directly, through the proxy with a token, or not at all. */
export type Access = 'open' | 'proxy' | null

export interface ConnectionsDeps {
  log: LogFn
  /** The servers the settings keep. */
  servers(): readonly MarketServer[]
  /** A server's fixed headers and filled inputs, which the probe sends as agents would. */
  headers(server: MarketServer): Record<string, string>
  /** Asks main to keep a sign-in, or with null to forget it. */
  keep(serverId: string, state: string | null): void
  /** A server's sign-in changed; `loginId` and `error` close the Connect a window started. */
  changed(serverId: string, connection: MarketConnection, loginId?: string, error?: string): void
  fetch?: typeof fetch
  now?: () => number
  /** Waits between device flow polls. */
  sleep?: (ms: number) => Promise<void>
}

/** A server that signs in with OAuth. */
type OAuthServer = MarketServer & { spec: Extract<McpSpec, { type: 'http' }> & { oauth: McpOAuth } }

function oauthServer(server: MarketServer | undefined): OAuthServer | null {
  return server && server.spec.type === 'http' && server.spec.oauth ? (server as OAuthServer) : null
}

/** Why a renewal failed: the service's OAuth error, or the failure's own message. */
function refusal(error: unknown): string {
  const { message, errorCode } = error as { message?: string; errorCode?: string }
  if (message) return message
  return `The service refused to renew the token${errorCode ? `: ${errorCode}` : ''}`
}

export class MarketConnectionsService {
  private readonly signs = new Map<string, SignIn>()
  /** The last time main confirmed each server's sign-in, by its `savedAt`. */
  private readonly confirmed = new Map<string, number>()
  /** Sign-ins cleared here that main may not have dropped yet, by when. */
  private readonly cleared = new Map<string, number>()
  private readonly errors = new Map<string, string>()
  private readonly logins = new Map<string, { serverId: string; login: Login }>()
  private readonly renewing = new Map<string, Promise<string | null>>()
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private lastSaved = 0

  constructor(private readonly deps: ConnectionsDeps) {
    this.fetch = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
  }

  /**
   * `host:market-keys`' sign-ins, the whole of what main keeps. A copy older than this host's, or
   * one this host cleared since, does not replace it; one main no longer has goes, unless it is a
   * change main has not confirmed yet.
   */
  load(kept: Record<string, string> | undefined): void {
    if (kept === undefined) return
    const ids = new Set([...Object.keys(kept), ...this.signs.keys(), ...this.cleared.keys()])
    for (const id of ids) {
      const text = Object.hasOwn(kept, id) ? kept[id] : undefined
      const theirs = text === undefined ? null : parseSignIn(text)
      if (text !== undefined && !theirs)
        this.deps.log('warn', `The sign-in kept for ${id} is unreadable`)
      const mine = this.signs.get(id)
      if (theirs) {
        this.confirmed.set(id, theirs.savedAt)
        this.lastSaved = Math.max(this.lastSaved, theirs.savedAt)
        const clearedAt = this.cleared.get(id)
        if (clearedAt !== undefined && clearedAt >= theirs.savedAt) continue
        this.cleared.delete(id)
        if (!mine || theirs.savedAt > mine.savedAt) this.signs.set(id, theirs)
        continue
      }
      this.cleared.delete(id)
      if (mine && mine.savedAt <= (this.confirmed.get(id) ?? -1)) {
        this.signs.delete(id)
        this.confirmed.delete(id)
      }
    }
  }

  /** Where each OAuth server of the settings stands. */
  view(): MarketConnections {
    const out: MarketConnections = {}
    for (const server of this.deps.servers()) {
      if (oauthServer(server)) out[server.id] = this.connection(server)
    }
    return out
  }

  /** How the server reaches agents now. */
  access(server: MarketServer): Access {
    const found = oauthServer(server)
    if (!found) return null
    const sign = this.current(found)
    if (!sign || sign.reconnect) return null
    return sign.kind === 'open' ? 'open' : 'proxy'
  }

  /** Starts signing in to a server of the settings; a sign-in already on its way for it ends. */
  async connect(serverId: string): Promise<ConnectStart> {
    const server = oauthServer(this.deps.servers().find((item) => item.id === serverId))
    if (!server) throw new HostError('not_found', 'Kettu keeps no server of that id that signs in')
    for (const [loginId, held] of this.logins) {
      if (held.serverId === serverId) this.cancel(loginId)
    }
    const loginId = randomUUID()
    const fetcher = timedFetch(this.fetch)
    const { url } = server.spec
    try {
      if (server.spec.oauth.flow === 'device') {
        const login = await deviceLogin({
          url,
          fetch: fetcher,
          now: this.now,
          ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}),
        })
        this.follow(serverId, loginId, login)
        const { userCode, verificationUri, expiresAt } = login
        return { loginId, kind: 'device', userCode, verificationUri, expiresAt }
      }
      const asked = await probe(url, this.deps.headers(server), fetcher)
      if (asked.kind === 'open') {
        const sign: SignIn = { v: 1, url, savedAt: this.stamp(), kind: 'open', account: null }
        // After the answer, so the window knows the login this closes.
        setImmediate(() => this.save(serverId, sign, loginId))
        return { loginId, kind: 'open' }
      }
      const login = await browserLogin({ url, probe: asked, fetch: fetcher, now: this.now })
      this.follow(serverId, loginId, login)
      return { loginId, kind: 'browser', url: login.url }
    } catch (error) {
      const message = (error as Error).message
      this.errors.set(serverId, message)
      this.deps.changed(serverId, this.connection(server))
      throw new HostError('unavailable', message)
    }
  }

  cancel(loginId: string): void {
    const held = this.logins.get(loginId)
    if (!held) return
    this.logins.delete(loginId)
    held.login.cancel()
  }

  /** Forgets a server's sign-in, here and with main; its agents lose it with their next attach. */
  disconnect(serverId: string): void {
    for (const [loginId, held] of this.logins) {
      if (held.serverId === serverId) this.cancel(loginId)
    }
    this.signs.delete(serverId)
    this.errors.delete(serverId)
    this.cleared.set(serverId, this.stamp())
    this.deps.keep(serverId, null)
    const server = this.deps.servers().find((item) => item.id === serverId)
    this.deps.changed(serverId, server ? this.connection(server) : { state: 'disconnected' })
  }

  /**
   * A token for the proxy to send: the kept one, renewed first when it expires within five
   * minutes. Null when the server is not connected or needs signing in again.
   */
  async token(serverId: string): Promise<string | null> {
    const server = oauthServer(this.deps.servers().find((item) => item.id === serverId))
    const sign = server ? this.current(server) : null
    if (!sign?.tokens || sign.reconnect) return null
    const { expiresAt, refresh } = sign.tokens
    if (refresh && expiresAt !== undefined && expiresAt - this.now() < RENEW_EARLY_MS) {
      return this.renewed(serverId, sign.tokens.access)
    }
    return sign.tokens.access
  }

  /**
   * The server refused `used`: renews it once, or hands out the token another request renewed
   * meanwhile. Null when it cannot be renewed, which leaves the server to be connected again.
   */
  async refused(serverId: string, used: string): Promise<string | null> {
    const sign = this.signs.get(serverId)
    if (!sign?.tokens || sign.reconnect) return null
    if (sign.tokens.access !== used) return sign.tokens.access
    return this.renewed(serverId, used)
  }

  private renewed(serverId: string, used: string): Promise<string | null> {
    let running = this.renewing.get(serverId)
    if (!running) {
      running = this.renewNow(serverId, used).finally(() => this.renewing.delete(serverId))
      this.renewing.set(serverId, running)
    }
    return running
  }

  private async renewNow(serverId: string, used: string): Promise<string | null> {
    const sign = this.signs.get(serverId)
    if (!sign?.tokens) return null
    if (sign.tokens.access !== used) return sign.tokens.access
    try {
      const next = await renew(sign, timedFetch(this.fetch), () => this.stamp())
      if (this.signs.get(serverId) !== sign) return this.signs.get(serverId)?.tokens?.access ?? null
      this.save(serverId, next)
      return next.tokens!.access
    } catch (error) {
      if (this.signs.get(serverId) !== sign) return null
      const reason = refusal(error)
      this.deps.log('warn', `The token for ${serverId} could not be renewed: ${reason}`)
      this.save(serverId, { ...sign, savedAt: this.stamp(), reconnect: reason })
      return null
    }
  }

  private follow(serverId: string, loginId: string, login: Login): void {
    this.logins.set(loginId, { serverId, login })
    login.done.then(
      (sign) => {
        if (!this.logins.delete(loginId)) return
        this.save(serverId, { ...sign, savedAt: this.stamp() }, loginId)
      },
      (error: unknown) => {
        this.logins.delete(loginId)
        const server = this.deps.servers().find((item) => item.id === serverId)
        const connection: MarketConnection = server
          ? this.connection(server)
          : { state: 'disconnected' }
        if (isCancelled(error)) {
          this.deps.changed(serverId, connection, loginId)
          return
        }
        const message = (error as Error).message
        this.deps.log('warn', `Signing in to ${serverId} failed: ${message}`)
        this.errors.set(serverId, message)
        this.deps.changed(serverId, server ? this.connection(server) : connection, loginId, message)
      },
    )
  }

  /** Keeps a sign-in here and with main, and tells the clients. */
  private save(serverId: string, sign: SignIn, loginId?: string): void {
    this.signs.set(serverId, sign)
    this.errors.delete(serverId)
    this.cleared.delete(serverId)
    this.deps.keep(serverId, JSON.stringify(sign))
    const server = this.deps.servers().find((item) => item.id === serverId)
    if (server) this.deps.changed(serverId, this.connection(server), loginId)
  }

  /** The sign-in for the server's present address. */
  private current(server: OAuthServer): SignIn | null {
    const sign = this.signs.get(server.id)
    return sign && sign.url === server.spec.url ? sign : null
  }

  private connection(server: MarketServer): MarketConnection {
    const found = oauthServer(server)
    const sign = found ? this.current(found) : null
    if (sign?.reconnect) return { state: 'needs-reconnect', reason: sign.reconnect }
    if (sign) return { state: 'connected', account: sign.account }
    const error = this.errors.get(server.id)
    return error ? { state: 'error', message: error } : { state: 'disconnected' }
  }

  /** A time for a change, later than every change before it. */
  private stamp(): number {
    this.lastSaved = Math.max(this.now(), this.lastSaved + 1)
    return this.lastSaved
  }
}
