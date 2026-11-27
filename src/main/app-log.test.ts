import { EventEmitter } from 'node:events'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowsSessionEndWatcher, type SessionEndWindow } from './windows-session-end'

const state = vi.hoisted(() => ({
  userData: '',
  logs: '',
  crashDumps: '',
  version: '0.1.28',
  appEmitter: null as EventEmitter | null,
  flushLogSync: vi.fn(),
}))

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  const emitter = (state.appEmitter ??= new Emitter())
  const app = Object.assign(emitter, {
    isPackaged: true,
    getVersion: () => state.version,
    getPath: (name: string) => {
      if (name === 'userData') return state.userData
      if (name === 'logs') return state.logs
      if (name === 'crashDumps') return state.crashDumps
      return state.userData
    },
    setAppLogsPath: vi.fn(),
    commandLine: {
      hasSwitch: () => false,
    },
  })
  return {
    app,
    BaseWindow: class {},
    crashReporter: { start: vi.fn() },
  }
})

vi.mock('@shared/log/process-log', () => ({
  VERBOSE_PREFIX: 'verbose-',
  flushLogSync: (...args: unknown[]) => state.flushLogSync(...args),
  logProcessFailures: vi.fn(),
  openProcessLog: vi.fn(),
  setLogLevel: vi.fn(),
  setVerboseRecords: vi.fn(),
  writeLog: vi.fn(),
}))

async function loadAppLog() {
  vi.resetModules()
  return import('./app-log')
}

describe('app-log running marker and clean exit handling', () => {
  let root = ''
  let exitListenersBefore: ((...args: unknown[]) => void)[] = []

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kettu-app-log-'))
    state.userData = join(root, 'userData')
    state.logs = join(root, 'logs')
    state.crashDumps = join(root, 'crashDumps')
    state.version = '0.1.28'
    state.appEmitter?.removeAllListeners()
    state.flushLogSync.mockReset()
    writeFileSync(join(root, '.keep'), '')
    // Ensure userData exists as Electron creates it before ready.
    mkdtempSync(join(root, 'tmp-'))
    exitListenersBefore = process.listeners('exit') as ((...args: unknown[]) => void)[]
  })

  afterEach(() => {
    const current = process.listeners('exit') as ((...args: unknown[]) => void)[]
    for (const listener of current) {
      if (!exitListenersBefore.includes(listener)) {
        process.removeListener('exit', listener)
      }
    }
    rmSync(root, { recursive: true, force: true })
  })

  function ensureUserData(): string {
    const dir = mkdtempSync(join(root, 'ud-'))
    state.userData = dir
    return dir
  }

  it('writes PID and version to the running marker and removes it immediately on will-quit', async () => {
    const dir = ensureUserData()
    const mod = await loadAppLog()
    mod.watchProcesses()
    await mod.markRunning(['Kettu.exe'])

    const marker = join(dir, 'running')
    expect(existsSync(marker)).toBe(true)
    expect(readFileSync(marker, 'utf8')).toBe(`${process.pid}\n0.1.28`)
    expect(mod.lastUnexpectedExit()).toBeNull()

    state.appEmitter!.emit('will-quit', { defaultPrevented: false })

    // Removed synchronously on will-quit without waiting for process exit.
    expect(existsSync(marker)).toBe(false)
    expect(state.flushLogSync).toHaveBeenCalledTimes(1)
  })

  it('does not remove the running marker if will-quit is prevented', async () => {
    const dir = ensureUserData()
    const mod = await loadAppLog()
    mod.watchProcesses()
    await mod.markRunning(['Kettu.exe'])

    const marker = join(dir, 'running')
    state.appEmitter!.emit('will-quit', { defaultPrevented: true })

    expect(existsSync(marker)).toBe(true)
    expect(state.flushLogSync).not.toHaveBeenCalled()
  })

  it('removes the running marker immediately on markCleanExit (Windows session-end / OS shutdown)', async () => {
    const dir = ensureUserData()
    const mod = await loadAppLog()
    await mod.markRunning(['Kettu.exe'])

    const marker = join(dir, 'running')
    expect(existsSync(marker)).toBe(true)

    mod.markCleanExit()
    expect(existsSync(marker)).toBe(false)
    expect(state.flushLogSync).toHaveBeenCalledTimes(1)

    // Subsequent launch sees no leftover marker and reports no unexpected exit.
    const nextRun = await loadAppLog()
    await nextRun.markRunning(['Kettu.exe'])
    expect(nextRun.lastUnexpectedExit()).toBeNull()
    expect(nextRun.unexpectedExitNotice()).toBeNull()
  })

  it('does not leave a marker behind if markCleanExit fires before markRunning finishes writing', async () => {
    const dir = ensureUserData()
    const mod = await loadAppLog()
    mod.markCleanExit()
    await mod.markRunning(['Kettu.exe'])

    expect(existsSync(join(dir, 'running'))).toBe(false)
  })

  it('still detects real crashes when the previous run leaves a marker without clean exit', async () => {
    const dir = ensureUserData()
    const firstRun = await loadAppLog()
    await firstRun.markRunning(['Kettu.exe'])
    // Simulate hard crash / SIGKILL: neither markCleanExit nor will-quit runs.
    expect(existsSync(join(dir, 'running'))).toBe(true)

    const nextRun = await loadAppLog()
    await nextRun.markRunning(['Kettu.exe'])
    expect(nextRun.lastUnexpectedExit()).not.toBeNull()
    expect(nextRun.unexpectedExitNotice()).not.toBeNull()

    nextRun.dismissUnexpectedExit()
    expect(nextRun.unexpectedExitNotice()).toBeNull()
    expect(nextRun.lastUnexpectedExit()).not.toBeNull()
  })

  it('ignores a leftover older-version marker when launched with --updated by the Windows updater', async () => {
    const dir = ensureUserData()
    writeFileSync(join(dir, 'running'), '12345\n0.1.27')

    state.version = '0.1.28'
    const mod = await loadAppLog()
    await mod.markRunning(['Kettu.exe', '--updated'])

    expect(mod.lastUnexpectedExit()).toBeNull()
    expect(readFileSync(join(dir, 'running'), 'utf8')).toBe(`${process.pid}\n0.1.28`)
  })

  it('ignores a legacy PID-only marker when launched with --updated during upgrade', async () => {
    const dir = ensureUserData()
    writeFileSync(join(dir, 'running'), '12345')

    state.version = '0.1.28'
    const mod = await loadAppLog()
    await mod.markRunning(['Kettu.exe', '--updated'])

    expect(mod.lastUnexpectedExit()).toBeNull()
  })

  it('still reports a real crash for a same-version marker even if --updated is present', async () => {
    const dir = ensureUserData()
    writeFileSync(join(dir, 'running'), '12345\n0.1.28')

    state.version = '0.1.28'
    const mod = await loadAppLog()
    await mod.markRunning(['Kettu.exe', '--updated'])

    expect(mod.lastUnexpectedExit()).not.toBeNull()
  })

  it('still reports a real crash for an older-version marker when launched without --updated', async () => {
    const dir = ensureUserData()
    writeFileSync(join(dir, 'running'), '12345\n0.1.27')

    state.version = '0.1.28'
    const mod = await loadAppLog()
    await mod.markRunning(['Kettu.exe'])

    expect(mod.lastUnexpectedExit()).not.toBeNull()
  })

  it('formats and parses running markers cleanly', async () => {
    const mod = await loadAppLog()
    expect(mod.formatRunningMarker(42, '0.1.29')).toBe('42\n0.1.29')
    expect(mod.parseRunningMarkerVersion('42\n0.1.29')).toBe('0.1.29')
    expect(mod.parseRunningMarkerVersion('42\r\n0.1.29\r\n')).toBe('0.1.29')
    expect(mod.parseRunningMarkerVersion('42')).toBeNull()
    expect(mod.isStaleUpdateMarker('42\n0.1.27', '0.1.28', ['--updated'])).toBe(true)
    expect(mod.isStaleUpdateMarker('42\n0.1.28', '0.1.28', ['--updated'])).toBe(false)
    expect(mod.isStaleUpdateMarker('42\n0.1.29', '0.1.28', ['--updated'])).toBe(false)
    expect(mod.isStaleUpdateMarker('42\n0.1.27', '0.1.28', [])).toBe(false)
  })
})

