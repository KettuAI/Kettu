import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDevicectl } from './discovery'
import { packageRoot } from './runtime'

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

interface FakeCommandCall {
  cmd: string
  args: string[]
  timeoutMs?: number
}

interface PhysicalControl {
  backend: 'coredevice' | 'xctest'
  ensureReady(
    device: { id: string; iosPhysicalDeviceBackend?: string },
    signal?: AbortSignal,
  ): Promise<void>
}

interface ToolProvider {
  runCommand: (
    cmd: string,
    args: string[],
    options?: { allowFailure?: boolean; signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<CommandResult>
}

interface ToolProviderModule {
  n: (overrides?: Partial<ToolProvider>) => ToolProvider
  l: <T>(provider: ToolProvider, fn: () => Promise<T>) => Promise<T>
}

interface PhysicalFacadeModule {
  resolveIosPhysicalDeviceControl: (device: {
    id: string
    iosPhysicalDeviceBackend?: string
  }) => PhysicalControl
}

interface AppleInventoryDevice {
  platform: string
  id: string
  name: string
  kind: string
  target: string
  appleOs?: string
  iosPhysicalDeviceBackend?: string
}

interface InventoryModule {
  createAppleInventorySource: (host: {
    hostOs: string
    hostName: string
    appleTools: {
      isXcrunAvailable: (signal?: AbortSignal) => Promise<boolean>
      run: (
        req: { tool: string; args: string[]; allowFailure?: boolean; timeoutMs?: number },
        signal?: AbortSignal,
      ) => Promise<CommandResult>
    }
    files: {
      createTemporaryTextFile: (opts: { prefix: string; suffix: string }) => Promise<{
        path: string
        readText: () => Promise<string>
        [Symbol.asyncDispose]: () => Promise<void>
      }>
    }
    observations: {
      deviceBooted: (device: unknown) => Promise<void>
    }
  }) => {
    discover: (
      request: { platform?: string; kind?: string; udid?: string },
      ctx: { signal: AbortSignal },
    ) => Promise<AppleInventoryDevice[]>
  }
}

async function importAgentDeviceModule<T>(relativePath: string): Promise<T> {
  const fullPath = path.join(packageRoot('agent-device'), relativePath)
  return (await import(pathToFileURL(fullPath).href)) as T
}

const IPAD_UDID = '00008112-0011223344556677'
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('parseDevicectl', () => {
  it('accepts physical devices reporting iOS or iPadOS platform and ignores simulators', () => {
    const json = JSON.stringify({
      result: {
        devices: [
          {
            identifier: 'A1',
            hardwareProperties: {
              udid: '00008150-000125C03AE2401C',
              reality: 'physical',
              platform: 'iOS',
              marketingName: 'iPhone Air',
              productType: 'iPhone18,4',
            },
            connectionProperties: {
              transportType: 'wired',
              pairingState: 'paired',
            },
            deviceProperties: {
              name: 'My iPhone',
              osVersionNumber: '26.3.1',
              developerModeStatus: 'enabled',
              ddiServicesAvailable: true,
            },
          },
          {
            identifier: 'A2',
            hardwareProperties: {
              udid: IPAD_UDID,
              reality: 'physical',
              platform: 'iPadOS',
              marketingName: 'iPad Pro',
              productType: 'iPad16,3',
            },
            connectionProperties: {
              transportType: 'wired',
              pairingState: 'paired',
            },
            deviceProperties: {
              name: 'Lab iPad',
              osVersionNumber: '26.3.1',
              developerModeStatus: 'enabled',
              ddiServicesAvailable: true,
            },
          },
          {
            identifier: 'SIM1',
            hardwareProperties: {
              udid: '5B16E000-67EA-488C-BF12-895F1D400139',
              reality: 'simulated',
              platform: 'iOS',
            },
            deviceProperties: { name: 'Simulator' },
          },
          {
            identifier: 'WATCH1',
            hardwareProperties: {
              udid: 'WATCH-UDID',
              reality: 'physical',
              platform: 'watchOS',
            },
            deviceProperties: { name: 'Apple Watch' },
          },
        ],
      },
    })

    const devices = parseDevicectl(json)
    expect(devices).toHaveLength(2)
    expect(devices[0]).toMatchObject({
      id: 'ios:00008150-000125C03AE2401C',
      platform: 'ios',
      kind: 'physical',
      name: 'My iPhone',
      connection: 'usb',
      problems: [],
    })
    expect(devices[1]).toMatchObject({
      id: `ios:${IPAD_UDID}`,
      platform: 'ios',
      kind: 'physical',
      name: 'Lab iPad',
      osVersion: '26.3.1',
      model: 'iPad Pro',
      state: 'connected',
      connection: 'usb',
      problems: [],
      target: IPAD_UDID,
    })
  })
})

async function runWithFakeCommands<T>(
  runCommand: ToolProvider['runCommand'],
  fn: () => Promise<T>,
): Promise<T> {
  const { n: createToolProvider, l: withToolProvider } =
    await importAgentDeviceModule<ToolProviderModule>('dist/src/tool-provider.js')
  return withToolProvider(createToolProvider({ runCommand }), fn)
}

describe('patched agent-device physical iOS/iPadOS control', () => {
  it('checks readiness via xcdevice list instead of removed xcdevice wait', async () => {
    const { resolveIosPhysicalDeviceControl } = await importAgentDeviceModule<PhysicalFacadeModule>(
      'dist/src/physical-device-facade.js',
    )

    const calls: FakeCommandCall[] = []
    const device = { id: IPAD_UDID, iosPhysicalDeviceBackend: 'xctest' }

    await runWithFakeCommands(
      async (cmd, args, options) => {
        calls.push({ cmd, args, timeoutMs: options?.timeoutMs })
        if (args[0] === 'xcdevice' && args[1] === 'wait') {
          return { exitCode: 1, stdout: '', stderr: 'Unknown command provided: "wait".' }
        }
        if (args[0] === 'xcdevice' && args[1] === 'list') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                ignored: false,
                simulator: false,
                identifier: IPAD_UDID,
                platform: 'com.apple.platform.iphoneos',
                available: true,
                name: 'Lab iPad',
                modelName: 'iPad Pro',
              },
            ]),
            stderr: '',
          }
        }
        return { exitCode: 1, stdout: '', stderr: `unexpected command: ${args.join(' ')}` }
      },
      async () => {
        const control = resolveIosPhysicalDeviceControl(device)
        expect(control.backend).toBe('xctest')
        await control.ensureReady(device)
      },
    )

