// The hosted web client's Kettu account. The browser signs in at the website's app sign-in page as
// the public client `kettu-web`, with PKCE (RFC 7636), and comes back to CALLBACK_PATH with a code.
// The access token stays in this tab's memory; the refresh token, which rotates on every use, is kept
// in IndexedDB, and a Web Lock lets one tab at a time use it, since the service signs out a client
// whose refresh token is used twice.

import type {
  AccountPlan,
  AccountProfile,
  AccountStatus,
  AccountUsage,
  SignedOutReason,
  SignInFailure,
} from '@shared/account'
import {
  AccountApi,
  AccountServiceError,
  clientInfo,
  DEVICE_LIMIT,
  signedOutReason,
  signInFailure,
  WEB_CLIENT,
  type Me,
  type TokenSet,
} from '@shared/account-api'
import { encodeRelayBytes } from '@shared/remote/relay'
import { HOSTED_STORE, run } from '../storage'

const RECORD = 'account'
const PENDING_KEY = 'kettu.signin'
const LOCK = 'kettu-account'
const CHANNEL = 'kettu-account'

/** Where the website sends the browser back with the sign-in's code. */
export const CALLBACK_PATH = '/signin/callback'

/** What this browser keeps of its sign-in. */
interface Stored {
  refreshToken: string
  profile: { id: string; email: string; name: string | null; avatarUrl: string | null }
  subscription: string
  plan: AccountPlan | null
  usage: AccountUsage | null
}

/** A sign-in under way: what the callback checks and where the page goes after it. */
interface Pending {
  verifier: string
  state: string
  back: string
}

export interface HostedAccountOptions {
  /** The website and its API. */
  accountUrl: string
  /** How the account page lists this browser. */
  client: { name: string; os: string; version: string }
  locale(): 'en' | 'zh-CN'
  /** What it takes from the browser; tests give their own. */
  env?: AccountEnv
}

/** What the account takes from the browser. */
export interface AccountEnv {
  api: Pick<AccountApi, 'exchangeCode' | 'refresh' | 'revoke' | 'me'>
  /** The sign-in as this browser keeps it. */
  record: { get(): Promise<unknown>; put(value: unknown): Promise<void>; remove(): Promise<void> }
  /** This tab's, for the sign-in under way. */
  session: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  /** Runs `work` while no other tab of the page runs its own. */
  lock<T>(work: () => Promise<T>): Promise<T>
  page: Pick<Location, 'origin' | 'pathname' | 'href'> & { assign(url: string): void }
  /** Tells the other tabs the sign-in changed; `changed` hears theirs. */
  broadcast(): void
  changed(listener: () => void): void
}

function browserEnv(accountUrl: string): AccountEnv {
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)
  return {
    api: new AccountApi(accountUrl, (url, init) => fetch(url, init)),
    record: {
      get: () => run('readonly', (store) => store.get(RECORD), HOSTED_STORE),
      put: async (value) => {
        await run('readwrite', (store) => store.put(value, RECORD), HOSTED_STORE)
      },
      remove: async () => {
        await run('readwrite', (store) => store.delete(RECORD), HOSTED_STORE)
      },
    },
    session: sessionStorage,
    lock: (work) => (navigator.locks ? navigator.locks.request(LOCK, work) : work()),
    page: {
      origin: location.origin,
      pathname: location.pathname,
      href: location.href,
      assign: (url) => location.assign(url),
    },
    broadcast: () => channel?.postMessage('changed'),
    changed: (listener) => {
      if (channel) channel.onmessage = listener
    },
  }
}

