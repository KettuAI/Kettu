import { describe, expect, it } from 'vitest'
import { listenLoopback } from './loopback'

describe('listenLoopback', () => {
  it('listens on 127.0.0.1 at /callback and answers nothing else', async () => {
    const loopback = await listenLoopback({ state: 's', timeoutMs: 5000 })
    expect(loopback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    const origin = new URL(loopback.redirectUri).origin
    expect((await fetch(`${origin}/`)).status).toBe(404)
    expect((await fetch(`${loopback.redirectUri}?state=s`)).status).toBe(400)
    loopback.close()
    expect(await loopback.result).toEqual({ kind: 'closed' })
  })

  it('takes the first callback with the state, and only that one', async () => {
    const loopback = await listenLoopback({ state: 's', timeoutMs: 5000 })
    const first = fetch(`${loopback.redirectUri}?code=c&state=s`, { redirect: 'manual' })
    expect(await loopback.result).toEqual({ kind: 'code', code: 'c' })
    loopback.answer({ location: 'https://kettu.test/signin/app/?done=1' })
    const answer = await first
    expect(answer.status).toBe(302)
    expect(answer.headers.get('location')).toBe('https://kettu.test/signin/app/?done=1')
    await expect(fetch(`${loopback.redirectUri}?code=d&state=s`)).rejects.toThrow()
  })

  it('takes an error the sign-in page sent back', async () => {
    const loopback = await listenLoopback({ state: 's', timeoutMs: 5000 })
    void fetch(`${loopback.redirectUri}?error=server_error&state=s`).catch(() => undefined)
    expect(await loopback.result).toEqual({ kind: 'error', error: 'server_error' })
    loopback.close()
  })
})
