import { X509Certificate, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeviceEvent } from '@shared/device-host'
import type { FoundDevice } from './discovery'
import {
  classifyPhysicalIosRunnerFailure,
  extractDevelopmentTeamFromPem,
  findDevelopmentTeam,
  parseAgentDeviceFailureJson,
  parseCodeSigningIdentities,
  physicalIosProblems,
  readRunnerLogTail,
  type PhysicalIosRunnerProbeResult,
} from './ios-physical-setup'

const discoveryFake = vi.hoisted(() => ({
  xcrun: '/usr/bin/xcrun' as string | null,
  simulators: [] as FoundDevice[],
  physicalIos: [] as FoundDevice[],
  android: [] as FoundDevice[],
}))

vi.mock('./discovery', () => ({
  findTools: async () => ({
    xcrun: discoveryFake.xcrun,
    adb: '/sdk/adb',
    emulator: null,
  }),
  listSimulators: async () => discoveryFake.simulators,
  listPhysicalIos: async () => discoveryFake.physicalIos,
  listAndroid: async () => discoveryFake.android,
  run: async () => '',
}))

import { DeviceManager } from './devices'

// Minimal ASN.1 DER helpers to build synthetic test certificates without external binaries.
function derLen(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length])
  const bytes: number[] = []
  let rest = length
  while (rest > 0) {
    bytes.unshift(rest & 0xff)
    rest >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content])
}

function derSeq(...parts: Buffer[]): Buffer {
  return derTag(0x30, Buffer.concat(parts))
}

function derSet(...parts: Buffer[]): Buffer {
  return derTag(0x31, Buffer.concat(parts))
}

function derOid(bytes: number[]): Buffer {
  return derTag(0x06, Buffer.from(bytes))
}

function derUtf8(value: string): Buffer {
  return derTag(0x0c, Buffer.from(value, 'utf8'))
}

function derUtcTime(date: Date): Buffer {
  const pad = (n: number): string => String(n).padStart(2, '0')
  const yy = pad(date.getUTCFullYear() % 100)
  const mm = pad(date.getUTCMonth() + 1)
  const dd = pad(date.getUTCDate())
  const hh = pad(date.getUTCHours())
  const mi = pad(date.getUTCMinutes())
  const ss = pad(date.getUTCSeconds())
  return derTag(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'))
}

function buildTestCertPem(options: { cn: string; ou?: string; notBefore: Date; notAfter: Date }): {
  pem: string
  fingerprint: string
} {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  // OID 1.3.101.112 (Ed25519)
  const algId = derSeq(derOid([0x2b, 0x65, 0x70]))
  const rdns = [
    // OID 2.5.4.3 (CN)
    derSet(derSeq(derOid([0x55, 0x04, 0x03]), derUtf8(options.cn))),
    ...(options.ou
      ? [
          // OID 2.5.4.11 (OU)
          derSet(derSeq(derOid([0x55, 0x04, 0x0b]), derUtf8(options.ou))),
        ]
      : []),
  ]
  const name = derSeq(...rdns)
  const tbs = derSeq(
    derTag(0xa0, derTag(0x02, Buffer.from([0x02]))), // v3
    derTag(0x02, Buffer.from([0x01])), // serialNumber
    algId,
    name,
    derSeq(derUtcTime(options.notBefore), derUtcTime(options.notAfter)),
    name,
    spki,
  )
  const signature = derTag(0x03, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64)]))
  const certDer = derSeq(tbs, algId, signature)
  const base64 = certDer.toString('base64').replace(/.{1,64}/g, '$&\n')
  const pem = `-----BEGIN CERTIFICATE-----\n${base64}-----END CERTIFICATE-----`
  const fingerprint = new X509Certificate(pem).fingerprint.replace(/:/g, '').toUpperCase()
  return { pem, fingerprint }
}

const PHYSICAL_IPHONE: FoundDevice = {
  id: 'ios:00008150-000125C03AE2401C',
  platform: 'ios',
  kind: 'physical',
  name: 'My iPhone',
  osVersion: '26.3.1',
  model: 'iPhone Air',
  state: 'connected',
  connection: 'usb',
  problems: [],
  target: '00008150-000125C03AE2401C',
}

