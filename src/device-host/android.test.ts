import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootEmulator } from './android'

const adb = vi.hoisted(() => ({
  /** What `adb devices` lists: before the emulator starts, then while it boots. */
  before: '',
  during: '',
  /** The AVD each emulator console answers with. */
  avds: new Map<string, string>(),
  calls: [] as string[][],
  /** The emulator process `emu kill` stops, as the console of the emulator it started would. */
  ours: null as { serial: string; pid: () => Promise<number> } | null,
}))

vi.mock('./discovery', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./discovery')>()),
  run: async (_file: string, args: string[]) => {
    adb.calls.push(args)
    if (args[0] === 'devices') return adb.calls.length === 1 ? adb.before : adb.during
    if (args[2] === 'emu' && args[3] === 'avd') return `${adb.avds.get(args[1]!) ?? ''}\r\nOK\r\n`
    if (args[2] === 'emu' && args[3] === 'kill' && args[1] === adb.ours?.serial) {
      process.kill(await adb.ours.pid(), 'SIGTERM')
    }
    return ''
  },
}))

const AVD = 'Pixel_9_Pro'
const USERS = 'emulator-5554\tdevice\n'

let dir: string
let pidFile: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-emulator-'))
  pidFile = path.join(dir, 'pid')
  adb.before = `List of devices attached\n${USERS}`
  adb.during = adb.before
  adb.avds = new Map([['emulator-5554', 'Users_Pixel']])
  adb.calls = []
  adb.ours = null
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** An emulator program that records its pid and runs until stopped, or exits at once. */
async function emulator(body = 'exec sleep 30'): Promise<string> {
  const file = path.join(dir, 'emulator')
  await writeFile(file, `#!/bin/sh\necho $$ > "$KETTU_TEST_PID"\n${body}\n`)
  await chmod(file, 0o755)
  return file
}

const env = () => ({ ...process.env, KETTU_TEST_PID: pidFile })
const pid = async () => Number(await readFile(pidFile, 'utf8'))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const touched = (serial: string) => adb.calls.some((args) => args[1] === serial)

describe.skipIf(process.platform === 'win32')('an emulator that does not finish booting', () => {
  it('is stopped once the wait for it ends', async () => {
    const error = await bootEmulator(await emulator(), '/sdk/adb', AVD, env(), 500).catch(
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(Error)
    expect(alive(await pid())).toBe(false)
    expect(touched('emulator-5554')).toBe(false)
  })

  it('is stopped through its console once listed, leaving the emulators of other AVDs on', async () => {
    adb.during = `${adb.before}emulator-5560\toffline\nemulator-5562\toffline\n`
    adb.avds.set('emulator-5560', AVD).set('emulator-5562', 'Users_Tablet')
    adb.ours = { serial: 'emulator-5560', pid }

    const error = await bootEmulator(await emulator(), '/sdk/adb', AVD, env(), 500).catch(
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(Error)
    expect(alive(await pid())).toBe(false)
    expect(adb.calls).toContainEqual(['-s', 'emulator-5560', 'emu', 'kill'])
    expect(adb.calls).not.toContainEqual(['-s', 'emulator-5562', 'emu', 'kill'])
    expect(touched('emulator-5554')).toBe(false)
  })

  it('leaves an emulator of the same AVD on once its own process exited', async () => {
    adb.during = `${adb.before}emulator-5560\toffline\n`
    adb.avds.set('emulator-5560', AVD)

    const error = await bootEmulator(await emulator('exit 1'), '/sdk/adb', AVD, env(), 500).catch(
      (error: unknown) => error,
    )
    expect(error).toBeInstanceOf(Error)
    expect(adb.calls.filter((args) => args[2] === 'emu')).toEqual([])
  })
})
