// Finding the tools and the devices: Xcode's `simctl` and `devicectl` on macOS, the Android SDK's
// `adb` and `emulator` anywhere.

import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { findCommand, getEnv, isExecutableFile, type Env } from '../agent-host/find-command'
import type { DeviceKind, DevicePlatform, DeviceProblem, DeviceState } from '@shared/device-host'
import type { Platform } from '@shared/platform'

export interface Tools {
  xcrun: string | null
  adb: string | null
  emulator: string | null
}

/** A device as a tool lists it, before the host adds who holds it. */
export interface FoundDevice {
  id: string
  platform: DevicePlatform
  kind: DeviceKind
  name: string
  osVersion: string | null
  model: string | null
  state: DeviceState
  connection: 'usb' | 'network' | null
  problems: DeviceProblem[]
  /** The UDID or adb serial the tools take; an AVD's name while it is not running. */
  target: string
}

const LIST_TIMEOUT_MS = 15_000

export function run(
  file: string,
  args: string[],
  env: Env,
  timeout = LIST_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr: String(stderr) }))
        else resolve(String(stdout))
      },
    )
  })
}

/** The SDK folders Android Studio, the command-line tools and Homebrew install to. */
function sdkCandidates(env: Env, platform: Platform): string[] {
  const home = os.homedir()
  const fromEnv = ['ANDROID_HOME', 'ANDROID_SDK_ROOT']
    .map((name) => getEnv(env, name, platform))
    .filter((value): value is string => !!value)
  if (platform === 'darwin') {
    return [
      ...fromEnv,
      path.join(home, 'Library/Android/sdk'),
      '/opt/homebrew/share/android-commandlinetools',
      '/usr/local/share/android-commandlinetools',
    ]
  }
  if (platform === 'win32') {
    const local = getEnv(env, 'LOCALAPPDATA', platform)
    return [...fromEnv, ...(local ? [path.win32.join(local, 'Android', 'Sdk')] : [])]
  }
  return [...fromEnv, path.join(home, 'Android/Sdk'), path.join(home, 'Android/sdk')]
}

async function inSdk(env: Env, platform: Platform, relative: string): Promise<string | null> {
  const exe = platform === 'win32' ? `${relative}.exe` : relative
  for (const root of sdkCandidates(env, platform)) {
    const file = path.join(root, exe)
    if (await isExecutableFile(file, platform)) return file
  }
  return null
}

export async function findTools(env: Env, platform: Platform): Promise<Tools> {
  const isExecutable = (file: string): Promise<boolean> => isExecutableFile(file, platform)
  const onPath = (command: string): Promise<string | null> =>
    findCommand(command, { platform, env, isExecutable })
  const xcrun = platform === 'darwin' ? await hasXcode(env) : null
  const adb = (await inSdk(env, platform, 'platform-tools/adb')) ?? (await onPath('adb'))
  const emulator = (await inSdk(env, platform, 'emulator/emulator')) ?? (await onPath('emulator'))
  return { xcrun, adb, emulator }
}

/** `xcrun` when Xcode itself is installed, not only the command-line tools, which have no simctl. */
async function hasXcode(env: Env): Promise<string | null> {
  const xcrun = '/usr/bin/xcrun'
  try {
    await access(xcrun)
    await run(xcrun, ['simctl', 'help'], env, 10_000)
    return xcrun
  } catch {
    return null
  }
}

interface SimctlDevice {
  udid: string
  name: string
  state: string
  isAvailable?: boolean
  deviceTypeIdentifier?: string
}

const IOS_RUNTIME = /^com\.apple\.CoreSimulator\.SimRuntime\.iOS-(\d+)-(\d+)(?:-(\d+))?$/

export function parseSimctl(json: string): FoundDevice[] {
  const parsed = JSON.parse(json) as { devices?: Record<string, SimctlDevice[]> }
  const found: FoundDevice[] = []
  for (const [runtime, devices] of Object.entries(parsed.devices ?? {})) {
    const match = IOS_RUNTIME.exec(runtime)
    if (!match) continue
    const osVersion = [match[1], match[2], match[3]].filter(Boolean).join('.')
    for (const device of devices) {
      if (device.isAvailable === false) continue
      const state: DeviceState =
        device.state === 'Booted' ? 'booted' : device.state === 'Booting' ? 'booting' : 'shutdown'
      found.push({
        id: `ios-sim:${device.udid}`,
        platform: 'ios',
        kind: 'simulator',
        name: device.name,
        osVersion,
        model: device.deviceTypeIdentifier?.split('.').pop()?.replace(/-/g, ' ') ?? null,
        state,
        connection: null,
        problems: [],
        target: device.udid,
      })
    }
  }
  return found
}

export async function listSimulators(xcrun: string, env: Env): Promise<FoundDevice[]> {
  return parseSimctl(await run(xcrun, ['simctl', 'list', '-j', 'devices', 'available'], env))
}

