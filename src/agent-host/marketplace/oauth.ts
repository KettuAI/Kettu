// Signing in to a remote MCP server: asking it whether it needs a sign-in at all, the browser flow
// through the MCP SDK's client auth (discovery, dynamic registration, PKCE and the code exchange,
// back on a loopback port of its own), the device flow of an app Kettu registered with a service
// that registers no clients, and renewing a token. What it yields is kept by main, encrypted, as
// an opaque text only the agent host reads.

import { randomBytes } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import { addLogSecret } from '@shared/log/process-log'

/** A sign-in as main keeps it, by server id. */
export interface SignIn {
  v: 1
  /** The server address it belongs to; a server that moved needs a new one. */
  url: string
  /** When the agent host last changed it, so an older copy from main never replaces it. */
  savedAt: number
  /** `open`: the server needs no sign-in; agents reach it directly. */
  kind: 'open' | 'browser' | 'device'
  account: string | null
  /** Why it needs signing in again: its token was refused and could not be renewed. */
  reconnect?: string
  /** The authorization server that issued the tokens. */
  issuer?: string
  /** The RFC 8707 resource the tokens are for. */
  resource?: string
  client?: { client_id: string; client_secret?: string }
  tokens?: { access: string; refresh?: string; expiresAt?: number; type: string; scope?: string }
}

// The OAuth App Kettu registered with each service that registers no clients itself. Device flow
// clients are public: the id is no secret.
const DEVICE_CLIENTS: Readonly<Record<string, string>> = {
  'https://github.com/login/oauth': 'Ov23liLvsqnYGSdgcs3U',
}
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const PROTOCOL_VERSION = '2025-06-18'
export const LOGIN_MS = 5 * 60_000
const REQUEST_MS = 15_000
const MAX_TEXT = 256 * 1024

type Fetch = typeof fetch

function loadAuth() {
  return Promise.all([
    import('@modelcontextprotocol/sdk/client/auth.js'),
    import('@modelcontextprotocol/sdk/shared/auth-utils.js'),
  ]).then(([auth, utils]) => ({ ...auth, ...utils }))
}

/** A fetch whose requests give up after a while, for the sign-in's own requests. */
export function timedFetch(fetcher: Fetch = fetch, ms = REQUEST_MS): Fetch {
  return ((input: Parameters<Fetch>[0], init?: RequestInit) =>
    fetcher(input, {
      ...init,
      signal: init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)])
        : AbortSignal.timeout(ms),
    })) as Fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT
    ? value
    : undefined
}

// Bounds on what main sends, which it checks too; a push past them is dropped whole.
const MAX_SIGN_INS = 1_000
const MAX_SIGN_IN_CHARS = 64 * 1024

/** `host:market-keys`' sign-ins by server id, or null when they are not texts by id. */
export function parseSignIns(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null
  const entries = Object.entries(value)
  if (entries.length > MAX_SIGN_INS) return null
  for (const [id, state] of entries) {
    if (id.length === 0 || id.length > 256) return null
    if (typeof state !== 'string' || state.length > MAX_SIGN_IN_CHARS) return null
  }
  return Object.fromEntries(entries) as Record<string, string>
}

/** A kept sign-in, or null when it is not one this host wrote. */
export function parseSignIn(json: string): SignIn | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(value) || value.v !== 1) return null
  const url = text(value.url)
  const kind = value.kind
  if (!url || (kind !== 'open' && kind !== 'browser' && kind !== 'device')) return null
  if (typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return null
  const sign: SignIn = {
    v: 1,
    url,
    savedAt: value.savedAt,
    kind,
    account: text(value.account) ?? null,
  }
  const reconnect = text(value.reconnect)
  if (reconnect) sign.reconnect = reconnect
  const issuer = text(value.issuer)
  if (issuer) sign.issuer = issuer
  const resource = text(value.resource)
  if (resource) sign.resource = resource
  if (isRecord(value.client) && text(value.client.client_id)) {
    const secret = text(value.client.client_secret)
    sign.client = {
      client_id: value.client.client_id as string,
      ...(secret ? { client_secret: secret } : {}),
    }
  }
  const tokens = value.tokens
  if (isRecord(tokens) && text(tokens.access)) {
    const refresh = text(tokens.refresh)
    const scope = text(tokens.scope)
    sign.tokens = {
      access: tokens.access as string,
      type: text(tokens.type) ?? 'Bearer',
      ...(refresh ? { refresh } : {}),
      ...(typeof tokens.expiresAt === 'number' ? { expiresAt: tokens.expiresAt } : {}),
      ...(scope ? { scope } : {}),
    }
  }
  if (kind !== 'open' && !sign.tokens) return null
  for (const secret of [sign.tokens?.access, sign.tokens?.refresh, sign.client?.client_secret]) {
    if (secret) addLogSecret(secret)
  }
  return sign
}

