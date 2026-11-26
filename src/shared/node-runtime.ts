// Resolves the executable used to run Node.js scripts under Electron.
//
// On macOS, spawning the main app binary (`<App>.app/Contents/MacOS/<AppName>`) directly—even with
// `ELECTRON_RUN_AS_NODE=1`—registers a Dock icon and can leave duplicate entries in the Dock's
// "Recent Applications" section. Electron's companion Helper app bundle
// (`<App>.app/Contents/Frameworks/<AppName> Helper.app/Contents/MacOS/<AppName> Helper`) sets
// `LSUIElement = true` in its Info.plist and shares the app's signature and entitlements, so
// running Node.js scripts through it avoids Dock registration completely.

import { existsSync } from 'node:fs'
import path from 'node:path'
import type { NodeRuntime } from './host-control'

const HELPER_SUFFIX = /\sHelper(?: \([^)]+\))?$/

export interface ResolveNodeExecOptions {
  platform?: NodeJS.Platform
  exists?: (file: string) => boolean
}

/**
 * The executable to run a Node.js script with: on macOS, swaps an Electron app's main bundle
 * binary (`<Bundle>.app/Contents/MacOS/<Name>`) for its companion `LSUIElement` Helper binary
 * (`<Bundle>.app/Contents/Frameworks/<Name> Helper.app/Contents/MacOS/<Name> Helper`) when it
 * exists on disk; returns `execPath` unchanged on other platforms, for plain Node.js, for paths
 * already targeting a Helper, or when the Helper binary is missing.
 */
export function resolveElectronNodeExecutable(
  execPath: string = process.execPath,
  options: ResolveNodeExecOptions = {},
): string {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') return execPath

  const normalized = path.posix.normalize(execPath)
  const macOsDir = path.posix.dirname(normalized)
  if (path.posix.basename(macOsDir) !== 'MacOS') return execPath

  const contentsDir = path.posix.dirname(macOsDir)
  if (path.posix.basename(contentsDir) !== 'Contents') return execPath

  const bundleDir = path.posix.dirname(contentsDir)
  const bundleName = path.posix.basename(bundleDir)
  if (bundleName.length <= 4 || !bundleName.endsWith('.app')) return execPath

  const execName = path.posix.basename(normalized)
  if (!execName || HELPER_SUFFIX.test(execName)) return execPath

  const helperName = `${execName} Helper`
  const helperPath = path.posix.join(
    contentsDir,
    'Frameworks',
    `${helperName}.app`,
    'Contents',
    'MacOS',
    helperName,
  )

  const exists = options.exists ?? existsSync
  return exists(helperPath) ? helperPath : execPath
}

/**
 * The `NodeRuntime` that runs a script on Electron's binary as Node.js, using the macOS Helper
 * binary when running inside a `.app` bundle so child scripts never register a Dock icon.
 */
export function electronNodeRuntime(
  execPath: string = process.execPath,
  options: ResolveNodeExecOptions = {},
): NodeRuntime {
  return {
    command: resolveElectronNodeExecutable(execPath, options),
    env: { ELECTRON_RUN_AS_NODE: '1' },
  }
}
