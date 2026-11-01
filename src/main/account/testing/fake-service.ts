// A Kettu account service on a loopback port, for tests: the OAuth endpoints and `/api/v1/me` as
// the clients speak them, with the website's part, approving a sign-in, done by calls.

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

interface Family {
  id: string
  clientId: string
  clientInfo: Record<string, unknown>
  revoked: string | null
}

interface DeviceRequest {
  deviceCode: string
  userCode: string
  clientInfo: Record<string, unknown>
  status: 'pending' | 'approved' | 'denied' | 'used'
  expiresAt: number
  interval: number
  lastPoll: number | null
}

const token = (): string => randomBytes(16).toString('base64url')

export interface FakeAccountService {
  base: string
  account: { id: string; email: string; name: string | null; avatarUrl: string | null }
  subscription: string
  /** Every request, as `METHOD /path`. */
  requests: string[]
  /** Every refresh token the token endpoint was given, in order. */
  refreshed: string[]
  /** Every token revoked through `/api/oauth/revoke`. */
  revoked: string[]
  families: Family[]
  devices: DeviceRequest[]
  /** What the website does on Continue: a code for the request, at its redirect. */
  authorize(signInUrl: string): string
  /** The access tokens stop at once, as after an hour. */
  expireAccessTokens(): void
  /** Ends every sign-in with a reason, as the account page's sign-out does. */
  revokeAll(reason: string): void
  /** Forgets every sign-in, as deleting the account does. */
  forgetAll(): void
  disabled: boolean
  /** The time the device grant sees, in Unix milliseconds. */
  now: number
  close(): Promise<void>
}

function readBody(request: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let text = ''
    request.on('data', (chunk: Buffer) => (text += chunk.toString()))
    request.on('end', () => resolve(Object.fromEntries(new URLSearchParams(text))))
  })
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

