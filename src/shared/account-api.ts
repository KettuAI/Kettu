// The HTTP interface of the Kettu account service that Kettu's clients speak: the OAuth 2.0
// endpoints of its public clients (RFC 6749, 7009, 8252, 8628) and the account. Imports nothing of
// Node.js, since the hosted web client speaks it too.

import type { AccountPlan, AccountUsage, SignedOutReason, SignInFailure } from '@shared/account'
import { REPORT_ID, type ReportSubmitFailure } from '@shared/report'

export const ACCOUNT_URL = 'https://www.kettu.sh'

export const DESKTOP_CLIENT = 'kettu-desktop'
export const DAEMON_CLIENT = 'kettu-daemon'
export const WEB_CLIENT = 'kettu-web'

const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const TIMEOUT_MS = 15_000
/** A report's bundle on a slow connection. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000
// An access token is treated as expired this long before the service says, for clock drift.
const EXPIRY_MARGIN_MS = 60_000
const MAX_NAME = 100
const MAX_FIELD = 40

export type AccountFetch = (url: string, init: RequestInit) => Promise<Response>

/** How the account page lists this client. */
export interface ClientInfo {
  kind: 'desktop' | 'daemon' | 'web'
  name: string
  os: string
  arch: string
  version: string | null
  /** The system user signing in, which the daemon's confirm page names. */
  user?: string
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
    ...(info.user?.trim() ? { user: cut(info.user, MAX_FIELD) } : {}),
  }
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
  /** Null from a service that does not report them. */
  plan: AccountPlan | null
  usage: AccountUsage | null
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

/** A problem report as it is submitted: the bundle the user reviewed, and what it is about. */
export interface ReportUpload {
  bundle: Uint8Array<ArrayBuffer>
  description: string
  version: string
  /** The system and its version, then the architecture. */
  platform: string
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

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function planOf(value: unknown): AccountPlan | null {
  const plan = record(value)
  if (!plan || !isText(plan.id) || !isText(plan.name)) return null
  if (!isCount(plan.maxDevices) || !isCount(plan.storageBytes)) return null
  return {
    id: plan.id,
    name: plan.name,
    maxDevices: plan.maxDevices,
    storageBytes: plan.storageBytes,
  }
}

function usageOf(value: unknown): AccountUsage | null {
  const usage = record(value)
  if (!usage || !isCount(usage.devices) || !isCount(usage.storageBytes)) return null
  return { devices: usage.devices, storageBytes: usage.storageBytes }
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

  exchangeCode(input: {
    code: string
    redirectUri: string
    verifier: string
    clientId?: string
  }): Promise<TokenSet> {
    return this.token({
      grant_type: 'authorization_code',
      client_id: input.clientId ?? DESKTOP_CLIENT,
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
      plan: planOf(body?.plan),
      usage: usageOf(body?.usage),
    }
  }

  /** Submits a problem report; the id it was given, such as KR-7F3K2Q. */
  async submitReport(accessToken: string, upload: ReportUpload): Promise<string> {
    const form = new FormData()
    form.set('bundle', new Blob([upload.bundle], { type: 'application/zip' }), 'report.zip')
    form.set('description', upload.description)
    form.set('version', upload.version)
    form.set('platform', upload.platform)
    const body = await this.request(
      '/api/v1/reports',
      { method: 'POST', headers: { authorization: `Bearer ${accessToken}` }, body: form },
      UPLOAD_TIMEOUT_MS,
    )
    const id = body?.id
    if (typeof id !== 'string' || !REPORT_ID.test(id)) throw this.unexpected('/api/v1/reports')
    return id
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
  private async request(
    path: string,
    init: RequestInit,
    timeoutMs = TIMEOUT_MS,
  ): Promise<Record<string, unknown> | null> {
    let response: Response
    try {
      response = await this.fetch(`${this.base}${path}`, {
        ...init,
        headers: { accept: 'application/json', ...init.headers },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
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

/** Why a report was not submitted, as the dialog and `kettu report` say it. */
export function submitFailure(error: unknown): ReportSubmitFailure {
  if (error instanceof AccountNetworkError) return 'network'
  if (!(error instanceof AccountServiceError)) return 'failed'
  switch (error.code) {
    case 'report_too_large':
      return 'too_large'
    case 'rate_limited':
      return 'rate_limited'
    case 'unauthorized':
    case 'invalid_token':
    case 'invalid_grant':
    case 'account_disabled':
      return 'unauthorized'
    default:
      return 'failed'
  }
}

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

/** The service's answer when the account's plan allows no more signed-in clients. */
export const DEVICE_LIMIT = 'device_limit'

/** Why a sign-in did not finish, from the error the service or the network gave. */
export function signInFailure(error: unknown): SignInFailure {
  if (error instanceof AccountNetworkError) return 'network'
  if (error instanceof AccountServiceError) {
    if (error.code === DEVICE_LIMIT) return 'device-limit'
    return error.code === 'account_disabled' || error.reason === 'account_disabled'
      ? 'disabled'
      : 'service'
  }
  return 'local'
}
