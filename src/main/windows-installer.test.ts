import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import {
  buildNsisArgs,
  isWindowsCancelError,
  isWindowsElevationRequired,
  runWindowsInstaller,
  WIN32_ERROR_CANCELLED,
  WIN32_ERROR_ELEVATION_REQUIRED,
  type WindowsSpawn,
} from './windows-installer'

class FakeChildProcess extends EventEmitter {
  pid = 4242
  unref = vi.fn()
}

describe('windows-installer helpers', () => {
  it('builds NSIS arguments matching electron-updater conventions', () => {
    expect(
      buildNsisArgs({
        isSilent: true,
        isForceRunAfter: true,
        installDirectory: 'C:\\Program Files\\Kettu',
        packagePath: 'C:\\Temp\\app.7z',
      }),
    ).toEqual([
      '--updated',
      '/S',
      '--force-run',
      '/D=C:\\Program Files\\Kettu',
      '--package-file=C:\\Temp\\app.7z',
    ])
    expect(buildNsisArgs({ isSilent: false, isForceRunAfter: false })).toEqual(['--updated'])
  })

  it('classifies Windows UAC/SmartScreen cancellation and elevation errors accurately', () => {
    expect(isWindowsCancelError(null, WIN32_ERROR_CANCELLED)).toBe(true)
    expect(isWindowsCancelError(Object.assign(new Error('nope'), { code: 'ECANCELED' }))).toBe(true)
    expect(isWindowsCancelError(new Error('The operation was canceled by the user (1223)'))).toBe(
      true,
    )
    expect(isWindowsCancelError(new Error('Access denied'), 5)).toBe(false)

    expect(isWindowsElevationRequired(Object.assign(new Error('perm'), { code: 'EACCES' }))).toBe(
      true,
    )
    expect(
      isWindowsElevationRequired(Object.assign(new Error('unknown'), { code: 'UNKNOWN' })),
    ).toBe(true)
    expect(
      isWindowsElevationRequired(
        Object.assign(new Error('elevate'), { errno: WIN32_ERROR_ELEVATION_REQUIRED }),
      ),
    ).toBe(true)
    expect(
      isWindowsElevationRequired(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    ).toBe(false)
  })
})

describe('runWindowsInstaller', () => {
  it('notifies host confirmation and launches via elevate.exe when admin rights are required', async () => {
    const events: string[] = []
    const elevateChild = new FakeChildProcess()
    const spawn = vi.fn<WindowsSpawn>((command, args) => {
      events.push(`spawn:${command}:${args.join(' ')}`)
      queueMicrotask(() => elevateChild.emit('close', 0))
      return elevateChild as unknown as ChildProcess
    })

    const result = await runWindowsInstaller({
      installerPath:
        'C:\\Users\\me\\AppData\\Local\\kettu-updater\\pending\\Kettu-0.1.29-setup.exe',
      isSilent: true,
      isForceRunAfter: true,
      isAdminRightsRequired: true,
      resourcesPath: 'C:\\Program Files\\Kettu\\resources',
      onAwaitingHostConfirmation: async () => {
        events.push('awaiting_host_confirmation')
      },
      spawn,
    })

    expect(result).toEqual({ kind: 'launched', elevated: true })
    expect(events[0]).toBe('awaiting_host_confirmation')
    expect(events[1]).toContain('elevate.exe')
    expect(events[1]).toContain('--updated /S --force-run')
  })

  it('triggers Windows host confirmation when the install directory is not writable (per-machine)', async () => {
    const elevateChild = new FakeChildProcess()
    const awaiting = vi.fn()
    const spawn = vi.fn<WindowsSpawn>(() => {
      queueMicrotask(() => elevateChild.emit('close', WIN32_ERROR_CANCELLED))
      return elevateChild as unknown as ChildProcess
    })

    const result = await runWindowsInstaller({
      installerPath: 'C:\\Temp\\Kettu-0.1.29-setup.exe',
      isSilent: true,
      isForceRunAfter: true,
      isAdminRightsRequired: false,
      execPath: 'C:\\Program Files\\Kettu\\Kettu.exe',
      resourcesPath: 'C:\\Program Files\\Kettu\\resources',
      canWriteDir: async () => false,
      onAwaitingHostConfirmation: awaiting,
      spawn,
    })

    expect(awaiting).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      kind: 'cancelled',
      code: 'host_confirmation_cancelled',
      exitCode: WIN32_ERROR_CANCELLED,
    })
  })

  it('launches directly without host confirmation for writable per-user installs when OS allows it', async () => {
    const directChild = new FakeChildProcess()
    const awaiting = vi.fn()
    const spawn = vi.fn<WindowsSpawn>(() => {
      queueMicrotask(() => directChild.emit('spawn'))
      return directChild as unknown as ChildProcess
    })

    const result = await runWindowsInstaller({
      installerPath: 'C:\\Temp\\Kettu-0.1.29-setup.exe',
      isSilent: true,
      isForceRunAfter: true,
      isAdminRightsRequired: false,
      execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Kettu\\Kettu.exe',
      canWriteDir: async () => true,
      onAwaitingHostConfirmation: awaiting,
      spawn,
    })

    expect(awaiting).not.toHaveBeenCalled()
    expect(directChild.unref).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ kind: 'launched', elevated: false })
  })

  it('falls back to host confirmation and elevate.exe when direct launch returns EACCES', async () => {
    const directChild = new FakeChildProcess()
    const elevateChild = new FakeChildProcess()
    const awaiting = vi.fn()
    let call = 0
    const spawn = vi.fn<WindowsSpawn>(() => {
      call++
      if (call === 1) {
        queueMicrotask(() =>
          directChild.emit(
            'error',
            Object.assign(new Error('elevation required'), { code: 'EACCES' }),
          ),
        )
        return directChild as unknown as ChildProcess
      }
      queueMicrotask(() => elevateChild.emit('close', 5))
      return elevateChild as unknown as ChildProcess
    })

    const result = await runWindowsInstaller({
      installerPath: 'C:\\Temp\\Kettu-0.1.29-setup.exe',
      isSilent: true,
      isForceRunAfter: true,
      isAdminRightsRequired: false,
      execPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Kettu\\Kettu.exe',
      resourcesPath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Kettu\\resources',
      canWriteDir: async () => true,
      onAwaitingHostConfirmation: awaiting,
      spawn,
    })

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(awaiting).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      kind: 'failed',
      code: 'host_confirmation_failed',
      exitCode: 5,
    })
  })
})