const SIMULATOR: FoundDevice = {
  id: 'ios-sim:0E02CA7B-60D9-40F6-BCE1-C66A3DECAAEF',
  platform: 'ios',
  kind: 'simulator',
  name: 'iPhone 17',
  osVersion: '26.5',
  model: 'iPhone 17',
  state: 'booted',
  connection: null,
  problems: [],
  target: '0E02CA7B-60D9-40F6-BCE1-C66A3DECAAEF',
}

const ANDROID_PHONE: FoundDevice = {
  id: 'android:R58M123456A',
  platform: 'android',
  kind: 'physical',
  name: 'Pixel 9',
  osVersion: '15',
  model: 'Pixel 9',
  state: 'connected',
  connection: 'usb',
  problems: [],
  target: 'R58M123456A',
}

describe('iOS runner signing checks', () => {
  const now = Date.UTC(2026, 10, 28)
  const validRange = {
    notBefore: new Date(Date.UTC(2026, 0, 1)),
    notAfter: new Date(Date.UTC(2027, 0, 1)),
  }
  const expiredRange = {
    notBefore: new Date(Date.UTC(2024, 0, 1)),
    notAfter: new Date(Date.UTC(2025, 0, 1)),
  }

  it('parses valid Apple Development and iPhone Developer fingerprints from security output', () => {
    const output = [
      '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: Dev One (TEAM123456)"',
      '  2) FFEEDDCCBBAA99887766554433221100FFEEDDCC "Developer ID Application: Example Corp"',
      '  3) AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA "iPhone Developer: Legacy Dev (LEG1234567)"',
      '     3 valid identities found',
    ].join('\n')
    expect([...parseCodeSigningIdentities(output)]).toEqual([
      '0123456789ABCDEF0123456789ABCDEF01234567',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    ])
  })

  it('extracts team ID only from unexpired certificates matching valid signing identities', () => {
    const expired = buildTestCertPem({
      cn: 'Apple Development: Expired',
      ou: 'EXP1234567',
      ...expiredRange,
    })
    const orphaned = buildTestCertPem({
      cn: 'Apple Development: No Private Key',
      ou: 'NOP1234567',
      ...validRange,
    })
    const valid = buildTestCertPem({
      cn: 'Apple Development: Valid',
      ou: 'ABCDE12345',
      ...validRange,
    })
    const combinedPem = [expired.pem, orphaned.pem, valid.pem].join('\n')
    const validIdentities = new Set([expired.fingerprint, valid.fingerprint])

    expect(extractDevelopmentTeamFromPem(combinedPem, validIdentities, now)).toBe('ABCDE12345')
    expect(extractDevelopmentTeamFromPem(expired.pem, validIdentities, now)).toBeNull()
    expect(extractDevelopmentTeamFromPem(orphaned.pem, validIdentities, now)).toBeNull()
  })

  it('prefers explicit AGENT_DEVICE_IOS_TEAM_ID and falls back to keychain', async () => {
    const runSecurity = vi.fn(async () => '')
    expect(
      await findDevelopmentTeam({ AGENT_DEVICE_IOS_TEAM_ID: 'team987654' }, { runSecurity }),
    ).toBe('TEAM987654')
    expect(runSecurity).not.toHaveBeenCalled()

    const valid = buildTestCertPem({
      cn: 'Apple Development: Signer',
      ou: 'ZXCVB12345',
      ...validRange,
    })
    const fromKeychain = await findDevelopmentTeam(
      {},
      {
        now,
        runSecurity: async (args) => {
          if (args[0] === 'find-identity') {
            return `  1) ${valid.fingerprint} "Apple Development: Signer (ZXCVB12345)"\n     1 valid identities found\n`
          }
          if (args[0] === 'find-certificate') return valid.pem
          return null
        },
      },
    )
    expect(fromKeychain).toBe('ZXCVB12345')
  })

  it('returns null gracefully when security fails or finds no valid signing identities', async () => {
    expect(await findDevelopmentTeam({}, { runSecurity: async () => null })).toBeNull()
    expect(
      await findDevelopmentTeam(
        {},
        {
          runSecurity: async (args) =>
            args[0] === 'find-identity' ? '     0 valid identities found\n' : '',
        },
      ),
    ).toBeNull()
  })
})

