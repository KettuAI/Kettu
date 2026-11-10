import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayKey } from '@shared/remote/relay'
import { RELAY_HOST_TIMINGS, RelayHost } from '@shared/remote/relay-host'
import { RelaySwitch } from './relay-switch'

/** A socket that never opens. */
function quietSocket(): WebSocket {
  return {
    readyState: 0,
    OPEN: 1,
    addEventListener() {},
    removeEventListener() {},
    close() {},
    send() {},
  } as unknown as WebSocket
}

function relay() {
  const fetchInfo = vi.fn(async (): Promise<unknown> => null)
  const openSocket = vi.fn(() => quietSocket())
  const relaySwitch = new RelaySwitch(
    () =>
      new RelayHost({
        main: 'https://relay.kettu.sh',
        id: 'host-1',
        key: {} as RelayKey,
        openSocket,
        fetchInfo,
        accepted: () => {},
        changed: () => {},
        log: () => {},
      }),
  )
  return { relaySwitch, fetchInfo, openSocket }
}

describe('the host’s relay switch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads no region list and opens no socket while the relay is off', async () => {
    const { relaySwitch, fetchInfo, openSocket } = relay()
    relaySwitch.set(false, 'access-token')
    await vi.advanceTimersByTimeAsync(RELAY_HOST_TIMINGS.regionsMs * 2)

    expect(relaySwitch.current).toBeNull()
    expect(fetchInfo).not.toHaveBeenCalled()
    expect(openSocket).not.toHaveBeenCalled()
  })

  it('stops reading and signing in once the relay turns off, and starts again when on', async () => {
    const { relaySwitch, fetchInfo, openSocket } = relay()
    relaySwitch.set(true, 'access-token')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchInfo).toHaveBeenCalledTimes(1)
    expect(openSocket).toHaveBeenCalledTimes(1)

    relaySwitch.set(false, 'access-token')
    await vi.advanceTimersByTimeAsync(RELAY_HOST_TIMINGS.regionsMs * 2)
    expect(relaySwitch.current).toBeNull()
    expect(fetchInfo).toHaveBeenCalledTimes(1)
    expect(openSocket).toHaveBeenCalledTimes(1)

    relaySwitch.set(true, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(relaySwitch.current).not.toBeNull()
    expect(fetchInfo).toHaveBeenCalledTimes(2)
    // Without a token no relay is signed in to.
    expect(openSocket).toHaveBeenCalledTimes(1)
    relaySwitch.stop()
  })
})
