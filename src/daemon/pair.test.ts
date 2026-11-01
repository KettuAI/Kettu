// `kettu pair`'s conversation over a control connection the test plays: the code, the question
// with the name to edit, and each way the code ends.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { pairingLink, parseBrowserPairingLink, type PairingState } from '@shared/remote/pairing'
import type { ControlClient, ControlEvent } from './control'
import { browserText, pairDevice, sshTarget, terminalQr, type PairTerminal } from './pair'

const LINK = 'https://kettu.sh/pair#AQ'
const NOW = 1_000_000

const iPad = {
  name: 'iPad Air',
  model: 'iPad Air',
  kind: 'ios',
  platform: 'iPadOS 26.1',
  known: false,
}

function connection() {
  const calls: { method: string; params: unknown }[] = []
  let listener: ((event: ControlEvent) => void) | null = null
  let closed = false
  const client: ControlClient = {
    call: async (method, params) => {
      calls.push({ method, params })
      return (method === 'pair.open' ? { codeId: 3 } : null) as never
    },
    onEvent: (next) => (listener = next),
    onClose: () => {},
    close: () => (closed = true),
  }
  return {
    client,
    calls,
    closed: () => closed,
    send: (pairing: PairingState) => listener!({ type: 'pairing', codeId: 3, pairing }),
  }
}

function terminal(answers: (string | null)[], live = false) {
  let written = ''
  const asked: { question: string; initial?: string }[] = []
  const io: PairTerminal = {
    live,
    write: (text) => void (written += text),
    ask: async (question, initial) => {
      asked.push({ question, initial })
      return answers.shift() ?? null
    },
  }
  return { io, asked, written: () => written }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  vi.useRealTimers()
})

