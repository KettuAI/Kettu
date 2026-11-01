import { readFile, stat } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tempFolder } from '../agent-host/testing/temp'
import { AccountApi } from '../main/account/service'
import { accountFile, readAccount } from '../main/account/store'
import {
  startFakeAccountService,
  type FakeAccountService,
} from '../main/account/testing/fake-service'
import { accountLine, login, logout, type AccountCommandDeps } from './account'
import { NO_SYSTEM_ENCRYPTION } from './key'

let service: FakeAccountService

beforeEach(async () => {
  service = await startFakeAccountService()
})

afterEach(async () => {
  await service.close()
})

/**
 * A CLI run against the fake service. Each wait moves the service's clock on by the time waited,
 * and `onWait` sees how many waits came before, so a test can act as the user meanwhile.
 */
async function setup(onWait: (count: number) => void | number = () => {}) {
  const dir = await tempFolder('kettu-daemon-account-')
  const output: string[] = []
  const errors: string[] = []
  const waits: number[] = []
  const stop = new AbortController()
  let failNext = false
  const deps: AccountCommandDeps = {
    api: new AccountApi(
      service.base,
      (url, init) => {
        if (failNext) {
          failNext = false
          return Promise.reject(new TypeError('fetch failed'))
        }
        return fetch(url, init)
      },
      () => service.now,
    ),
    file: accountFile(dir),
    cipher: NO_SYSTEM_ENCRYPTION,
    clientInfo: async () => ({
      kind: 'daemon',
      name: 'devbox',
      os: 'Ubuntu 24.04.1 LTS',
      arch: 'x64',
      version: '0.3.0',
    }),
    write: (text) => void output.push(text),
    error: (message) => void errors.push(message),
    signal: stop.signal,
    wait: async (ms, signal) => {
      if (signal.aborted) throw new Error('Aborted')
      waits.push(ms)
      // A number moves the clock by less than asked, as a client polling too fast.
      const moved = onWait(waits.length)
      service.now += typeof moved === 'number' ? moved : ms
      if (signal.aborted) throw new Error('Aborted')
    },
    now: () => service.now,
  }
  return {
    deps,
    dir,
    output: () => output.join(''),
    errors,
    waits,
    stop,
    failOnce: () => void (failNext = true),
  }
}

const approve = (): void => {
  service.devices.at(-1)!.status = 'approved'
}

describe('kettu login', () => {
  it('prints the link and the code, and signs in once the code is confirmed', async () => {
    const run = await setup((count) => {
      if (count === 2) approve()
    })
    expect(await login(run.deps)).toBe(0)
    expect(run.output()).toContain(`open ${service.base}/device in a browser`)
    expect(run.output()).toContain('    BCDF-GHJK\n')
    expect(run.output()).toContain(`${service.base}/device?user_code=BCDF-GHJK`)
    expect(run.output()).toContain('Signed in as ada@example.com.')
    expect(run.waits).toEqual([5000, 5000])
    expect(service.devices[0]!.clientInfo).toMatchObject({ kind: 'daemon', name: 'devbox' })

    const file = accountFile(run.dir)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const stored = await readAccount(file, () => {})
    expect(stored).toMatchObject({ encrypted: false, plainText: true, subscription: 'none' })
    expect(accountLine(stored)).toBe('signed in as ada@example.com, not subscribed')
  })

  it('polls more slowly after slow_down', async () => {
    const run = await setup((count) => {
      if (count === 3) approve()
      // The second wait is cut short, so the service asks for 5 more seconds.
      return count === 2 ? 1000 : undefined
    })
    expect(await login(run.deps)).toBe(0)
    expect(run.waits).toEqual([5000, 5000, 10000])
  })

  it('stops when the sign-in is denied', async () => {
    const run = await setup(() => {
      service.devices.at(-1)!.status = 'denied'
    })
    expect(await login(run.deps)).toBe(1)
    expect(run.errors).toEqual(['The sign-in was denied in the browser.'])
    await expect(stat(accountFile(run.dir))).rejects.toThrow()
  })

  it('stops when the code expires', async () => {
    const run = await setup(() => {
      service.devices.at(-1)!.expiresAt = service.now
    })
    expect(await login(run.deps)).toBe(1)
    expect(run.errors[0]).toMatch(/^The code expired/)

    // Or when the code's time is up here, without asking the service again.
    const late = await setup(() => 700_000)
    expect(await login(late.deps)).toBe(1)
    expect(late.errors[0]).toMatch(/^The code expired/)
    expect(service.requests.filter((r) => r === 'POST /api/oauth/token')).toHaveLength(1)
  })

  it('keeps polling while the service cannot be reached', async () => {
    const run = await setup((count) => {
      if (count === 1) run.failOnce()
      if (count === 2) approve()
    })
    expect(await login(run.deps)).toBe(0)
    expect(run.errors).toEqual(['Could not reach the account service; still trying'])
  })

  it('stops on Ctrl-C', async () => {
    const run = await setup(() => run.stop.abort())
    expect(await login(run.deps)).toBe(130)
    expect(run.output()).toContain('Stopped; nothing was signed in.')
  })

  it('says so when it is signed in already', async () => {
    const run = await setup(approve)
    await login(run.deps)
    const before = service.requests.length
    expect(await login(run.deps)).toBe(0)
    expect(run.output()).toContain('Already signed in as ada@example.com.')
    expect(service.requests).toHaveLength(before)
  })
})

describe('kettu logout', () => {
  it('revokes the refresh token and forgets the sign-in', async () => {
    const run = await setup(approve)
    await login(run.deps)
    const { token } = JSON.parse(await readFile(accountFile(run.dir), 'utf8')) as { token: string }
    expect(await logout(run.deps)).toBe(0)
    expect(service.revoked).toEqual([token])
    expect(service.families[0]!.revoked).toBe('signed_out')
    expect(run.output()).toContain('Signed out of ada@example.com.')
    expect(await readAccount(accountFile(run.dir), () => {})).toBeNull()
    expect(accountLine(null)).toBe('not signed in; kettu login signs in')
  })

  it('forgets the sign-in when the service cannot be reached, and says so', async () => {
    const run = await setup(approve)
    await login(run.deps)
    run.failOnce()
    expect(await logout(run.deps)).toBe(1)
    expect(run.errors[0]).toMatch(/^Could not sign out at the account service/)
    expect(await readAccount(accountFile(run.dir), () => {})).toBeNull()
  })

  it('says so when it is not signed in', async () => {
    const run = await setup()
    expect(await logout(run.deps)).toBe(0)
    expect(run.output()).toBe('Not signed in.\n')
  })
})