/** Tokens as a sign-in keeps them, with the time they expire. */
export function keptTokens(tokens: OAuthTokens, now: number): NonNullable<SignIn['tokens']> {
  addLogSecret(tokens.access_token)
  if (tokens.refresh_token) addLogSecret(tokens.refresh_token)
  return {
    access: tokens.access_token,
    type: tokens.token_type || 'Bearer',
    ...(tokens.refresh_token ? { refresh: tokens.refresh_token } : {}),
    ...(tokens.expires_in !== undefined && Number.isFinite(tokens.expires_in)
      ? { expiresAt: now + tokens.expires_in * 1000 }
      : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
  }
}

export type Probe = { kind: 'open' } | { kind: 'oauth'; resourceMetadataUrl?: URL; scope?: string }

/**
 * Asks the server to start an MCP session without a token: an answer means it needs no sign-in,
 * a 401 that it does. A session it started is ended again.
 */
export async function probe(
  url: string,
  headers: Record<string, string>,
  fetcher: Fetch,
): Promise<Probe> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: {
      ...headers,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Kettu', version: '1' },
      },
    }),
  })
  void response.body?.cancel()
  if (response.status === 401 || response.status === 403) {
    const { extractWWWAuthenticateParams } = await loadAuth()
    const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response)
    return {
      kind: 'oauth',
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      ...(scope ? { scope } : {}),
    }
  }
  if (!response.ok) throw new Error(`The server answered ${response.status}`)
  const session = response.headers.get('mcp-session-id')
  if (session) {
    void fetcher(url, {
      method: 'DELETE',
      headers: { ...headers, 'Mcp-Session-Id': session },
    }).then(
      (end) => void end.body?.cancel(),
      () => {},
    )
  }
  return { kind: 'open' }
}

/** A sign-in on its way: what the user is shown, and how it ends. */
export interface Login {
  done: Promise<SignIn>
  cancel(): void
}

export interface BrowserLogin extends Login {
  url: string
}

export interface DeviceLogin extends Login {
  userCode: string
  verificationUri: string
  expiresAt: number
}

class LoginCancelled extends Error {
  constructor() {
    super('The sign-in was cancelled')
  }
}

export function isCancelled(error: unknown): boolean {
  return error instanceof LoginCancelled
}

/** The page the browser lands on after the service, which says where to go next. */
function landing(ok: boolean): string {
  const said = ok
    ? 'Signed in. You can close this tab and return to Kettu.'
    : 'The sign-in did not finish. You can close this tab and try again in Kettu.'
  return `<!doctype html><meta charset="utf-8"><title>Kettu</title><body style="font:16px system-ui;margin:4rem">${said}</body>`
}

/** Waits for the service to send the browser back to a loopback port, for one sign-in. */
async function callback(): Promise<{
  redirectUrl: string
  code: (state: string) => Promise<string>
  close(): void
}> {
  let resolve: (code: string) => void = () => {}
  let reject: (error: Error) => void = () => {}
  let expected = ''
  const arrived = new Promise<string>((done, fail) => {
    resolve = done
    reject = fail
  })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')
    // Another page's request to this port proves nothing without the state it was given.
    if (state !== expected) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(landing(false))
      return
    }
    res
      .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(landing(!error && !!code))
    if (error || !code) {
      const reason = url.searchParams.get('error_description') ?? error ?? 'no code'
      reject(new Error(`The service refused the sign-in: ${reason.slice(0, 300)}`))
    } else {
      resolve(code)
    }
  })
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => done())
  })
  server.unref()
  const port = (server.address() as AddressInfo).port
  return {
    redirectUrl: `http://127.0.0.1:${port}/callback`,
    code: (state) => {
      expected = state
      return arrived
    },
    close: () => {
      server.closeAllConnections()
      server.close()
      reject(new LoginCancelled())
    },
  }
}

export interface BrowserOptions {
  url: string
  probe: Extract<Probe, { kind: 'oauth' }>
  fetch: Fetch
  now: () => number
  timeoutMs?: number
}

