// The desktop app's Kettu account: signing in through the system browser with a loopback redirect
// and PKCE (RFC 8252), refreshing tokens when needed, and signing out. Main alone holds the tokens:
// the access token only in memory, the refresh token as `store.ts` keeps it.

import type { AccountStatus, SignedOutReason, SignInFailure } from '@shared/account'
import type { Locale } from '@shared/locale'
import type { Logger } from '../log'
import type { IdentityCipher } from '../remote-identity'
import { listenLoopback, type Loopback } from './loopback'
import {
  AccountNetworkError,
  AccountServiceError,
  DESKTOP_CLIENT,
  newPkce,
  newState,
  type AccountApi,
  type ClientInfo,
  type Me,
  type TokenSet,
} from './service'
import {
  openToken,
  readAccount,
  removeAccount,
  sealToken,
  writeAccount,
  type StoredAccount,
} from './store'

/** How long the browser has to come back before the loopback port closes. */
export const SIGN_IN_TIMEOUT_MS = 10 * 60_000

export interface AccountOptions {
  file: string
  api: AccountApi
  cipher: IdentityCipher
  clientInfo: () => Promise<ClientInfo>
  locale: () => Locale
  openBrowser: (url: string) => Promise<void>
  bringToFront: () => void
  /** The picture at an avatar URL as a data: URL; null when it is none or did not load. */
  avatar: (url: string) => Promise<string | null>
  /** What the browser shows when the sign-in failed after it came back to Kettu. */
  failureText: () => string
  changed: (status: AccountStatus) => void
  log: Logger
  timeoutMs?: number
  now?: () => number
}

/** The stored sign-in went while a request was out, as by Sign out. */
class SignedOut extends Error {}

/** The refresh token could not be decrypted, as in a data folder copied from another computer. */
class TokenUnreadable extends Error {}

/** Why the service signed this client out, from the `reason` of its `invalid_grant`. */
export function signedOutReason(reason: string | null): SignedOutReason {
  switch (reason) {
    case 'signed_out_from_account_page':
      return 'account-page'
    case 'signed_out_by_admin':
      return 'admin'
    case 'account_disabled':
      return 'disabled'
    case 'refresh_token_reused':
    case 'authorization_code_reused':
      return 'reused'
    case 'expired':
      return 'expired'
    default:
      return 'invalid'
  }
}

function failureOf(error: unknown): SignInFailure {
  if (error instanceof AccountNetworkError) return 'network'
  if (error instanceof AccountServiceError) {
    return error.code === 'account_disabled' || error.reason === 'account_disabled'
      ? 'disabled'
      : 'service'
  }
  return 'local'
}

export class Account {
  private access: { token: string; expiresAt: number } | null = null
  private refreshing: Promise<string> | null = null
  private signingIn: Loopback | null = null
  private signedOut: { reason: SignedOutReason | null; failure: SignInFailure | null } = {
    reason: null,
    failure: null,
  }
  private avatar: { url: string; picture: string | null } | null = null
  /** Changes whenever the stored sign-in is replaced or forgotten, so late answers are dropped. */
  private generation = 0
  private readonly now: () => number

  private constructor(
    private readonly options: AccountOptions,
    private stored: StoredAccount | null,
  ) {
    this.now = options.now ?? Date.now
  }

  /** Reads the stored sign-in, without the network or decrypting its token. */
  static async load(options: AccountOptions): Promise<Account> {
    const stored = await readAccount(options.file, (message) => options.log.warn(message)).catch(
      (error: unknown) => {
        options.log.error(`Could not read ${options.file}`, error)
        return null
      },
    )
    return new Account(options, stored)
  }

  status(): AccountStatus {
    if (this.signingIn) return { state: 'signing-in' }
    const stored = this.stored
    if (!stored) return { state: 'signed-out', ...this.signedOut }
    const avatar = this.avatar?.url === stored.profile.avatarUrl ? this.avatar.picture : null
    return {
      state: 'signed-in',
      account: {
        id: stored.profile.id,
        email: stored.profile.email,
        name: stored.profile.name,
        avatar,
      },
      subscription: stored.subscription,
      manageUrl: this.page('/account/'),
      plainText: stored.plainText,
    }
  }

  /**
   * Reads the account again, refreshing the access token when needed, as Settings › Account does
   * when it shows. A sign-in the service ended signs out here and says why.
   */
  async check(): Promise<AccountStatus> {
    if (!this.stored || this.signingIn) return this.status()
    const generation = this.generation
    try {
      const me = await this.withToken((token) => this.options.api.me(token))
      if (generation === this.generation) await this.update(me)
    } catch (error) {
      await this.failed(error)
    }
    this.loadAvatar()
    return this.status()
  }

