// The HTTP interface of the Kettu account service that the desktop app and the daemon speak: the
// OAuth 2.0 endpoints of public native clients (RFC 6749, 7009, 8252, 8628) and the account.

import { createHash, randomBytes } from 'node:crypto'

export const ACCOUNT_URL = 'https://www.kettu.sh'
/** Points a development run at another copy of the service and its pages. */
export const ACCOUNT_URL_ENV = 'KETTU_ACCOUNT_URL'

export const DESKTOP_CLIENT = 'kettu-desktop'
export const DAEMON_CLIENT = 'kettu-daemon'

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const TIMEOUT_MS = 15_000
// An access token is treated as expired this long before the service says, for clock drift.
const EXPIRY_MARGIN_MS = 60_000
const MAX_NAME = 100
const MAX_FIELD = 40

export type AccountFetch = (url: string, init: RequestInit) => Promise<Response>

/** The website and its API, as `KETTU_ACCOUNT_URL` or the project's own. */
export function accountBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env[ACCOUNT_URL_ENV]?.trim()
  if (!raw) return ACCOUNT_URL
  const url = URL.parse(raw)
  if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:') || url.search || url.hash) {
    throw new Error(`${ACCOUNT_URL_ENV} must be an http or https URL without a query`)
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

/** How the account page lists this client. */
export interface ClientInfo {
  kind: 'desktop' | 'daemon'
  name: string
  os: string
  arch: string
  version: string | null
}

/** Cuts each field to what the service takes. */
export function clientInfo(info: ClientInfo): ClientInfo {
  const cut = (text: string, max: number): string => text.trim().slice(0, max) || 'unknown'
  return {
    kind: info.kind,
    name: cut(info.name, MAX_NAME),
    os: cut(info.os, MAX_FIELD),
    arch: cut(info.arch, MAX_FIELD),
    version: info.version ? info.version.slice(0, MAX_FIELD) : null,
  }
}

export interface Pkce {
  verifier: string
  challenge: string
}

/** A code verifier of 43 characters and its S256 challenge (RFC 7636). */
export function newPkce(): Pkce {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export function newState(): string {
  return randomBytes(24).toString('base64url')
}

export interface TokenSet {
  accessToken: string
  refreshToken: string
  /** When to stop using the access token, in Unix milliseconds. */
  accessExpiresAt: number
}

export interface Me {
  account: { id: string; email: string; name: string | null; avatarUrl: string | null }
  subscription: string
}

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string | null
  /** Seconds the code is valid. */
  expiresIn: number
  /** Seconds to wait between polls. */
  interval: number
}

/** An answer the service gave, by its stable code. */
export class AccountServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    /** Why `invalid_grant` signed the client out, when the service says. */
    readonly reason: string | null = null,
    /** The interval `slow_down` asks for, in seconds. */
    readonly interval: number | null = null,
  ) {
    super(message)
    this.name = 'AccountServiceError'
  }
}

/** The service could not be reached, or did not answer in time. */
export class AccountNetworkError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccountNetworkError'
  }
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    return text ? record(JSON.parse(text)) : null
  } catch {
    return null
  }
}

export class AccountApi {
  constructor(
    readonly base: string,
    private readonly fetch: AccountFetch,
    private readonly now: () => number = Date.now,
  ) {}

  exchangeCode(input: { code: string; redirectUri: string; verifier: string }): Promise<TokenSet> {
    return this.token({
      grant_type: 'authorization_code',
      client_id: DESKTOP_CLIENT,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    })
  }

  refresh(clientId: string, refreshToken: string): Promise<TokenSet> {
    return this.token({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
    })
  }

  pollDevice(deviceCode: string): Promise<TokenSet> {
    return this.token({
      grant_type: DEVICE_GRANT,
      client_id: DAEMON_CLIENT,
      device_code: deviceCode,
    })
  }

  async startDevice(info: ClientInfo): Promise<DeviceCode> {
    const body = await this.form('/api/oauth/device', {
      client_id: DAEMON_CLIENT,
      client_info: JSON.stringify(clientInfo(info)),
    })
    const { device_code, user_code, verification_uri, verification_uri_complete } = body
    const { expires_in, interval } = body
    if (
      !isText(device_code) ||
      !isText(user_code) ||
      !isText(verification_uri) ||
      typeof expires_in !== 'number' ||
      typeof interval !== 'number'
    ) {
      throw this.unexpected('/api/oauth/device')
    }
    return {
      deviceCode: device_code,
      userCode: user_code,
      verificationUri: verification_uri,
      verificationUriComplete: isText(verification_uri_complete) ? verification_uri_complete : null,
      expiresIn: expires_in,
      interval: Math.max(1, interval),
    }
  }

  /** Signs the client out at the service, revoking the token's whole family (RFC 7009). */
  async revoke(clientId: string, token: string): Promise<void> {
    await this.request('/api/oauth/revoke', {
      method: 'POST',
      body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: clientId }),
    })
  }

  async me(accessToken: string): Promise<Me> {
    const body = await this.request('/api/v1/me', {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    })
    const account = record(body?.account)
    const subscription = record(body?.subscription)
    const name = account?.name
    const avatarUrl = account?.avatarUrl
    if (
      !account ||
      !isText(account.id) ||
      !isText(account.email) ||
      (name !== null && typeof name !== 'string') ||
      (avatarUrl !== null && typeof avatarUrl !== 'string') ||
      !isText(subscription?.status)
    ) {
      throw this.unexpected('/api/v1/me')
    }
    return {
      account: {
        id: account.id,
        email: account.email,
        name: name || null,
        avatarUrl: avatarUrl || null,
      },
      subscription: subscription.status,
    }
  }

  private async token(fields: Record<string, string>): Promise<TokenSet> {
    const body = await this.form('/api/oauth/token', fields)
    const { access_token, refresh_token, expires_in } = body
    if (!isText(access_token) || !isText(refresh_token) || typeof expires_in !== 'number') {
      throw this.unexpected('/api/oauth/token')
    }
    return {
      accessToken: access_token,
      refreshToken: refresh_token,
      accessExpiresAt: this.now() + Math.max(0, expires_in * 1000 - EXPIRY_MARGIN_MS),
    }
  }

  private async form(path: string, fields: Record<string, string>) {
    const body = await this.request(path, { method: 'POST', body: new URLSearchParams(fields) })
    if (!body) throw this.unexpected(path)
    return body
  }

  /** The answer's JSON, null for an empty one; any error the service gives as `AccountServiceError`. */
  private async request(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    let response: Response
    try {
      response = await this.fetch(`${this.base}${path}`, {
        ...init,
        headers: { accept: 'application/json', ...init.headers },
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      throw new AccountNetworkError(`Could not reach ${this.base}: ${(error as Error).message}`)
    }
    const text = await response.text().catch(() => '')
    const body = parseJson(text)
    if (response.ok) {
      if (text && !body) throw this.unexpected(path)
      return body
    }
    const code = body?.error
    if (!isText(code)) {
      throw new AccountServiceError(
        'server_error',
        `${path} answered ${response.status}`,
        response.status,
      )
    }
    const message = body?.error_description ?? body?.message
    throw new AccountServiceError(
      code,
      typeof message === 'string' ? message : code,
      response.status,
      isText(body?.reason) ? body.reason : null,
      typeof body?.interval === 'number' ? body.interval : null,
    )
  }

  private unexpected(path: string): AccountServiceError {
    return new AccountServiceError('server_error', `${path} gave an answer Kettu cannot read`, 200)
  }
}
