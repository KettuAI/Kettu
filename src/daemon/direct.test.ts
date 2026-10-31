// What `kettu direct` prints, and the change of the port over a control connection the test plays.

import { describe, expect, it } from 'vitest'
import type { ControlClient, DirectReport } from './control'
import { changePort, directReport, type PortTerminal } from './direct'

const FRP = { host: 'frp.example.com', port: 60021 }

const listening: DirectReport = {
  port: 51234,
  own: [FRP],
  status: {
    state: 'listening',
    port: 51234,
    addresses: [FRP, { host: '192.0.2.10', port: 51234 }, { host: 'fd00::1', port: 51234 }],
  },
}

describe('directReport', () => {
  it("lists the addresses devices try, the owner's first", () => {
    expect(directReport(listening)).toBe(`Direct connections listen on port 51234.
Addresses devices try:
  frp.example.com:60021  yours
  192.0.2.10:51234       found on this computer
  [fd00::1]:51234        found on this computer
`)
  })

  it('says when no address was found', () => {
    expect(
      directReport({
        port: 4567,
        own: [],
        status: { state: 'listening', port: 4567, addresses: [] },
      }),
    ).toBe(
      'Direct connections listen on port 4567.\n' +
        'No private or VPN address found yet; add one of your own with\n' +
        'kettu direct add <host>:<port>.\n',
    )
  })

  it('says why the port cannot be opened, with the command that changes it', () => {
    expect(
      directReport({
        port: 51234,
        own: [FRP],
        status: { state: 'failed', port: 51234, reason: 'port_in_use' },
      }),
    ).toBe(`Direct connections cannot listen on port 51234: another program is using it.
Pick another port with kettu direct port <port>, or try this one again with
kettu direct port 51234.
Your addresses:
  frp.example.com:60021
`)
    expect(
      directReport({
        port: 80,
        own: [],
        status: { state: 'failed', port: 80, reason: 'other' },
      }),
    ).toMatch(/^Direct connections cannot listen on port 80: something on this computer kept/)
  })

  it('says when remote access is not running', () => {
    expect(directReport({ port: 51234, own: [], status: null })).toBe(
      'Remote access is not running, so direct connections do not listen; the port is 51234.\n',
    )
  })
})

function connection(before: DirectReport, after: DirectReport) {
  const calls: { method: string; params: unknown }[] = []
  const client: Pick<ControlClient, 'call'> = {
    call: async (method, params) => {
      calls.push({ method, params })
      return (method === 'direct.get' ? before : after) as never
    },
  }
  return { client, calls }
}

function terminal(answers: (string | null)[], interactive = true) {
  let written = ''
  const errors: string[] = []
  const asked: string[] = []
  const io: PortTerminal = {
    interactive,
    write: (text) => void (written += text),
    error: (message) => void errors.push(message),
    ask: async (question) => {
      asked.push(question)
      return answers.shift() ?? null
    },
  }
  return { io, asked, errors, written: () => written }
}

const moved: DirectReport = {
  port: 4567,
  own: [],
  status: { state: 'listening', port: 4567, addresses: [{ host: '192.0.2.10', port: 4567 }] },
}

describe('changePort', () => {
  it('warns what a new port means for devices and asks first', async () => {
    const { client, calls } = connection(listening, moved)
    const io = terminal(['y'])
    expect(await changePort(client, io.io, 4567, false)).toBe(0)
    expect(io.asked).toEqual(['Change the port? [y/N] '])
    expect(io.written()).toBe(
      'Direct connections move to port 4567. Devices online get the new address, but devices that\n' +
        'are offline and only connect directly cannot find this computer until they scan a new code\n' +
        'or their address is changed. A port you forward has to change too.\n' +
        'Direct connections listen on port 4567.\n' +
        'Addresses devices try:\n' +
        '  192.0.2.10:4567  found on this computer\n',
    )
    expect(calls).toEqual([
      { method: 'direct.get', params: undefined },
      { method: 'direct.port', params: { port: 4567 } },
    ])
  })

  it('keeps the port unless the owner says yes', async () => {
    for (const answer of ['', 'n', null]) {
      const { client, calls } = connection(listening, moved)
      const io = terminal([answer])
      expect(await changePort(client, io.io, 4567, false)).toBe(1)
      expect(io.written()).toMatch(/The port stays 51234\.\n$/)
      expect(calls.map((call) => call.method)).toEqual(['direct.get'])
    }
  })

  it('changes it without asking with --yes, and needs --yes without a terminal', async () => {
    const yes = connection(listening, moved)
    const asked = terminal([], false)
    expect(await changePort(yes.client, asked.io, 4567, true)).toBe(0)
    expect(asked.asked).toEqual([])
    expect(asked.written()).toContain('Direct connections move to port 4567.')
    expect(yes.calls.at(-1)).toEqual({ method: 'direct.port', params: { port: 4567 } })

    const no = connection(listening, moved)
    const refused = terminal([], false)
    expect(await changePort(no.client, refused.io, 4567, false)).toBe(1)
    expect(refused.errors).toEqual([
      'Changing the port needs --yes when there is no terminal to ask on',
    ])
    expect(no.calls.map((call) => call.method)).toEqual(['direct.get'])
  })

  it('tries the same port again without a warning, and fails when it still cannot listen', async () => {
    const failed: DirectReport = {
      port: 51234,
      own: [],
      status: { state: 'failed', port: 51234, reason: 'port_in_use' },
    }
    const { client, calls } = connection(failed, failed)
    const io = terminal([])
    expect(await changePort(client, io.io, 51234, false)).toBe(1)
    expect(io.asked).toEqual([])
    expect(io.written()).toMatch(
      /^Trying port 51234 again\.\nDirect connections cannot listen on port 51234/,
    )
    expect(calls.at(-1)).toEqual({ method: 'direct.port', params: { port: 51234 } })
  })
})
