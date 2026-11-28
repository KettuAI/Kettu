// Windows NSIS update installer handoff with explicit native confirmation reporting.
// Keeps Windows' own UAC / SmartScreen elevation flow intact while letting the host notify
// remote clients before blocking on system confirmation and sync the outcome (launched,
// cancelled, or failed) while remote access is still online.

import { access, constants } from 'node:fs/promises'
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { dirname, join } from 'node:path'

export type WindowsSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

export interface WindowsInstallOptions {
  installerPath: string
  isSilent: boolean
  isForceRunAfter: boolean
  isAdminRightsRequired: boolean
  installDirectory?: string | null
  packagePath?: string | null
  /** Executable path of the running app; used to detect per-machine non-writable installs. */
  execPath?: string
  /** Directory containing Electron's bundled `elevate.exe`. */
  resourcesPath?: string
  /** Called right before invoking Windows' native confirmation/elevation prompt. */
  onAwaitingHostConfirmation?: () => Promise<void> | void
  /** Test seam for directory writability checks. */
  canWriteDir?: (dir: string) => Promise<boolean>
  /** Test seam for spawning installer / elevate processes. */
  spawn?: WindowsSpawn
}

export type WindowsInstallResult =
  | { kind: 'launched'; elevated: boolean }
  | { kind: 'cancelled'; code: 'host_confirmation_cancelled'; exitCode?: number; message: string }
  | {
      kind: 'failed'
      code: 'host_confirmation_failed' | 'install_failed'
      exitCode?: number
      message: string
    }

// Windows Win32 ERROR_CANCELLED (1223 / 0x4c7): user declined UAC or SmartScreen prompt.
export const WIN32_ERROR_CANCELLED = 1223
// Windows Win32 ERROR_ELEVATION_REQUIRED (740 / 0x2e4): CreateProcess requires UAC elevation.
export const WIN32_ERROR_ELEVATION_REQUIRED = 740

const CANCEL_TEXT =
  /\b(?:1223|0x4c7|ecanceled|error_cancelled)\b|cancell?ed by the user|user rejected|operation was cancell?ed/i

function errorCodeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
}

function errorErrnoOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'errno' in error
    ? (error as { errno?: unknown }).errno
    : undefined
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Whether a Windows installer launch error or exit code indicates the user cancelled system confirmation. */
export function isWindowsCancelError(error: unknown, exitCode?: number | null): boolean {
  if (exitCode === WIN32_ERROR_CANCELLED) return true
  const code = errorCodeOf(error)
  if (code === 'ECANCELED' || code === WIN32_ERROR_CANCELLED) return true
  const errno = errorErrnoOf(error)
  if (errno === WIN32_ERROR_CANCELLED || errno === -WIN32_ERROR_CANCELLED) return true
  return error !== null && error !== undefined && CANCEL_TEXT.test(errorText(error))
}

/** Whether a direct installer spawn failed because Windows requires UAC elevation. */
export function isWindowsElevationRequired(error: unknown): boolean {
  const code = errorCodeOf(error)
  if (
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'UNKNOWN' ||
    code === WIN32_ERROR_ELEVATION_REQUIRED
  ) {
    return true
  }
  const errno = errorErrnoOf(error)
  if (errno === WIN32_ERROR_ELEVATION_REQUIRED || errno === -WIN32_ERROR_ELEVATION_REQUIRED) {
    return true
  }
  return /\b(?:740|0x2e4|requires elevation)\b/i.test(errorText(error))
}

/** Builds the NSIS installer arguments matching electron-updater's NsisUpdater.doInstall. */
export function buildNsisArgs(options: {
  isSilent: boolean
  isForceRunAfter: boolean
  installDirectory?: string | null
  packagePath?: string | null
}): string[] {
  const args = ['--updated']
  if (options.isSilent) args.push('/S')
  if (options.isForceRunAfter) args.push('--force-run')
  if (options.installDirectory) args.push(`/D=${options.installDirectory}`)
  if (options.packagePath) args.push(`--package-file=${options.packagePath}`)
  return args
}

/** Whether the current user can write to `dir` without UAC elevation. */
export async function canWriteInstallDir(dir: string): Promise<boolean> {
  try {
    await access(dir, constants.W_OK)
    return true
  } catch (error) {
    const code = errorCodeOf(error)
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return false
    // Missing or inaccessible path outside permission errors should not falsely force elevation.
    return true
  }
}

/**
 * Spawns `elevate.exe <installerPath> <args...>` so Windows runs its native UAC confirmation
 * flow, and waits for `elevate.exe` to exit with the confirmation result.
 */