  /**
   * Opens the browser at the sign-in page and resolves once it opened; the browser hands back to
   * the loopback port later, and the status follows.
   */
  async signIn(): Promise<AccountStatus> {
    if (this.signingIn || this.stored) return this.status()
    const pkce = newPkce()
    const state = newState()
    let loopback: Loopback
    try {
      loopback = await listenLoopback({
        state,
        timeoutMs: this.options.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
      })
    } catch (error) {
      this.options.log.error('Could not listen for the sign-in to come back', error)
      return this.fail('local')
    }
    this.signingIn = loopback
    this.signedOut = { reason: null, failure: null }
    this.emit()
    const url = new URL(this.page('/signin/app/'))
    url.search = new URLSearchParams({
      client_id: DESKTOP_CLIENT,
      redirect_uri: loopback.redirectUri,
      code_challenge: pkce.challenge,
      code_challenge_method: 'S256',
      state,
      client_info: JSON.stringify(await this.options.clientInfo()),
    }).toString()
    try {
      await this.options.openBrowser(url.href)
    } catch (error) {
      this.options.log.error('Could not open the browser to sign in', error)
      this.signingIn = null
      loopback.close()
      return this.fail('local')
    }
    void loopback.result.then((result) => this.cameBack(loopback, result, pkce.verifier))
    return this.status()
  }

  cancelSignIn(): void {
    const loopback = this.signingIn
    if (!loopback) return
    this.signingIn = null
    loopback.close()
    this.emit()
  }

  /** Signs out at the service, then forgets the sign-in here, even when the service is away. */
  async signOut(): Promise<AccountStatus> {
    if (this.signingIn) {
      this.cancelSignIn()
      return this.status()
    }
    // After a refresh in flight, so the token revoked is the newest.
    await this.refreshing?.catch(() => undefined)
    const stored = this.stored
    if (!stored) return this.status()
    try {
      await this.options.api.revoke(DESKTOP_CLIENT, await openToken(stored, this.options.cipher))
    } catch (error) {
      this.options.log.warn(
        `Signed out here, but could not sign out at the account service: ${(error as Error).message}`,
      )
    }
    if (this.stored === stored) await this.forget(null)
    return this.status()
  }

  stop(): void {
    this.cancelSignIn()
  }

  private async cameBack(
    loopback: Loopback,
    result: Awaited<Loopback['result']>,
    verifier: string,
  ): Promise<void> {
    if (this.signingIn !== loopback) return
    switch (result.kind) {
      case 'closed':
        return
      case 'timeout':
        this.signingIn = null
        this.fail('timeout')
        return
      case 'denied':
        loopback.answer({ location: this.page('/signin/app/?cancelled=1') })
        this.signingIn = null
        this.emit()
        this.options.bringToFront()
        return
      case 'error':
        this.options.log.warn(`The sign-in came back with ${result.error}`)
        loopback.answer({ status: 400, text: this.options.failureText() })
        this.signingIn = null
        this.fail('service')
        this.options.bringToFront()
        return
      case 'code':
        break
    }
    const { api } = this.options
    let tokens: TokenSet | null = null
    try {
      tokens = await api.exchangeCode({
        code: result.code,
        redirectUri: loopback.redirectUri,
        verifier,
      })
      const me = await api.me(tokens.accessToken)
      // Cancelled while the code was exchanged: the new sign-in is ended at once.
      if (this.signingIn !== loopback) throw new SignedOut()
      await this.keep(tokens, me)
    } catch (error) {
      if (tokens) void api.revoke(DESKTOP_CLIENT, tokens.refreshToken).catch(() => undefined)
      if (error instanceof SignedOut) return
      this.options.log.error('Could not finish signing in', error)
      loopback.answer({ status: 502, text: this.options.failureText() })
      this.signingIn = null
      this.fail(failureOf(error))
      this.options.bringToFront()
      return
    }
    loopback.answer({ location: this.page('/signin/app/?done=1') })
    this.signingIn = null
    this.loadAvatar()
    this.emit()
    this.options.bringToFront()
  }

  /** A page of the website, in the app's language. */
  private page(path: string): string {
    const prefix = this.options.locale() === 'zh-CN' ? '/zh-CN' : ''
    return `${this.options.api.base}${prefix}${path}`
  }