/**
 * The browser flow: the server's protected resource metadata, its authorization server's metadata,
 * a client registered for this sign-in, then a PKCE authorization the browser completes on a
 * loopback port. A server whose authorization server offers no S256 is refused, as MCP requires.
 */
export async function browserLogin(options: BrowserOptions): Promise<BrowserLogin> {
  const sdk = await loadAuth()
  const fetchFn = options.fetch
  const info = await sdk.discoverOAuthServerInfo(options.url, {
    ...(options.probe.resourceMetadataUrl
      ? { resourceMetadataUrl: options.probe.resourceMetadataUrl }
      : {}),
    fetchFn,
  })
  const metadata = info.authorizationServerMetadata
  if (!metadata) throw new Error('The server names no authorization server Kettu can read')
  if (!metadata.code_challenge_methods_supported?.includes('S256')) {
    throw new Error('The authorization server does not offer PKCE with S256')
  }
  const resource = resourceFor(sdk, options.url, info.resourceMetadata?.resource)
  const scope = options.probe.scope ?? info.resourceMetadata?.scopes_supported?.join(' ')
  const back = await callback()
  try {
    const clientMetadata: OAuthClientMetadata & { application_type: string } = {
      client_name: 'Kettu',
      redirect_uris: [back.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native',
    }
    const registered = await sdk.registerClient(info.authorizationServerUrl, {
      metadata,
      clientMetadata,
      ...(scope ? { scope } : {}),
      fetchFn,
    })
    const client: OAuthClientInformationMixed = {
      client_id: registered.client_id,
      ...(registered.client_secret ? { client_secret: registered.client_secret } : {}),
    }
    const state = randomBytes(24).toString('base64url')
    const started = await sdk.startAuthorization(info.authorizationServerUrl, {
      metadata,
      clientInformation: client,
      redirectUrl: back.redirectUrl,
      ...(scope ? { scope } : {}),
      state,
      resource,
    })
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (async (): Promise<SignIn> => {
      const timeout = new Promise<never>((_, fail) => {
        timer = setTimeout(
          () => fail(new Error('The sign-in did not finish within five minutes')),
          options.timeoutMs ?? LOGIN_MS,
        )
      })
      try {
        const code = await Promise.race([back.code(state), timeout])
        const tokens = await sdk.exchangeAuthorization(info.authorizationServerUrl, {
          metadata,
          clientInformation: client,
          authorizationCode: code,
          codeVerifier: started.codeVerifier,
          redirectUri: back.redirectUrl,
          resource,
          fetchFn,
        })
        return {
          v: 1,
          url: options.url,
          savedAt: options.now(),
          kind: 'browser',
          account: null,
          issuer: info.authorizationServerUrl,
          resource: resource.href,
          client: {
            client_id: client.client_id,
            ...(client.client_secret ? { client_secret: client.client_secret } : {}),
          },
          tokens: keptTokens(tokens, options.now()),
        }
      } finally {
        if (timer) clearTimeout(timer)
        back.close()
      }
    })()
    return { url: started.authorizationUrl.href, done, cancel: () => back.close() }
  } catch (error) {
    back.close()
    throw error
  }
}

/** The RFC 8707 resource: the metadata's, when it covers the server's address, else the address. */
function resourceFor(
  sdk: Awaited<ReturnType<typeof loadAuth>>,
  url: string,
  declared: string | undefined,
): URL {
  if (
    declared &&
    sdk.checkResourceAllowed({ requestedResource: url, configuredResource: declared })
  ) {
    return new URL(declared)
  }
  return sdk.resourceUrlFromServerUrl(url)
}

export interface DeviceOptions {
  url: string
  fetch: Fetch
  now: () => number
  /** Waits between polls; tests pass one that does not. */
  sleep?: (ms: number) => Promise<void>
}

async function formPost(
  fetcher: Fetch,
  url: string,
  form: Record<string, string>,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  })
  const body = (await response.json().catch(() => null)) as unknown
  if (!isRecord(body)) throw new Error(`${new URL(url).host} answered ${response.status}`)
  return body
}

/**
 * The device flow (RFC 8628) of the app Kettu registered with the server's authorization server:
 * the user enters a code at the service while the host polls, with the scopes the server lists.
 */