export async function startFakeAccountService(): Promise<FakeAccountService> {
  const codes = new Map<
    string,
    { redirectUri: string; challenge: string; info: Record<string, unknown>; used: boolean }
  >()
  const access = new Map<string, Family>()
  const refresh = new Map<string, { family: Family; used: boolean }>()

  const issue = (family: Family) => {
    const accessToken = token()
    const refreshToken = token()
    access.set(accessToken, family)
    refresh.set(refreshToken, { family, used: false })
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: refreshToken,
    }
  }
  const newFamily = (clientId: string, clientInfo: Record<string, unknown>): Family => {
    const family = { id: token(), clientId, clientInfo, revoked: null }
    service.families.push(family)
    return family
  }
  const revokeFamily = (family: Family, reason: string): void => {
    family.revoked ??= reason
    for (const [key, owner] of access) if (owner === family) access.delete(key)
  }
  const invalidGrant = (response: ServerResponse, reason?: string): void =>
    json(response, 400, {
      error: 'invalid_grant',
      error_description: 'no',
      ...(reason ? { reason } : {}),
    })

  async function tokenEndpoint(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request)
    if (body.grant_type === 'authorization_code') {
      const code = codes.get(body.code ?? '')
      if (!code) return invalidGrant(response)
      if (code.used) return invalidGrant(response, 'authorization_code_reused')
      code.used = true
      const challenge = createHash('sha256')
        .update(body.code_verifier ?? '')
        .digest('base64url')
      if (body.client_id !== 'kettu-desktop' || body.redirect_uri !== code.redirectUri) {
        return invalidGrant(response)
      }
      if (challenge !== code.challenge) return invalidGrant(response)
      if (service.disabled) return invalidGrant(response, 'account_disabled')
      return json(response, 200, issue(newFamily(body.client_id, code.info)))
    }
    if (body.grant_type === 'refresh_token') {
      service.refreshed.push(body.refresh_token ?? '')
      const held = refresh.get(body.refresh_token ?? '')
      if (!held || held.family.clientId !== body.client_id) return invalidGrant(response)
      if (held.family.revoked) return invalidGrant(response, held.family.revoked)
      if (held.used) {
        revokeFamily(held.family, 'refresh_token_reused')
        return invalidGrant(response, 'refresh_token_reused')
      }
      if (service.disabled) return invalidGrant(response, 'account_disabled')
      held.used = true
      return json(response, 200, issue(held.family))
    }
    if (body.grant_type === 'urn:ietf:params:oauth:grant-type:device_code') {
      const device = service.devices.find((d) => d.deviceCode === body.device_code)
      if (!device || body.client_id !== 'kettu-daemon') return invalidGrant(response)
      if (device.status === 'used') return invalidGrant(response)
      if (device.expiresAt <= service.now) {
        return json(response, 400, { error: 'expired_token', error_description: 'expired' })
      }
      if (device.lastPoll !== null && service.now - device.lastPoll < device.interval * 1000) {
        device.interval += 5
        device.lastPoll = service.now
        return json(response, 400, {
          error: 'slow_down',
          error_description: 'slower',
          interval: device.interval,
        })
      }
      device.lastPoll = service.now
      if (device.status === 'pending') {
        return json(response, 400, { error: 'authorization_pending', error_description: 'wait' })
      }
      if (device.status === 'denied') {
        return json(response, 400, { error: 'access_denied', error_description: 'denied' })
      }
      device.status = 'used'
      return json(response, 200, issue(newFamily('kettu-daemon', device.clientInfo)))
    }
    json(response, 400, { error: 'unsupported_grant_type', error_description: 'no' })
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    service.requests.push(`${request.method} ${url.pathname}`)
    void (async () => {
      if (request.method === 'POST' && url.pathname === '/api/oauth/token') {
        return tokenEndpoint(request, response)
      }
      if (request.method === 'POST' && url.pathname === '/api/oauth/revoke') {
        const body = await readBody(request)
        service.revoked.push(body.token ?? '')
        const family = refresh.get(body.token ?? '')?.family ?? access.get(body.token ?? '')
        if (family && family.clientId === body.client_id) revokeFamily(family, 'signed_out')
        response.writeHead(200)
        return response.end()
      }
      if (request.method === 'POST' && url.pathname === '/api/oauth/device') {
        const body = await readBody(request)
        const device: DeviceRequest = {
          deviceCode: token(),
          userCode: 'BCDF-GHJK',
          clientInfo: JSON.parse(body.client_info ?? '{}') as Record<string, unknown>,
          status: 'pending',
          expiresAt: service.now + 600_000,
          interval: 5,
          lastPoll: null,
        }
        service.devices.push(device)
        return json(response, 200, {
          device_code: device.deviceCode,
          user_code: device.userCode,
          verification_uri: `${service.base}/device`,
          verification_uri_complete: `${service.base}/device?user_code=${device.userCode}`,
          expires_in: 600,
          interval: 5,
        })
      }
      if (request.method === 'GET' && url.pathname === '/api/v1/me') {
        const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
        if (!access.has(bearer))
          return json(response, 401, { error: 'invalid_token', message: 'no' })
        if (service.disabled)
          return json(response, 403, { error: 'account_disabled', message: 'no' })
        return json(response, 200, {
          account: service.account,
          subscription: { status: service.subscription },
        })
      }
      json(response, 404, { error: 'not_found', message: 'no' })
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

  const service: FakeAccountService = {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    account: { id: 'acc_1', email: 'ada@example.com', name: 'Ada Lovelace', avatarUrl: null },
    subscription: 'none',
    requests: [],
    refreshed: [],
    revoked: [],
    families: [],
    devices: [],
    disabled: false,
    now: Date.now(),
    authorize(signInUrl) {
      const params = new URL(signInUrl).searchParams
      if (params.get('code_challenge_method') !== 'S256') throw new Error('Not S256')
      const code = token()
      codes.set(code, {
        redirectUri: params.get('redirect_uri')!,
        challenge: params.get('code_challenge')!,
        info: JSON.parse(params.get('client_info')!) as Record<string, unknown>,
        used: false,
      })
      const redirect = new URL(params.get('redirect_uri')!)
      redirect.searchParams.set('code', code)
      redirect.searchParams.set('state', params.get('state')!)
      return redirect.href
    },
    expireAccessTokens: () => access.clear(),
    revokeAll(reason) {
      for (const family of service.families) revokeFamily(family, reason)
    },
    forgetAll() {
      access.clear()
      refresh.clear()
      service.families.length = 0
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
  return service
}
