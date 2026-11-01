// `kettu login`, `kettu logout` and the account line of `kettu status`. A daemon has no browser of
// its own, so it signs in with a device code (RFC 8628) that the user confirms on another device.
// The refresh token is kept like the host's private key: in a file only the user can read.

import { setTimeout as sleep } from 'node:timers/promises'
import type { IdentityCipher } from '../main/remote-identity'
import {
  AccountNetworkError,
  AccountServiceError,
  DAEMON_CLIENT,
  type AccountApi,
  type ClientInfo,
  type Me,
  type TokenSet,
} from '../main/account/service'
import {
  openToken,
  readAccount,
  removeAccount,
  sealToken,
  writeAccount,
  type StoredAccount,
} from '../main/account/store'

export interface AccountCommandDeps {
  api: AccountApi
  file: string
  cipher: IdentityCipher
  clientInfo: () => Promise<ClientInfo>
  write: (text: string) => void
  /** A line for standard error, without the `kettu: ` prefix. */
  error: (message: string) => void
  /** Stops a login that waits, as Ctrl-C does. */
  signal: AbortSignal
  wait?: (ms: number, signal: AbortSignal) => Promise<unknown>
  now?: () => number
}

/** How `kettu status` names the subscription's status. */
function subscriptionText(status: string): string {
  if (status === 'none') return 'not subscribed'
  if (status === 'active') return 'subscribed'
  return status
}

export function accountLine(stored: StoredAccount | null): string {
  if (!stored) return 'not signed in; kettu login signs in'
  return `signed in as ${stored.profile.email}, ${subscriptionText(stored.subscription)}`
}

const message = (error: unknown): string => (error as Error)?.message ?? String(error)

/** Signs in with a device code; 0 once signed in, 1 when it ends without, 130 when stopped. */
export async function login(deps: AccountCommandDeps): Promise<number> {
  const { api, write } = deps
  const wait = deps.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }))
  const now = deps.now ?? Date.now
  const existing = await readAccount(deps.file, deps.error)
  if (existing) {
    write(
      `Already signed in as ${existing.profile.email}. To use another account, run kettu logout first.\n`,
    )
    return 0
  }
  let code
  try {
    code = await api.startDevice(await deps.clientInfo())
  } catch (error) {
    deps.error(`Could not start signing in: ${message(error)}`)
    return 1
  }
  const complete = code.verificationUriComplete
  write(
    `To sign in, open ${code.verificationUri} in a browser on any device and enter the code\n\n` +
      `    ${code.userCode}\n\n` +
      (complete ? `or open ${complete}, which fills it in.\n` : '') +
      'Waiting for the sign-in to be confirmed. Press Ctrl-C to stop.\n',
  )
  const deadline = now() + code.expiresIn * 1000
  let interval = code.interval
  let unreachable = false
  for (;;) {
    try {
      await wait(interval * 1000, deps.signal)
    } catch {
      write('\nStopped; nothing was signed in.\n')
      return 130
    }
    if (now() >= deadline) {
      deps.error('The code expired before the sign-in was confirmed. Run kettu login again.')
      return 1
    }
    let tokens: TokenSet
    try {
      tokens = await api.pollDevice(code.deviceCode)
    } catch (error) {
      if (error instanceof AccountNetworkError) {
        if (!unreachable) deps.error(`Could not reach the account service; still trying`)
        unreachable = true
        continue
      }
      unreachable = false
      if (!(error instanceof AccountServiceError)) throw error
      switch (error.code) {
        case 'authorization_pending':
          continue
        case 'slow_down':
          // RFC 8628 section 3.5: every slow_down adds 5 seconds for good.
          interval = error.interval ?? interval + 5
          continue
        case 'access_denied':
          deps.error('The sign-in was denied in the browser.')
          return 1
        case 'expired_token':
          deps.error('The code expired before the sign-in was confirmed. Run kettu login again.')
          return 1
        default:
          deps.error(`The account service refused the sign-in: ${error.message}`)
          return 1
      }
    }
    let me: Me
    try {
      me = await api.me(tokens.accessToken)
      await writeAccount(deps.file, {
        profile: me.account,
        subscription: me.subscription,
        ...(await sealToken(tokens.refreshToken, deps.cipher)),
      })
    } catch (error) {
      // Not kept here, so the sign-in the service just made is ended there too.
      await api.revoke(DAEMON_CLIENT, tokens.refreshToken).catch(() => undefined)
      deps.error(`Could not finish signing in: ${message(error)}`)
      return 1
    }
    write(`Signed in as ${me.account.email}.\n`)
    return 0
  }
}

/** Signs out at the service, then forgets the sign-in here, even when the service is away. */
export async function logout(deps: AccountCommandDeps): Promise<number> {
  const stored = await readAccount(deps.file, deps.error)
  if (!stored) {
    deps.write('Not signed in.\n')
    return 0
  }
  let ended = true
  try {
    await deps.api.revoke(DAEMON_CLIENT, await openToken(stored, deps.cipher))
  } catch (error) {
    ended = false
    deps.error(`Could not sign out at the account service: ${message(error)}`)
  }
  await removeAccount(deps.file)
  deps.write(
    ended
      ? `Signed out of ${stored.profile.email}.\n`
      : `Signed out here. To end the sign-in at the service too, sign this computer out on your account page.\n`,
  )
  return ended ? 0 : 1
}
