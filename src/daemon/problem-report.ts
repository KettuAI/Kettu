// Problem reports on the daemon: its own part of the bundle, which its agent host builds, or which
// the daemon builds from the log files alone while that host is down or the daemon is not running.

import { readFile, rm, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { flushLog, logFolder, redactLogText } from '@shared/log/process-log'
import { writeReport } from '@shared/log/report-bundle'
import type { ReportBuildResult, ReportRequest, ReportSubmitResult } from '@shared/report'
import type { SettingsFile } from '@shared/settings'
import type { HostName, HostStatus } from './control'
import { nodeSystemNameForRun } from '../main/system-name'
import type { Hosts } from './hosts'
import type { DaemonSignIn } from './sign-in'

/** Where bundles wait for the CLI or a device to take them. */
export function reportsFolder(dataPath: string): string {
  return path.join(dataPath, 'reports')
}

/** The daemon's own facts: versions, the system and its hosts' state. */
export function daemonPart(
  version: string,
  hosts: Record<HostName | 'remote', HostStatus> | null,
): Record<string, unknown> {
  return {
    daemon: { version, running: hosts !== null },
    versions: { node: process.versions.node, v8: process.versions.v8 },
    platform: process.platform,
    arch: process.arch,
    osVersion: os.release(),
    environment: { PATH: process.env.PATH ?? null, SHELL: process.env.SHELL ?? null },
    hosts,
  }
}

/** Builds the bundle from the log files alone, into `dir`. */
export function logsOnlyReport(
  request: ReportRequest,
  parent: Record<string, unknown>,
  settings: SettingsFile | null,
  logDir: string | null,
  dir: string,
): Promise<ReportBuildResult> {
  return writeReport(
    {
      request,
      now: Date.now(),
      parent,
      settings,
      host: null,
      logDir,
      crashDir: null,
      screenshot: null,
      redact: redactLogText,
    },
    dir,
  )
}

/** The running daemon's bundle, built by the agent host while it runs. */
export async function daemonReport(
  hosts: Pick<Hosts, 'status' | 'agentReady' | 'report'>,
  options: { version: string; dataPath: string; settings: SettingsFile },
  request: ReportRequest,
): Promise<ReportBuildResult> {
  // No window to capture.
  const asked = { ...request, extras: request.extras.filter((extra) => extra !== 'screenshot') }
  const parent = daemonPart(options.version, hosts.status())
  await flushLog()
  if (hosts.agentReady()) {
    return hosts.report({
      request: asked,
      parent,
      settings: options.settings,
      crashDir: null,
      screenshot: null,
    })
  }
  return logsOnlyReport(
    asked,
    parent,
    options.settings,
    logFolder(),
    reportsFolder(options.dataPath),
  )
}

/** Bundles a run before left behind, which nobody takes any more. */
export async function clearReports(dataPath: string): Promise<void> {
  const dir = reportsFolder(dataPath)
  const names = await readdir(dir).catch(() => [] as string[])
  await Promise.all(names.map((name) => rm(path.join(dir, name), { force: true }).catch(() => {})))
}

/** Submits a built bundle, as it was reviewed, with the daemon's sign-in. */
export async function submitBundle(
  file: string,
  description: string,
  version: string,
  signIn: Pick<DaemonSignIn, 'submitReport'>,
): Promise<ReportSubmitResult> {
  const [bytes, system] = await Promise.all([readFile(file), nodeSystemNameForRun()])
  const result = await signIn.submitReport({
    bundle: new Uint8Array(bytes),
    description,
    version,
    platform: system,
  })
  return result.ok ? { ...result, version, system } : result
}
