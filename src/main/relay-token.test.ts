import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RELAY_TOKEN_RENEW_MS, RelayFeatures, RelayToken, type Expiring } from './relay-token'

const HOUR = 60 * 60_000

describe('the tokens the remote host holds', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function tokens(options: { relayTokens: boolean; exchange?: () => Promise<Expiring | null> }) {
    let accessCount = 0
    let relayCount = 0
    const sent: [string | null, string | null][] = []
    const current = vi.fn(async (): Promise<Expiring> => ({
      token: `access-${++accessCount}`,
      expiresAt: Date.now() + HOUR,
    }))
    const exchange = vi.fn(
      options.exchange ??
        (async (): Promise<Expiring | null> =>
          options.relayTokens
            ? { token: `relay-${++relayCount}`, expiresAt: Date.now() + HOUR }
            : null),
    )
    const token = new RelayToken({
      current,
      exchange,
      signedIn: () => true,
      needed: () => true,
      send: (access, relay) => sent.push([access, relay]),
    })
    return { token, sent, current, exchange }
  }

  it('gives the relays a relay token once the main relay takes them, renewed 10 minutes early', async () => {
    const t = tokens({ relayTokens: true })
    await t.token.ready()
    expect(t.sent).toEqual([['access-1', 'relay-1']])

    await vi.advanceTimersByTimeAsync(HOUR - RELAY_TOKEN_RENEW_MS - 1)
    expect(t.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(t.sent.at(-1)).toEqual(['access-2', 'relay-2'])
    t.token.stop()
  })

  it('gives the relays the access token where the main relay takes no relay token', async () => {
    const t = tokens({ relayTokens: false })
    await t.token.ready()
    expect(t.sent).toEqual([['access-1', null]])
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(t.sent.at(-1)).toEqual(['access-2', null])
    t.token.stop()
  })

  it('keeps a relay token that still lasts when a new one cannot be had, and tries again soon', async () => {
    let fail = false
    let count = 0
    const t = tokens({
      relayTokens: true,
      exchange: async () => {
        if (fail) throw new Error('offline')
        return { token: `relay-${++count}`, expiresAt: Date.now() + HOUR }
      },
    })
    await t.token.ready()
    fail = true
    await vi.advanceTimersByTimeAsync(HOUR - RELAY_TOKEN_RENEW_MS)
    expect(t.sent.at(-1)).toEqual(['access-2', 'relay-1'])

    // Once it has lapsed the relays get the access token, which the main relay alone takes.
    await vi.advanceTimersByTimeAsync(RELAY_TOKEN_RENEW_MS)
    expect(t.sent.at(-1)).toEqual([expect.stringMatching(/^access-/), null])

    fail = false
    await vi.advanceTimersByTimeAsync(60_000)
    expect(t.sent.at(-1)?.[1]).toBe('relay-2')
    t.token.stop()
  })

  it('hands on neither once signed out', async () => {
    let signedIn = true
    const sent: [string | null, string | null][] = []
    const token = new RelayToken({
      current: async () => ({ token: 'access', expiresAt: Date.now() + HOUR }),
      exchange: async () => ({ token: 'relay', expiresAt: Date.now() + HOUR }),
      signedIn: () => signedIn,
      needed: () => true,
      send: (access, relay) => sent.push([access, relay]),
    })
    await token.ready()
    signedIn = false
    token.update()
    expect(sent).toEqual([
      ['access', 'relay'],
      [null, null],
    ])
    token.stop()
  })

  it("reads the main relay's features at most every 10 minutes, keeping the last answer", async () => {
    let answer: string[] | Error = ['hosts', 'relay-tokens']
    const read = vi.fn(async () => {
      if (answer instanceof Error) throw answer
      return answer
    })
    const features = new RelayFeatures(read)
    expect(await features.has('relay-tokens')).toBe(true)
    answer = new Error('offline')
    expect(await features.has('relay-tokens')).toBe(true)
    expect(read).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(await features.has('relay-tokens')).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