interface DevicectlDevice {
  identifier?: string
  connectionProperties?: { transportType?: string; pairingState?: string; tunnelState?: string }
  deviceProperties?: {
    name?: string
    osVersionNumber?: string
    developerModeStatus?: string
    ddiServicesAvailable?: boolean
    bootState?: string
  }
  hardwareProperties?: {
    udid?: string
    reality?: string
    platform?: string
    marketingName?: string
    productType?: string
  }
}

export function parseDevicectl(json: string): FoundDevice[] {
  const parsed = JSON.parse(json) as { result?: { devices?: DevicectlDevice[] } }
  const found: FoundDevice[] = []
  for (const device of parsed.result?.devices ?? []) {
    const hardware = device.hardwareProperties ?? {}
    if (hardware.reality !== 'physical' || hardware.platform !== 'iOS' || !hardware.udid) continue
    const connection = device.connectionProperties ?? {}
    const properties = device.deviceProperties ?? {}
    const problems: DeviceProblem[] = []
    if (connection.pairingState && connection.pairingState !== 'paired') problems.push('not-paired')
    if (properties.developerModeStatus === 'disabled') problems.push('developer-mode-off')
    if (properties.ddiServicesAvailable === false) problems.push('ddi-not-mounted')
    const transport = connection.transportType
    const usb = transport === 'wired'
    if (!usb) problems.push('usb-required')
    found.push({
      id: `ios:${hardware.udid}`,
      platform: 'ios',
      kind: 'physical',
      name: properties.name ?? hardware.marketingName ?? hardware.udid,
      osVersion: properties.osVersionNumber ?? null,
      model: hardware.marketingName ?? hardware.productType ?? null,
      state: transport ? 'connected' : 'unavailable',
      connection: usb ? 'usb' : transport ? 'network' : null,
      problems,
      target: hardware.udid,
    })
  }
  return found
}

export async function listPhysicalIos(xcrun: string, env: Env): Promise<FoundDevice[]> {
  return parseDevicectl(
    await run(xcrun, ['devicectl', 'list', 'devices', '--quiet', '--json-output', '-'], env),
  )
}

/** `adb devices -l`: a serial, its state and `key:value` details per line. */
export function parseAdbDevices(
  text: string,
): { serial: string; state: string; model: string | null }[] {
  const rows: { serial: string; state: string; model: string | null }[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\S+)\s+(device|unauthorized|offline|authorizing|connecting)\b(.*)$/.exec(line)
    if (!match) continue
    const model = /\bmodel:(\S+)/.exec(match[3]!)?.[1]?.replace(/_/g, ' ') ?? null
    rows.push({ serial: match[1]!, state: match[2]!, model })
  }
  return rows
}

export async function listAndroid(tools: Tools, env: Env): Promise<FoundDevice[]> {
  const found: FoundDevice[] = []
  const runningAvds = new Set<string>()
  if (tools.adb) {
    const rows = parseAdbDevices(await run(tools.adb, ['devices', '-l'], env).catch(() => ''))
    for (const row of rows) {
      const emulator = row.serial.startsWith('emulator-')
      let name = row.model ?? row.serial
      let osVersion: string | null = null
      if (row.state === 'device') {
        const props = await run(
          tools.adb,
          [
            '-s',
            row.serial,
            'shell',
            'getprop ro.build.version.release; getprop ro.boot.qemu.avd_name',
          ],
          env,
          5_000,
        ).catch(() => '')
        const [release, avd] = props.split(/\r?\n/).map((value) => value.trim())
        osVersion = release || null
        if (emulator && avd) {
          runningAvds.add(avd)
          name = avd.replace(/_/g, ' ')
        }
      }
      const problems: DeviceProblem[] = []
      if (row.state === 'unauthorized') problems.push('usb-debugging-unauthorized')
      if (row.state === 'offline') problems.push('offline')
      found.push({
        id: `android:${row.serial}`,
        platform: 'android',
        kind: emulator ? 'emulator' : 'physical',
        name,
        osVersion,
        model: row.model,
        state: row.state === 'device' ? (emulator ? 'booted' : 'connected') : 'unavailable',
        connection: emulator ? null : row.serial.includes(':') ? 'network' : 'usb',
        problems,
        target: row.serial,
      })
    }
  }
  if (tools.emulator) {
    const avds = (await run(tools.emulator, ['-list-avds'], env).catch(() => ''))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[\w.-]+$/.test(line))
    for (const avd of avds) {
      if (runningAvds.has(avd)) continue
      found.push({
        id: `avd:${avd}`,
        platform: 'android',
        kind: 'emulator',
        name: avd.replace(/_/g, ' '),
        osVersion: null,
        model: null,
        state: 'shutdown',
        connection: null,
        problems: [],
        target: avd,
      })
    }
  }
  return found
}
