import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrantRequests } from './grant-requests'

describe('GrantRequests', () => {
  const down = () => new Error('host down')
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('settles a request when the host answers it, and only that one', async () => {
    const requests = new GrantRequests(5000, down)
    const posted: number[] = []
    const first = requests.request((id) => posted.push(id) > 0)
    const second = requests.request((id) => posted.push(id) > 0)
    let secondDone = false
    void second.then(() => (secondDone = true))
    requests.answered(posted[0]!)
    await expect(first).resolves.toBeUndefined()
    await Promise.resolve()
    expect(secondDone).toBe(false)
    requests.answered(posted[1]!)
    await expect(second).resolves.toBeUndefined()
  })

  it('fails a request the host did not take, or did not answer in time', async () => {
    const requests = new GrantRequests(5000, down)
    await expect(requests.request(() => false)).rejects.toThrow('host down')
    const waiting = requests.request(() => true)
    const failed = expect(waiting).rejects.toThrow('host down')
    vi.advanceTimersByTime(5000)
    await failed
  })

  it('fails every waiting request when the host goes away, and ignores a late answer', async () => {
    const requests = new GrantRequests(5000, down)
    const posted: number[] = []
    const both = [
      requests.request((id) => posted.push(id) > 0),
      requests.request((id) => posted.push(id) > 0),
    ]
    requests.failAll()
    for (const request of both) await expect(request).rejects.toThrow('host down')
    expect(() => requests.answered(posted[0]!)).not.toThrow()
  })
})