describe('WindowsSessionEndWatcher', () => {
  class FakeSessionWindow extends EventEmitter implements SessionEndWindow {
    destroyed = false

    isDestroyed(): boolean {
      return this.destroyed
    }

    destroy(): void {
      if (this.destroyed) return
      this.destroyed = true
      this.emit('closed')
    }
  }

  it('does nothing on non-Windows platforms', () => {
    const createWindow = vi.fn(() => new FakeSessionWindow())
    const onSessionEnd = vi.fn()
    const watcher = new WindowsSessionEndWatcher({
      platform: 'darwin',
      onSessionEnd,
      createWindow,
    })

    watcher.ensureHiddenWatcher()
    expect(createWindow).not.toHaveBeenCalled()
  })

  it('creates one hidden watcher on Windows, forwards session-end, and stops recreating afterward', () => {
    const created: FakeSessionWindow[] = []
    const onSessionEnd = vi.fn()
    const watcher = new WindowsSessionEndWatcher({
      platform: 'win32',
      onSessionEnd,
      createWindow: () => {
        const win = new FakeSessionWindow()
        created.push(win)
        return win
      },
    })

    watcher.ensureHiddenWatcher()
    watcher.ensureHiddenWatcher()
    expect(created).toHaveLength(1)

    created[0].emit('session-end')
    expect(onSessionEnd).toHaveBeenCalledTimes(1)

    // Once session-end fired, closing windows must not create another hidden window.
    watcher.dispose()
    watcher.ensureHiddenWatcher()
    expect(created).toHaveLength(1)
  })

  it('disposes when an app window opens and recreates when returning to tray-only mode, until stopped', () => {
    const created: FakeSessionWindow[] = []
    const watcher = new WindowsSessionEndWatcher({
      platform: 'win32',
      onSessionEnd: vi.fn(),
      createWindow: () => {
        const win = new FakeSessionWindow()
        created.push(win)
        return win
      },
    })

    watcher.ensureHiddenWatcher()
    expect(created).toHaveLength(1)
    expect(created[0].isDestroyed()).toBe(false)

    watcher.dispose()
    expect(created[0].isDestroyed()).toBe(true)

    watcher.ensureHiddenWatcher()
    expect(created).toHaveLength(2)

    watcher.stop()
    expect(created[1].isDestroyed()).toBe(true)

    watcher.ensureHiddenWatcher()
    expect(created).toHaveLength(2)
  })
})