    expect(calls).toHaveLength(1)
    expect(calls[0]?.cmd).toBe('xcrun')
    expect(calls[0]?.args).toEqual(['xcdevice', 'list', '--timeout=2'])
    expect(calls.some((call) => call.args.includes('wait'))).toBe(false)
  })

  it('parses xcdevice list with a deprecation prefix and retries until the device becomes available', async () => {
    const { resolveIosPhysicalDeviceControl } = await importAgentDeviceModule<PhysicalFacadeModule>(
      'dist/src/physical-device-facade.js',
    )

    let attempt = 0
    const device = { id: IPAD_UDID, iosPhysicalDeviceBackend: 'xctest' }

    await runWithFakeCommands(
      async (_cmd, args) => {
        if (args[0] === 'xcdevice' && args[1] === 'list') {
          attempt += 1
          const payload = JSON.stringify([
            {
              ignored: false,
              simulator: false,
              identifier: IPAD_UDID.toLowerCase(),
              available: attempt >= 2,
              name: 'Lab iPad',
            },
          ])
          return {
            exitCode: 0,
            stdout: `WARNING: xcdevice is deprecated.\n${payload}`,
            stderr: '',
          }
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected' }
      },
      async () => {
        await resolveIosPhysicalDeviceControl(device).ensureReady(device)
      },
    )

    expect(attempt).toBe(2)
  })

  it('surfaces xcdevice error details when the device stays unavailable', async () => {
    const { resolveIosPhysicalDeviceControl } = await importAgentDeviceModule<PhysicalFacadeModule>(
      'dist/src/physical-device-facade.js',
    )

    const device = { id: IPAD_UDID, iosPhysicalDeviceBackend: 'xctest' }
    let caught: unknown

    await runWithFakeCommands(
      async (_cmd, args) => {
        if (args[0] === 'xcdevice' && args[1] === 'list') {
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                ignored: false,
                simulator: false,
                identifier: IPAD_UDID,
                available: false,
                name: 'Lab iPad',
                error: {
                  code: -27,
                  domain: 'com.apple.dt.deviceprep',
                  description: 'Browsing on the local area network for Lab iPad',
                  recoverySuggestion: 'Unlock the iPad and connect it by USB cable.',
                },
              },
            ]),
            stderr: '',
          }
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected' }
      },
      async () => {
        try {
          await resolveIosPhysicalDeviceControl(device).ensureReady(device)
        } catch (error) {
          caught = error
        }
      },
    )

    expect(caught).toBeInstanceOf(Error)
    const err = caught as Error & { code?: string; details?: { hint?: string; deviceId?: string } }
    expect(err.code).toBe('COMMAND_FAILED')
    expect(err.message).toContain('Browsing on the local area network for Lab iPad')
    expect(err.details?.hint).toBe('Unlock the iPad and connect it by USB cable.')
    expect(err.details?.deviceId).toBe(IPAD_UDID)
  })

  it('reports a clear error when the device is missing from xcdevice list', async () => {
    const { resolveIosPhysicalDeviceControl } = await importAgentDeviceModule<PhysicalFacadeModule>(
      'dist/src/physical-device-facade.js',
    )

    const device = { id: IPAD_UDID, iosPhysicalDeviceBackend: 'xctest' }
    let caught: unknown

    await runWithFakeCommands(
      async () => ({
        exitCode: 0,
        stdout: JSON.stringify([
          {
            ignored: false,
            simulator: false,
            identifier: 'OTHER-DEVICE',
            available: true,
            name: 'My Mac',
          },
        ]),
        stderr: '',
      }),
      async () => {
        try {
          await resolveIosPhysicalDeviceControl(device).ensureReady(device)
        } catch (error) {
          caught = error
        }
      },
    )

    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain(
      `device ${IPAD_UDID} was not found in xcdevice list`,
    )
  })

  it('falls back to xctrace list devices when xcdevice list fails, accepting online and rejecting offline devices', async () => {
    const { resolveIosPhysicalDeviceControl } = await importAgentDeviceModule<PhysicalFacadeModule>(
      'dist/src/physical-device-facade.js',
    )

    const device = { id: IPAD_UDID, iosPhysicalDeviceBackend: 'xctest' }

    // Online under `== Devices ==` succeeds.
    await runWithFakeCommands(
      async (_cmd, args) => {
        if (args[0] === 'xcdevice') {
          return { exitCode: 1, stdout: '', stderr: 'xcdevice removed' }
        }
        if (args[0] === 'xctrace' && args[1] === 'list' && args[2] === 'devices') {
          return {
            exitCode: 0,
            stdout: `== Devices ==\nLab iPad (26.3.1) (${IPAD_UDID})\n\n== Simulators ==\n`,
            stderr: '',
          }
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected' }
      },
      async () => {
        await resolveIosPhysicalDeviceControl(device).ensureReady(device)
      },
    )

    // Listed only under `== Devices Offline ==` fails clearly.
    let offlineError: unknown
    await runWithFakeCommands(
      async (_cmd, args) => {
        if (args[0] === 'xcdevice') {
          return { exitCode: 1, stdout: '', stderr: 'xcdevice removed' }
        }
        if (args[0] === 'xctrace' && args[1] === 'list' && args[2] === 'devices') {
          return {
            exitCode: 0,
            stdout: `== Devices ==\nMy Mac (MAC-ID)\n\n== Devices Offline ==\nLab iPad (26.3.1) (${IPAD_UDID})\n`,
            stderr: '',
          }
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected' }
      },
      async () => {
        try {
          await resolveIosPhysicalDeviceControl(device).ensureReady(device)
        } catch (error) {
          offlineError = error
        }
      },
    )

    expect(offlineError).toBeInstanceOf(Error)
    expect((offlineError as Error).message).toContain(
      'offline or not found in xctrace list devices',
    )
  })

  it('gives devicectl list devices at least a 15s timeout and detects iPadOS physical devices', async () => {
    const { createAppleInventorySource } =
      await importAgentDeviceModule<InventoryModule>('dist/src/inventory2.js')

    const dir = await mkdtemp(path.join(tmpdir(), 'kettu-agent-device-inv-'))
    tempDirs.push(dir)
    let devicectlTimeoutMs: number | undefined

    const source = createAppleInventorySource({
      hostOs: 'darwin',
      hostName: 'Test Mac',
      appleTools: {
        isXcrunAvailable: async () => true,
        run: async (req) => {
          if (req.tool === 'simctl') {
            return { exitCode: 0, stdout: JSON.stringify({ devices: {} }), stderr: '' }
          }
          if (req.tool === 'devicectl') {
            devicectlTimeoutMs = req.timeoutMs
            const outIdx = req.args.indexOf('--json-output')
            const outPath = outIdx >= 0 ? req.args[outIdx + 1] : undefined
            if (outPath) {
              await writeFile(
                outPath,
                JSON.stringify({
                  result: {
                    devices: [
                      {
                        identifier: 'CORE-ID',
                        hardwareProperties: {
                          udid: IPAD_UDID,
                          platform: 'iPadOS',
                          marketingName: 'iPad Pro',
                        },
                        deviceProperties: {
                          name: 'Lab Tablet',
                          osVersionNumber: '26.3.1',
                        },
                      },
                    ],
                  },
                }),
                'utf8',
              )
            }
            return { exitCode: 0, stdout: '', stderr: '' }
          }
          if (req.tool === 'xctrace') {
            return { exitCode: 0, stdout: '== Devices ==\n', stderr: '' }
          }
          return { exitCode: 1, stdout: '', stderr: '' }
        },
      },
      files: {
        createTemporaryTextFile: async ({ prefix, suffix }) => {
          const filePath = path.join(dir, `${prefix}test${suffix}`)
          return {
            path: filePath,
            readText: () => readFile(filePath, 'utf8'),
            [Symbol.asyncDispose]: async () => {
              await rm(filePath, { force: true })
            },
          }
        },
      },
      observations: {
        deviceBooted: async () => undefined,
      },
    })

    const devices = await source.discover(
      { platform: 'ios', udid: IPAD_UDID },
      { signal: new AbortController().signal },
    )

    expect(devicectlTimeoutMs).toBeGreaterThanOrEqual(15_000)
    const ipad = devices.find((entry) => entry.id === IPAD_UDID)
    expect(ipad).toMatchObject({
      platform: 'apple',
      id: IPAD_UDID,
      name: 'Lab Tablet',
      kind: 'device',
      target: 'mobile',
      appleOs: 'ipados',
      iosPhysicalDeviceBackend: 'coredevice',
    })
  })
})