function random(bytes: number): string {
  return encodeRelayBytes(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** The S256 challenge of a code verifier (RFC 7636). */
export async function challengeOf(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return encodeRelayBytes(new Uint8Array(digest))
}

function isStored(value: unknown): value is Stored {
  const record = value as Partial<Stored> | null
  return (
    typeof record?.refreshToken === 'string' &&
    typeof record.profile?.id === 'string' &&
    typeof record.profile.email === 'string'
  )
}

function readPending(session: AccountEnv['session']): Pending | null {
  try {
    const value = JSON.parse(session.getItem(PENDING_KEY) ?? 'null') as Partial<Pending>
    if (typeof value?.verifier !== 'string' || typeof value.state !== 'string') return null
    return { verifier: value.verifier, state: value.state, back: value.back ?? '/' }
  } catch {
    return null
  }
}

/** A path of this page to go back to, never another site. */
function samePage(back: string): string {
  return back.startsWith('/') && !back.startsWith('//') ? back : '/'
}

export class HostedAccount {
  private readonly env: AccountEnv
  private readonly api: AccountEnv['api']
  private stored: Stored | null = null
  private access: { token: string; expiresAt: number } | null = null
  private signedOut: { reason: SignedOutReason | null; failure: SignInFailure | null } = {
    reason: null,
    failure: null,
  }
  private signingIn = false
  private readonly listeners = new Set<(status: AccountStatus) => void>()

  constructor(private readonly options: HostedAccountOptions) {
    this.env = options.env ?? browserEnv(options.accountUrl)
    this.api = this.env.api
  }

  /** Another tab signed out or in; it is told once, after `load`. */
  onOtherTab(listener: () => void): void {
    this.env.changed(listener)
  }

  get accountId(): string | null {
    return this.stored?.profile.id ?? null
  }

  /** Reads what is kept; on the callback's page, finishes the sign-in first. Where to go next. */
  async load(): Promise<string | null> {
    this.stored = await this.read()
    if (this.env.page.pathname !== CALLBACK_PATH) return null
    return this.finish(new URL(this.env.page.href))
  }

  status(): AccountStatus {
    if (this.signingIn) return { state: 'signing-in' }
    const stored = this.stored
    if (!stored) {
      const devicesUrl =
        this.signedOut.failure === 'device-limit' ? this.page('/account/devices/') : undefined
      return { state: 'signed-out', ...this.signedOut, ...(devicesUrl ? { devicesUrl } : {}) }
    }
    const profile: AccountProfile = {
      id: stored.profile.id,
      email: stored.profile.email,
      name: stored.profile.name,
      avatar: stored.profile.avatarUrl,
    }
    return {
      state: 'signed-in',
      account: profile,
      subscription: stored.subscription,
      plan: stored.plan,
      usage: stored.usage,
      manageUrl: this.page('/account/'),
      plainText: false,
    }
  }

  onChanged(listener: (status: AccountStatus) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Goes to the website's sign-in page; the browser comes back to CALLBACK_PATH. */
  async signIn(back = '/'): Promise<AccountStatus> {
    const verifier = random(32)
    const state = random(24)
    const pending: Pending = { verifier, state, back: samePage(back) }
    this.env.session.setItem(PENDING_KEY, JSON.stringify(pending))
    const url = new URL(this.page('/signin/app/'))
    url.search = new URLSearchParams({
      client_id: WEB_CLIENT,
      redirect_uri: `${this.env.page.origin}${CALLBACK_PATH}`,
      code_challenge: await challengeOf(verifier),
      code_challenge_method: 'S256',
      state,
      client_info: JSON.stringify(
        clientInfo({ kind: 'web', arch: 'unknown', ...this.options.client }),
      ),
    }).toString()
    this.signingIn = true
    this.emit()
    this.env.page.assign(url.href)
    return this.status()
  }

  /** Reads the account again; a sign-in the service ended comes back signed out, saying why. */
  async check(): Promise<AccountStatus> {
    for (let tries = 0; tries < 2; tries++) {
      const token = await this.accessToken()
      if (!token || !this.stored) return this.status()
      try {
        await this.keep(this.stored.refreshToken, await this.api.me(token))
        return this.status()
      } catch (error) {
        // An access token the service no longer takes, as once the client was signed out from the
        // account page: a refresh then says why, or gets a new one.
        if (error instanceof AccountServiceError && error.status === 401 && tries === 0) {
          this.access = null
          continue
        }
        await this.failed(error)
        return this.status()
      }
    }
    return this.status()
  }

  /**
   * An access token for the relay, refreshed when needed; null while signed out, or when none can
   * be had now, as without the network. A sign-in the service ended signs out here.
   */
  async accessToken(): Promise<string | null> {
    if (!this.stored) return null
    if (this.access && this.access.expiresAt > Date.now()) return this.access.token
    try {
      return await this.refresh()
    } catch (error) {
      await this.failed(error)
      return null
    }
  }

  /** Signs out at the service, then forgets the sign-in here, even when the service is away. */
  async signOut(): Promise<AccountStatus> {
    const stored = this.stored
    if (stored) {
      await this.env.lock(async () => {
        const kept = await this.read()
        await this.api.revoke(WEB_CLIENT, kept?.refreshToken ?? stored.refreshToken).catch(() => {})
      })
    }
    await this.forget(null)
    return this.status()
  }

  private async finish(url: URL): Promise<string> {
    const pending = readPending(this.env.session)
    this.env.session.removeItem(PENDING_KEY)
    const back = pending?.back ?? '/'
    const code = url.searchParams.get('code')
    if (!pending || url.searchParams.get('state') !== pending.state) return back
    if (!code) {
      // Cancelled on the website, or stopped there with the account's devices full.
      if (url.searchParams.get('error') === DEVICE_LIMIT) {
        this.signedOut = { reason: null, failure: 'device-limit' }
      }
      return back
    }
    try {
      const tokens = await this.api.exchangeCode({
        code,
        redirectUri: `${this.env.page.origin}${CALLBACK_PATH}`,
        verifier: pending.verifier,
        clientId: WEB_CLIENT,
      })
      await this.signedIn(tokens)
    } catch (error) {
      this.signedOut = { reason: null, failure: signInFailure(error) }
      this.emit()
    }
    return back
  }

  private async signedIn(tokens: TokenSet): Promise<void> {
    const me = await this.api.me(tokens.accessToken)
    this.access = { token: tokens.accessToken, expiresAt: tokens.accessExpiresAt }
    this.signedOut = { reason: null, failure: null }
    await this.keep(tokens.refreshToken, me)
    this.env.broadcast()
  }

  private async refresh(): Promise<string | null> {
    return this.env.lock(async () => {
      // Another tab may have used the token since this one read it.
      const kept = await this.read()
      if (!kept) {
        this.stored = null
        this.emit()
        return null
      }
      const tokens = await this.api.refresh(WEB_CLIENT, kept.refreshToken)
      this.access = { token: tokens.accessToken, expiresAt: tokens.accessExpiresAt }
      const next: Stored = { ...kept, refreshToken: tokens.refreshToken }
      await this.env.record.put(next)
      this.stored = next
      return tokens.accessToken
    })
  }

  private async keep(refreshToken: string, me: Me): Promise<void> {
    const avatar = me.account.avatarUrl
    const avatarUrl = avatar ? new URL(avatar, this.options.accountUrl).href : null
    const next: Stored = {
      refreshToken,
      profile: { ...me.account, avatarUrl },
      subscription: me.subscription,
      plan: me.plan,
      usage: me.usage,
    }
    await this.env.record.put(next)
    this.stored = next
    this.emit()
  }

  /** A refused refresh signs out, with the service's reason; anything else keeps the sign-in. */
  private async failed(error: unknown): Promise<void> {
    if (!(error instanceof AccountServiceError)) return
    if (error.code !== 'invalid_grant' && error.code !== 'account_disabled') return
    await this.forget(
      error.code === 'account_disabled' ? 'disabled' : signedOutReason(error.reason),
    )
  }

  private async forget(reason: SignedOutReason | null): Promise<void> {
    await this.env.record.remove().catch(() => undefined)
    this.stored = null
    this.access = null
    this.signedOut = { reason, failure: null }
    this.emit()
    this.env.broadcast()
  }

  private async read(): Promise<Stored | null> {
    const value = await this.env.record.get()
    return isStored(value) ? value : null
  }

  private page(path: string): string {
    return `${this.options.accountUrl}${this.options.locale() === 'zh-CN' ? '/zh-CN' : ''}${path}`
  }

  private emit(): void {
    const status = this.status()
    for (const listener of this.listeners) listener(status)
  }
}