  private async keep(tokens: TokenSet, me: Me): Promise<void> {
    const stored: StoredAccount = {
      profile: me.account,
      subscription: me.subscription,
      ...(await sealToken(tokens.refreshToken, this.options.cipher)),
    }
    await writeAccount(this.options.file, stored)
    this.generation++
    this.stored = stored
    this.access = { token: tokens.accessToken, expiresAt: tokens.accessExpiresAt }
  }

  /** The account as the service has it now, kept when it changed. */
  private async update(me: Me): Promise<void> {
    const stored = this.stored
    if (!stored) return
    const { profile, subscription } = stored
    if (
      profile.id === me.account.id &&
      profile.email === me.account.email &&
      profile.name === me.account.name &&
      profile.avatarUrl === me.account.avatarUrl &&
      subscription === me.subscription
    ) {
      return
    }
    const next = { ...stored, profile: me.account, subscription: me.subscription }
    this.stored = next
    this.emit()
    await writeAccount(this.options.file, next).catch((error: unknown) =>
      this.options.log.error(`Could not write ${this.options.file}`, error),
    )
  }

  /** Runs `call` with an access token, refreshing it once more if the service refused it. */
  private async withToken<T>(call: (token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken(null)
    try {
      return await call(token)
    } catch (error) {
      if (!(error instanceof AccountServiceError) || error.code !== 'invalid_token') throw error
      return call(await this.accessToken(token))
    }
  }

  /** The access token, refreshed when it expired or is the one the service just refused. */
  private accessToken(refused: string | null): Promise<string> {
    const access = this.access
    if (access && access.token !== refused && access.expiresAt > this.now()) {
      return Promise.resolve(access.token)
    }
    // One refresh at a time: each use of the refresh token replaces it, and a second use of the
    // old one makes the service sign this client out.
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async refresh(): Promise<string> {
    const stored = this.stored
    if (!stored) throw new SignedOut()
    const generation = this.generation
    let token: string
    try {
      token = await openToken(stored, this.options.cipher)
    } catch (error) {
      throw new TokenUnreadable((error as Error).message)
    }
    const tokens = await this.options.api.refresh(DESKTOP_CLIENT, token)
    if (generation !== this.generation || !this.stored) {
      void this.options.api.revoke(DESKTOP_CLIENT, tokens.refreshToken).catch(() => undefined)
      throw new SignedOut()
    }
    const next = { ...this.stored, ...(await sealToken(tokens.refreshToken, this.options.cipher)) }
    this.stored = next
    this.access = { token: tokens.accessToken, expiresAt: tokens.accessExpiresAt }
    // If this write fails, the next run sends the old token, which signs this client out.
    await writeAccount(this.options.file, next).catch((error: unknown) =>
      this.options.log.error(`Could not write ${this.options.file}`, error),
    )
    return tokens.accessToken
  }

  private async failed(error: unknown): Promise<void> {
    if (error instanceof SignedOut) return
    if (error instanceof TokenUnreadable) {
      this.options.log.error(`The sign-in in ${this.options.file} cannot be decrypted`, error)
      await this.forget('invalid')
      return
    }
    if (error instanceof AccountServiceError) {
      if (error.code === 'invalid_grant') {
        this.options.log.warn(`The account service ended the sign-in: ${error.message}`)
        await this.forget(signedOutReason(error.reason))
        return
      }
      if (error.code === 'account_disabled') {
        await this.forget('disabled')
        return
      }
      // Refused right after a refresh: the service no longer knows this sign-in.
      if (error.code === 'invalid_token') {
        await this.forget('invalid')
        return
      }
    }
    this.options.log.warn(`Could not read the account: ${(error as Error).message}`)
  }

  private async forget(reason: SignedOutReason | null): Promise<void> {
    this.generation++
    this.stored = null
    this.access = null
    this.avatar = null
    this.signedOut = { reason, failure: null }
    this.emit()
    await removeAccount(this.options.file).catch((error: unknown) =>
      this.options.log.error(`Could not remove ${this.options.file}`, error),
    )
  }

  private fail(failure: SignInFailure): AccountStatus {
    this.signedOut = { reason: null, failure }
    this.emit()
    return this.status()
  }

  private loadAvatar(): void {
    const url = this.stored?.profile.avatarUrl ?? null
    if (!url) {
      this.avatar = null
      return
    }
    if (this.avatar?.url === url) return
    this.avatar = { url, picture: null }
    void this.options.avatar(url).then((picture) => {
      if (this.avatar?.url !== url || !picture) return
      this.avatar = { url, picture }
      this.emit()
    })
  }

  private emit(): void {
    this.options.changed(this.status())
  }
}