describe('physical iOS runner failure classification', () => {
  it('classifies untrusted developer ahead of code signature mentions', () => {
    expect(
      classifyPhysicalIosRunnerFailure({
        stderr:
          'Unable to launch com.callstack.agentdevice.runner.uitests.xctrunner because it has an invalid code signature, inadequate entitlements or its profile has not been explicitly trusted by the user.',
      }),
    ).toBe('runner-untrusted')

    expect(
      classifyPhysicalIosRunnerFailure({
        message: 'Untrusted Developer: verify app in Settings > General > VPN & Device Management',
      }),
    ).toBe('runner-untrusted')
  })

  it('classifies UI Automation failures without confusing them with Developer Mode', () => {
    expect(
      classifyPhysicalIosRunnerFailure({
        stderr:
          'Error Domain=com.apple.dt.XCTest.XCTFuture Code=1000 "Timed out while enabling automation mode."',
      }),
    ).toBe('ui-automation-off')

    expect(
      classifyPhysicalIosRunnerFailure({
        logTail: 'Failed to start automation session. Turn on Enable UI Automation in Settings.',
      }),
    ).toBe('ui-automation-off')

    expect(
      classifyPhysicalIosRunnerFailure({
        reason: 'device_developer_mode_disabled',
        message: 'Developer Mode is disabled on the device',
      }),
    ).toBeNull()

    expect(
      classifyPhysicalIosRunnerFailure({
        reason: 'devtools_security_developer_mode_disabled',
        message: 'Run sudo DevToolsSecurity -enable',
      }),
    ).toBeNull()
  })

  it('classifies signing and provisioning profile failures as runner-unsigned', () => {
    expect(
      classifyPhysicalIosRunnerFailure({
        reason: 'signing_no_development_team',
        message: 'xcodebuild build-for-testing failed',
      }),
    ).toBe('runner-unsigned')

    expect(
      classifyPhysicalIosRunnerFailure({
        stderr:
          'error: No profiles for "com.callstack.agentdevice.runner" were found: Xcode couldn\'t find any iOS App Development provisioning profiles.',
      }),
    ).toBe('runner-unsigned')

    expect(
      classifyPhysicalIosRunnerFailure({
        code: 'IOS_RUNNER_DEVICE_NOT_PROVISIONED',
        stderr: '0xe8008012',
      }),
    ).toBe('runner-unsigned')
  })

  it('does not misclassify pairing prompts or generic timeouts', () => {
    expect(
      classifyPhysicalIosRunnerFailure({
        stderr: 'The device must be paired. Unlock and tap Trust This Computer.',
      }),
    ).toBeNull()

    expect(
      classifyPhysicalIosRunnerFailure({
        reason: 'build_failed_unclassified',
        message: 'Runner did not accept connection',
      }),
    ).toBeNull()
  })

  it('parses agent-device --json error payloads and reads runner logs only inside allowed dirs', async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), 'kettu-ios-log-'))
    try {
      const logFile = path.join(tempDir, 'runner.log')
      await writeFile(logFile, 'xcodebuild: profile has not been explicitly trusted by the user\n')
      const json = JSON.stringify({
        ok: false,
        error: {
          code: 'COMMAND_FAILED',
          message: 'Runner did not accept connection (xcodebuild exited early)',
          details: {
            reason: 'xcodebuild_exited_early',
            logPath: logFile,
            xcodebuild: { exitCode: 65, stderr: 'exit 65' },
          },
        },
      })
      const parsed = parseAgentDeviceFailureJson(json, '')
      expect(parsed.logPath).toBe(logFile)
      expect(parsed.stderr).toContain('exit 65')
      parsed.logTail = await readRunnerLogTail(parsed.logPath!, null)
      expect(classifyPhysicalIosRunnerFailure(parsed)).toBe('runner-untrusted')

      // Rejects paths outside tmpdir and dataDir.
      expect(await readRunnerLogTail('/etc/hosts', tempDir)).toBeNull()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('physicalIosProblems state synthesis', () => {
  it('never marks trust or UI Automation done before runner verification', () => {
    expect(physicalIosProblems([], false, { status: 'unverified' })).toEqual([
      'runner-unsigned',
      'runner-untrusted',
      'ui-automation-off',
    ])
    expect(physicalIosProblems([], true, { status: 'unverified' })).toEqual([
      'runner-untrusted',
      'ui-automation-off',
    ])
    expect(physicalIosProblems(['developer-mode-off'], true, { status: 'unverified' })).toEqual([
      'developer-mode-off',
      'runner-untrusted',
      'ui-automation-off',
    ])
    expect(
      physicalIosProblems([], true, {
        status: 'failed',
        problem: 'runner-untrusted',
        team: 'TEAM123456',
        at: 1,
      }),
    ).toEqual(['runner-untrusted', 'ui-automation-off'])
    expect(
      physicalIosProblems([], true, {
        status: 'failed',
        problem: 'ui-automation-off',
        team: 'TEAM123456',
        at: 1,
      }),
    ).toEqual(['ui-automation-off'])
    expect(physicalIosProblems([], true, { status: 'ready', team: 'TEAM123456' })).toEqual([])
  })
})

describe('DeviceManager physical iPhone prerequisite checks', () => {
  const managers: DeviceManager[] = []
  let dataDir: string
  let events: { port: string | null; event: DeviceEvent }[]

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'kettu-ios-physical-'))
    events = []
    discoveryFake.xcrun = '/usr/bin/xcrun'
    discoveryFake.simulators = [{ ...SIMULATOR }]
    discoveryFake.physicalIos = [{ ...PHYSICAL_IPHONE }]
    discoveryFake.android = [{ ...ANDROID_PHONE }]
  })

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.dispose()))
    await rm(dataDir, { recursive: true, force: true })
  })

  function createManager(options: {
    team?: () => Promise<string | null>
    probe?: (device: FoundDevice, signal: AbortSignal) => Promise<PhysicalIosRunnerProbeResult>
  }): DeviceManager {
    const dm = new DeviceManager({
      platform: 'darwin',
      dataDir,
      env: async () => ({}),
      resourcesPath: null,
      emit: (port, event) => events.push({ port, event }),
      findIosSigningTeam: options.team ?? (async () => 'TEAM123456'),
      probeIosRunner: options.probe,
      log: () => undefined,
    })
    managers.push(dm)
    return dm
  }

  it('reports runner-unsigned, runner-untrusted and ui-automation-off when signing team is missing and leaves simulators and Android untouched', async () => {
    const probe = vi.fn<() => Promise<PhysicalIosRunnerProbeResult>>(async () => ({ ok: true }))
    const dm = createManager({ team: async () => null, probe })

    const devices = await dm.list()
    expect(devices.find((d) => d.id === PHYSICAL_IPHONE.id)?.problems).toEqual([
      'runner-unsigned',
      'runner-untrusted',
      'ui-automation-off',
    ])
    expect(devices.find((d) => d.id === SIMULATOR.id)?.problems).toEqual([])
    expect(devices.find((d) => d.id === ANDROID_PHONE.id)?.problems).toEqual([])

    // Opening a physical iPhone without a signing team does not launch a doomed runner probe.
    await dm.open(PHYSICAL_IPHONE.id, 's1')
    expect(probe).not.toHaveBeenCalled()
  })

  it('probes an opened physical iPhone through untrusted -> UI Automation off -> ready', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-11-28T00:00:00Z'))
      const responses: PhysicalIosRunnerProbeResult[] = [
        { ok: false, problem: 'runner-untrusted', message: 'not explicitly trusted' },
        { ok: false, problem: 'ui-automation-off', message: 'Enable UI Automation is off' },
        { ok: true },
      ]
      const probe = vi.fn(
        async (): Promise<PhysicalIosRunnerProbeResult> => responses.shift() ?? { ok: true },
      )
      const dm = createManager({ probe })

      // Listing before opening does not spawn xcodebuild probes.
      const beforeOpen = await dm.list()
      expect(beforeOpen.find((d) => d.id === PHYSICAL_IPHONE.id)?.problems).toEqual([
        'runner-untrusted',
        'ui-automation-off',
      ])
      expect(probe).not.toHaveBeenCalled()

      // Opening triggers the first probe -> runner-untrusted.
      await dm.open(PHYSICAL_IPHONE.id, 's1')
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
      await vi.waitFor(() =>
        expect(dm.info(PHYSICAL_IPHONE.id)?.problems).toEqual([
          'runner-untrusted',
          'ui-automation-off',
        ]),
      )

      // Within retry backoff window, polling does not spam probes.
      await dm.list()
      expect(probe).toHaveBeenCalledTimes(1)

      // After retry window, second probe reports ui-automation-off (trust is now checked off).
      vi.advanceTimersByTime(9_000)
      await dm.list()
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
      await vi.waitFor(() =>
        expect(dm.info(PHYSICAL_IPHONE.id)?.problems).toEqual(['ui-automation-off']),
      )

      // After user enables UI Automation, next probe passes and clears all problems.
      vi.advanceTimersByTime(9_000)
      await dm.list()
      await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(3))
      await vi.waitFor(() => expect(dm.info(PHYSICAL_IPHONE.id)?.problems).toEqual([]))
      expect(events.some((entry) => entry.event.type === 'devices.changed')).toBe(true)

      // Once ready, further refreshes do not re-probe.
      vi.advanceTimersByTime(30_000)
      await dm.list()
      expect(probe).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports runner-unsigned when keychain has a team but runner signing fails on the device', async () => {
    const probe = vi.fn<() => Promise<PhysicalIosRunnerProbeResult>>(async () => ({
      ok: false,
      problem: 'runner-unsigned',
      message: 'No provisioning profile covers this device',
    }))
    const dm = createManager({ probe })

    await dm.open(PHYSICAL_IPHONE.id, 's1')
    await vi.waitFor(() =>
      expect(dm.info(PHYSICAL_IPHONE.id)?.problems).toEqual([
        'runner-unsigned',
        'runner-untrusted',
        'ui-automation-off',
      ]),
    )
  })

  it('resets verified state when the physical iPhone disconnects or loses USB / Developer Mode', async () => {
    const probe = vi.fn<() => Promise<PhysicalIosRunnerProbeResult>>(async () => ({ ok: true }))
    const dm = createManager({ probe })

    await dm.open(PHYSICAL_IPHONE.id, 's1')
    await vi.waitFor(() => expect(dm.info(PHYSICAL_IPHONE.id)?.problems).toEqual([]))

    // Unplug the iPhone.
    discoveryFake.physicalIos = []
    await dm.list()

    // Replug it with Developer Mode turned off; must not stay marked ready.
    discoveryFake.physicalIos = [{ ...PHYSICAL_IPHONE, problems: ['developer-mode-off'] }]
    const listed = await dm.list()
    expect(listed.find((d) => d.id === PHYSICAL_IPHONE.id)?.problems).toEqual([
      'developer-mode-off',
      'runner-untrusted',
      'ui-automation-off',
    ])
  })

  it('skips signing and runner checks cleanly when Xcode is not installed', async () => {
    discoveryFake.xcrun = null
    const findTeam = vi.fn(async () => 'TEAM123456')
    const probe = vi.fn<() => Promise<PhysicalIosRunnerProbeResult>>(async () => ({ ok: true }))
    const dm = createManager({ team: findTeam, probe })

    const listed = await dm.list()
    expect(listed.map((d) => d.id)).toEqual([ANDROID_PHONE.id])
    expect(findTeam).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
  })

  it('handles signing check errors gracefully without breaking device listing', async () => {
    const dm = createManager({
      team: async () => {
        throw new Error('security binary unavailable')
      },
    })

    const listed = await dm.list()
    expect(listed.find((d) => d.id === PHYSICAL_IPHONE.id)?.problems).toEqual([
      'runner-unsigned',
      'runner-untrusted',
      'ui-automation-off',
    ])
    expect(listed.find((d) => d.id === SIMULATOR.id)?.problems).toEqual([])
  })
})