describe('kettu pair', () => {
  it('shows the code, then adds the device under the name the owner typed', async () => {
    const c = connection()
    const t = terminal(['y', 'My iPad'])
    const done = pairDevice(c.client, t.io, new AbortController().signal, { now: () => NOW })
    await settle()
    expect(c.calls).toEqual([{ method: 'pair.open', params: undefined }])
    c.send({ state: 'waiting', link: LINK, expiresAt: NOW + 5 * 60_000 })
    expect(t.written()).toContain(terminalQr(LINK))
    expect(t.written()).toContain(`\n  ${LINK}\n`)
    expect(t.written()).toContain(
      "which another computer\npastes in Kettu's Settings › Hosts › Add host…:",
    )
    expect(t.written()).toContain('the code expires in 5:00.')

    c.send({ state: 'confirm', device: iPad })
    await settle()
    expect(t.written()).toContain('iPad Air (iOS app · iPad Air · iPadOS 26.1) used the code.')
    expect(t.asked).toEqual([
      { question: 'Add this device? [y/N] ', initial: undefined },
      { question: 'Name: ', initial: 'iPad Air' },
    ])
    expect(c.calls.at(-1)).toEqual({
      method: 'pair.answer',
      params: { codeId: 3, add: true, name: 'My iPad' },
    })
    c.send({
      state: 'added',
      device: {
        id: 'a'.repeat(32),
        publicKey: 'key',
        name: 'My iPad',
        kind: 'ios',
        platform: 'iPadOS 26.1',
        model: 'iPad Air',
        addedAt: NOW,
        lastConnectedAt: NOW,
      },
    })
    expect(await done).toBe(0)
    expect(t.written()).toMatch(/Added My iPad; it can connect now\.\n$/)
    expect(c.closed()).toBe(true)
  })

  it('gives a browser link for each address, and the SSH forward with its localhost link', async () => {
    const payload = {
      version: 1,
      hostKey: new Uint8Array(32).fill(1),
      secret: new Uint8Array(32).fill(2),
      addresses: [
        { host: '192.168.1.8', port: 47821 },
        { host: 'fd7a:115c::1', port: 47821 },
      ],
    }
    const link = pairingLink(payload)
    const c = connection()
    const t = terminal([])
    void pairDevice(c.client, t.io, new AbortController().signal, {
      now: () => NOW,
      ssh: { port: 47821, target: 'lin@192.168.1.8' },
    })
    c.send({ state: 'waiting', link, expiresAt: NOW + 5 * 60_000 })
    const written = t.written()
    const code = link.slice(link.indexOf('#'))
    expect(written).toContain(`\n  http://192.168.1.8:47821/pair${code}\n`)
    expect(written).toContain(`\n  http://[fd7a:115c::1]:47821/pair${code}\n`)
    expect(written).toContain(
      `\n  ssh -L 47821:localhost:47821 lin@192.168.1.8\n  http://localhost:47821/pair${code}\n`,
    )
    expect(parseBrowserPairingLink(`http://localhost:47821/pair${code}`)).toEqual(payload)
    // Without addresses or a listening port there is no browser link to give.
    expect(browserText({ ...payload, addresses: [] }, null)).toBe('')
  })

  it('names the address an SSH session came in on, else the computer', () => {
    const env = { SSH_CONNECTION: '192.168.1.20 52144 192.168.1.8 22' }
    expect(sshTarget(env, 'lin', 'studio.local')).toBe('lin@192.168.1.8')
    expect(sshTarget({}, 'lin', 'studio.local')).toBe('lin@studio.local')
  })

  it("keeps the device's own name when the owner clears it", async () => {
    const c = connection()
    const t = terminal(['yes', '  '])
    void pairDevice(c.client, t.io, new AbortController().signal)
    c.send({ state: 'confirm', device: iPad })
    await settle()
    expect(c.calls.at(-1)?.params).toEqual({ codeId: 3, add: true, name: 'iPad Air' })
  })

  it('rejects the device unless the owner says yes, and says the code is void', async () => {
    const c = connection()
    const t = terminal(['n'])
    const done = pairDevice(c.client, t.io, new AbortController().signal)
    c.send({ state: 'confirm', device: iPad })
    await settle()
    expect(c.calls.at(-1)?.params).toEqual({ codeId: 3, add: false, name: '' })
    c.send({ state: 'void', reason: 'rejected' })
    expect(await done).toBe(1)
    expect(t.written()).toMatch(/You rejected the device, so the code is void\.\n$/)
  })

  it.each([
    ['expired', 'The code expired'],
    ['attempts', 'A device used a wrong code 5 times'],
    ['stopped', 'Remote access stopped'],
  ] as const)('ends with what voided the code: %s', async (reason, said) => {
    const c = connection()
    const t = terminal([])
    const done = pairDevice(c.client, t.io, new AbortController().signal)
    c.send({ state: 'void', reason })
    expect(await done).toBe(1)
    expect(t.written()).toContain(said)
  })

  it('counts the time left down in place on a terminal', async () => {
    vi.useFakeTimers()
    let now = NOW
    const c = connection()
    const t = terminal([], true)
    void pairDevice(c.client, t.io, new AbortController().signal, { now: () => now })
    c.send({ state: 'waiting', link: LINK, expiresAt: NOW + 5 * 60_000 })
    now += 61_000
    vi.advanceTimersByTime(1000)
    expect(t.written().endsWith('\r\x1b[2KWaiting for a device… the code expires in 3:59.')).toBe(
      true,
    )
  })

  it('closes the connection, which voids the code, when stopped', async () => {
    const c = connection()
    const t = terminal([])
    const stop = new AbortController()
    const done = pairDevice(c.client, t.io, stop.signal)
    c.send({ state: 'waiting', link: LINK, expiresAt: NOW + 5 * 60_000 })
    stop.abort()
    expect(await done).toBe(130)
    expect(c.closed()).toBe(true)
    expect(t.written()).toMatch(/Stopped; the code is void\.\n$/)
  })
})

describe('the terminal QR code', () => {
  it('is black on white in any terminal', () => {
    const lines = terminalQr(LINK).split('\n')
    expect(lines.length).toBeGreaterThan(10)
    const [open, reset] = ['\x1b[30;107m', '\x1b[0m']
    for (const line of lines) {
      expect(line.startsWith(open) && line.endsWith(reset)).toBe(true)
      expect(line.slice(open.length, -reset.length)).toMatch(/^[ ▀▄█]+$/)
    }
  })
})