function runElevated(
  elevatePath: string,
  installerPath: string,
  args: readonly string[],
  spawn: WindowsSpawn,
): Promise<WindowsInstallResult> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: WindowsInstallResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child: ChildProcess
    try {
      child = spawn(elevatePath, [installerPath, ...args], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (error) {
      if (isWindowsCancelError(error)) {
        finish({
          kind: 'cancelled',
          code: 'host_confirmation_cancelled',
          message: 'Windows system confirmation was cancelled on the host',
        })
      } else {
        finish({
          kind: 'failed',
          code: 'host_confirmation_failed',
          message: errorText(error),
        })
      }
      return
    }

    child.once('error', (error) => {
      if (isWindowsCancelError(error)) {
        finish({
          kind: 'cancelled',
          code: 'host_confirmation_cancelled',
          message: 'Windows system confirmation was cancelled on the host',
        })
      } else {
        finish({
          kind: 'failed',
          code: 'host_confirmation_failed',
          message: errorText(error),
        })
      }
    })

    child.once('close', (exitCode) => {
      if (exitCode === 0) {
        finish({ kind: 'launched', elevated: true })
        return
      }
      if (isWindowsCancelError(null, exitCode)) {
        finish({
          kind: 'cancelled',
          code: 'host_confirmation_cancelled',
          exitCode: exitCode ?? undefined,
          message: 'Windows system confirmation was cancelled on the host',
        })
        return
      }
      finish({
        kind: 'failed',
        code: 'host_confirmation_failed',
        exitCode: exitCode ?? undefined,
        message:
          exitCode === null
            ? 'Windows system confirmation did not complete'
            : `Windows installer elevation exited with code ${exitCode}`,
      })
    })
  })
}

/**
 * Attempts to launch the NSIS installer directly without elevation. Resolves to `'launched'` once
 * the OS has created the process, `'needs_elevation'` when Windows requires UAC, or a terminal
 * cancelled/failed result.
 */
function runDirect(
  installerPath: string,
  args: readonly string[],
  spawn: WindowsSpawn,
): Promise<WindowsInstallResult | { kind: 'needs_elevation' }> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: WindowsInstallResult | { kind: 'needs_elevation' }): void => {
      if (settled) return
      settled = true
      resolve(result)
    }

    let child: ChildProcess
    try {
      child = spawn(installerPath, args, {
        stdio: 'ignore',
        detached: true,
      })
    } catch (error) {
      if (isWindowsElevationRequired(error)) {
        finish({ kind: 'needs_elevation' })
      } else if (isWindowsCancelError(error)) {
        finish({
          kind: 'cancelled',
          code: 'host_confirmation_cancelled',
          message: 'Windows system confirmation was cancelled on the host',
        })
      } else {
        finish({
          kind: 'failed',
          code: 'install_failed',
          message: errorText(error),
        })
      }
      return
    }

    child.once('error', (error) => {
      if (isWindowsElevationRequired(error)) {
        finish({ kind: 'needs_elevation' })
      } else if (isWindowsCancelError(error)) {
        finish({
          kind: 'cancelled',
          code: 'host_confirmation_cancelled',
          message: 'Windows system confirmation was cancelled on the host',
        })
      } else {
        finish({
          kind: 'failed',
          code: 'install_failed',
          message: errorText(error),
        })
      }
    })

    child.once('spawn', () => {
      child.unref()
      finish({ kind: 'launched', elevated: false })
    })
  })
}

/**
 * Launches the downloaded Windows NSIS installer while keeping Windows' native confirmation flow
 * untouched. Whenever elevation / system confirmation is required, notifies
 * `onAwaitingHostConfirmation` first (so remote clients show that confirmation is required on the
 * Windows host) and returns the final outcome once confirmation succeeds, cancels, or fails.
 */
export async function runWindowsInstaller(
  options: WindowsInstallOptions,
): Promise<WindowsInstallResult> {
  const spawn = options.spawn ?? nodeSpawn
  const canWrite = options.canWriteDir ?? canWriteInstallDir
  const args = buildNsisArgs({
    isSilent: options.isSilent,
    isForceRunAfter: options.isForceRunAfter,
    installDirectory: options.installDirectory,
    packagePath: options.packagePath,
  })
  const targetDir = options.installDirectory || (options.execPath ? dirname(options.execPath) : '')
  const needsElevation =
    options.isAdminRightsRequired || (targetDir.length > 0 && !(await canWrite(targetDir)))
  const elevatePath = join(options.resourcesPath ?? process.resourcesPath ?? '', 'elevate.exe')

  if (needsElevation) {
    await options.onAwaitingHostConfirmation?.()
    return runElevated(elevatePath, options.installerPath, args, spawn)
  }

  const direct = await runDirect(options.installerPath, args, spawn)
  if (direct.kind !== 'needs_elevation') return direct

  await options.onAwaitingHostConfirmation?.()
  return runElevated(elevatePath, options.installerPath, args, spawn)
}