export async function deviceLogin(options: DeviceOptions): Promise<DeviceLogin> {
  const sdk = await loadAuth()
  const fetchFn = options.fetch
  const resourceMetadata = await sdk.discoverOAuthProtectedResourceMetadata(
    options.url,
    {},
    fetchFn,
  )
  const issuer = resourceMetadata.authorization_servers?.[0]
  const clientId = issuer ? DEVICE_CLIENTS[issuer] : undefined
  if (!issuer || !clientId) throw new Error('Kettu has no app registered with this service')
  const metadata = (await sdk.discoverAuthorizationServerMetadata(issuer, { fetchFn })) as
    (AuthorizationServerMetadata & { device_authorization_endpoint?: string }) | undefined
  const deviceEndpoint = metadata?.device_authorization_endpoint
  if (!metadata || !deviceEndpoint) throw new Error('The service offers no device sign-in')
  const scope = resourceMetadata.scopes_supported?.join(' ')
  const started = await formPost(fetchFn, deviceEndpoint, {
    client_id: clientId,
    ...(scope ? { scope } : {}),
  })
  const deviceCode = text(started.device_code)
  const userCode = text(started.user_code)
  const verificationUri = text(started.verification_uri)
  if (!deviceCode || !userCode || !verificationUri) {
    throw new Error(
      `The service did not start a device sign-in: ${text(started.error_description) ?? text(started.error) ?? 'no code'}`,
    )
  }
  const expiresAt = options.now() + (Number(started.expires_in) || 900) * 1000
  let interval = (Number(started.interval) || 5) * 1000
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)))
  let cancelled = false
  const done = (async (): Promise<SignIn> => {
    for (;;) {
      await sleep(interval)
      if (cancelled) throw new LoginCancelled()
      if (options.now() >= expiresAt) throw new Error('The code expired before it was entered')
      const answer = await formPost(fetchFn, metadata.token_endpoint, {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: DEVICE_GRANT,
      })
      if (cancelled) throw new LoginCancelled()
      const error = text(answer.error)
      if (error === 'authorization_pending') continue
      if (error === 'slow_down') {
        interval += 5_000
        continue
      }
      if (error === 'expired_token') throw new Error('The code expired before it was entered')
      if (error === 'access_denied') throw new Error('The sign-in was denied at the service')
      if (error)
        throw new Error(
          `The service refused the sign-in: ${text(answer.error_description) ?? error}`,
        )
      const access = text(answer.access_token)
      if (!access) throw new Error('The service gave no token')
      const tokens = keptTokens(
        {
          access_token: access,
          token_type: text(answer.token_type) ?? 'Bearer',
          ...(text(answer.refresh_token) ? { refresh_token: answer.refresh_token as string } : {}),
          ...(Number.isFinite(Number(answer.expires_in)) && answer.expires_in !== undefined
            ? { expires_in: Number(answer.expires_in) }
            : {}),
          ...(text(answer.scope) ? { scope: answer.scope as string } : {}),
        },
        options.now(),
      )
      return {
        v: 1,
        url: options.url,
        savedAt: options.now(),
        kind: 'device',
        account: await accountOf(issuer, access, fetchFn),
        issuer,
        resource: resourceMetadata.resource,
        client: { client_id: clientId },
        tokens,
      }
    }
  })()
  return {
    userCode,
    verificationUri,
    expiresAt,
    done,
    cancel: () => {
      cancelled = true
    },
  }
}

/** The account a token signs in as, where the service tells it cheaply; null elsewhere. */
async function accountOf(issuer: string, token: string, fetcher: Fetch): Promise<string | null> {
  if (issuer !== 'https://github.com/login/oauth') return null
  try {
    const response = await fetcher('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Kettu',
      },
    })
    const body = (await response.json().catch(() => null)) as unknown
    return response.ok && isRecord(body) ? (text(body.login) ?? null) : null
  } catch {
    return null
  }
}

/**
 * New tokens from the sign-in's refresh token; throws when there is none or the service refuses,
 * which leaves the sign-in to be done again.
 */
export async function renew(sign: SignIn, fetcher: Fetch, now: () => number): Promise<SignIn> {
  const refresh = sign.tokens?.refresh
  if (!refresh || !sign.issuer || !sign.client)
    throw new Error('The token expired and cannot be renewed')
  const sdk = await loadAuth()
  const metadata = await sdk.discoverAuthorizationServerMetadata(sign.issuer, { fetchFn: fetcher })
  const tokens = await sdk.refreshAuthorization(sign.issuer, {
    ...(metadata ? { metadata } : {}),
    clientInformation: sign.client,
    refreshToken: refresh,
    ...(sign.resource ? { resource: new URL(sign.resource) } : {}),
    fetchFn: fetcher,
  })
  return { ...sign, savedAt: now(), tokens: keptTokens(tokens, now()) }
}
