// Builds a problem report's bundle: the facts that always go in, the log records of the range,
// and only the extras the user chose. Every text file is masked again as it is packed, so what
// the user reviews is what leaves, with no secret the logs might still hold.

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import type { DiagnosticsBundle, SessionSummary } from '../agent-host'
import type { DeviceReport } from '../remote/host-admin'
import {
  rangeBounds,
  REMOTE_REPORT_MAX_BYTES,
  REPORT_MAX_BYTES,
  reportFileKind,
  type ReportBuildResult,
  type ReportFileInfo,
  type ReportRequest,
} from '../report'
import type { SettingsFile } from '../settings'
import { VERBOSE_PREFIX } from './process-log'

export type ReportContent = string | Uint8Array

/** What a host hands the builder; the parent's part comes from main or the daemon. */
export interface ReportParts {
  request: ReportRequest
  now: number
  /** The parent's facts: the app and runtime versions, the system and the hosts' supervision. */
  parent: Record<string, unknown>
  settings: SettingsFile | null
  /** The agent host's own part; null when it is down, and the bundle is the logs alone. */
  host: DiagnosticsBundle | null
  /** The folder of the log files, which the host's own process writes into too. */
  logDir: string | null
  /** Native crash dumps, where the desktop app keeps them. */
  crashDir: string | null
  screenshot: Uint8Array | null
  redact: (text: string) => string
}

/** At most this many crash dumps, the newest of the range, since each can be large. */
const MAX_DUMPS = 3
const ROTATED = /^(.+?)(?:\.(\d+))?\.log$/
const RECORD_TIME = /^\{"time":"([^"]+)"/

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * The settings without what says who the user is or what they visit: the sites links open in,
 * this computer's name and own addresses, the agents' given names and a proxy's credentials.
 * Paths stay, as they show how things are set up.
 */
export function settingsForReport(file: SettingsFile): unknown {
  const copy = structuredClone(file)
  let proxy: unknown = copy.proxy
  if (copy.proxy.mode === 'custom') {
    const url = URL.parse(copy.proxy.url)
    const credentials = url && (url.username || url.password) ? '<redacted>@' : ''
    proxy = { ...copy.proxy, url: url ? `${url.protocol}//${credentials}${url.host}` : '<set>' }
  }
  return {
    ...copy,
    thread: {
      ...copy.thread,
      alwaysOpenIn: { count: Object.keys(copy.thread.alwaysOpenIn).length },
    },
    addedAgents: copy.addedAgents.map((agent) => ({ ...agent, name: '<set>' })),
    proxy,
    remote: {
      ...copy.remote,
      name: copy.remote.name === null ? null : '<set>',
      direct: { ...copy.remote.direct, addresses: { count: copy.remote.direct.addresses.length } },
    },
  }
}

/** A session as the bundle lists it: with its title, project and branch only when chosen. */
export function sessionForReport(session: SessionSummary, titles: boolean): unknown {
  if (titles) return session
  return {
    id: session.id,
    agentId: session.agentId,
    scratch: session.scratch,
    status: session.status,
    attention: session.attention,
    permissionCount: session.permissionCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    parentId: session.parentId,
    origin: session.origin,
    missing: session.missing,
    model: session.model,
    archived: session.archivedAt !== null,
  }
}

interface LogFile {
  name: string
  index: number
  file: string
  mtime: number
}

/** The log files of the folder by name, each name's oldest rotation first. */
async function logFiles(dir: string): Promise<Map<string, LogFile[]>> {
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const groups = new Map<string, LogFile[]>()
  for (const name of names) {
    const match = ROTATED.exec(name)
    if (!match) continue
    const file = path.join(dir, name)
    const stat = await fs.stat(file).catch(() => null)
    if (!stat?.isFile()) continue
    const entry = { name: match[1]!, index: Number(match[2] ?? 0), file, mtime: stat.mtimeMs }
    groups.set(entry.name, [...(groups.get(entry.name) ?? []), entry])
  }
  for (const files of groups.values()) files.sort((a, b) => b.index - a.index)
  return groups
}

/** The records of `from` to `to` in a log's files; a line that is no record goes with the last. */
async function recordsInRange(files: LogFile[], from: number, to: number): Promise<string[]> {
  const kept: string[] = []
  for (const entry of files) {
    // Nothing in a file last written before the range starts can be in it.
    if (entry.mtime < from) continue
    const text = await fs.readFile(entry.file, 'utf8').catch(() => '')
    let inRange = false
    for (const line of text.split('\n')) {
      if (line === '') continue
      const time = RECORD_TIME.exec(line)?.[1]
      if (time !== undefined) {
        const at = Date.parse(time)
        inRange = at >= from && at <= to
      }
      if (inRange) kept.push(line)
    }
  }
  return kept
}

async function crashDumps(dir: string, from: number, to: number): Promise<LogFile[]> {
  const dumps: LogFile[] = []
  const walk = async (folder: string): Promise<void> => {
    const entries = await fs.readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const file = path.join(folder, entry.name)
      if (entry.isDirectory()) await walk(file)
      else if (entry.name.endsWith('.dmp')) {
        const stat = await fs.stat(file).catch(() => null)
        if (stat && stat.mtimeMs >= from && stat.mtimeMs <= to) {
          dumps.push({ name: entry.name, index: 0, file, mtime: stat.mtimeMs })
        }
      }
    }
  }
  await walk(dir)
  return dumps.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_DUMPS)
}

/** The bundle's files by their path in the zip, text masked. */
export async function buildReportFiles(parts: ReportParts): Promise<Map<string, ReportContent>> {
  const { request, host, redact } = parts
  const extras = new Set(request.extras)
  const { from, to } = rangeBounds(request.range, parts.now)
  const files = new Map<string, ReportContent>()
  const text = (name: string, value: string): void => void files.set(name, redact(value))

  text(
    'report.json',
    json({
      description: request.description,
      range: {
        kind: request.range.kind,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      },
      createdAt: new Date(parts.now).toISOString(),
      extras: [...extras],
      context: request.context,
      ...parts.parent,
      host: host && {
        appVersion: host.appVersion,
        platform: host.platform,
        environment: host.environment,
        environmentInfo: host.environmentInfo,
      },
    }),
  )
  if (parts.settings) text('settings.json', json(settingsForReport(parts.settings)))
  if (host) {
    text(
      'agents.json',
      json(
        host.agents.map((agent) => ({
          status: agent.status,
          capabilities: agent.capabilities,
          events: agent.events,
          adapter: agent.adapter,
        })),
      ),
    )
    text('host-log.json', json(host.log))
    text(
      'sessions.json',
      json(host.sessions.map((session) => sessionForReport(session, extras.has('titles')))),
    )
    if (extras.has('messages')) {
      for (const agent of host.agents) {
        if (agent.traffic.length === 0 && agent.stderr === '') continue
        text(
          `messages/${agent.status.id.replace(/[^A-Za-z0-9._~-]+/g, '_')}.json`,
          json({ traffic: agent.traffic, stderr: agent.stderr }),
        )
      }
    }
  }
  if (parts.logDir) {
    for (const [name, group] of await logFiles(parts.logDir)) {
      const verbose = name.startsWith(VERBOSE_PREFIX)
      if (verbose && !extras.has('verbose')) continue
      const lines = await recordsInRange(group, from, to)
      if (lines.length > 0) text(`logs/${name}.log`, `${lines.join('\n')}\n`)
    }
  }
  if (extras.has('dumps') && parts.crashDir) {
    for (const dump of await crashDumps(parts.crashDir, from, to)) {
      const bytes = await fs.readFile(dump.file).catch(() => null)
      if (bytes) files.set(`crash/${dump.name}`, new Uint8Array(bytes))
    }
  }
  if (extras.has('screenshot') && parts.screenshot) files.set('screenshot.png', parts.screenshot)
  return files
}

export function reportListing(files: Map<string, ReportContent>): ReportFileInfo[] {
  return [...files].map(([name, content]) => ({
    path: name,
    size: typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength,
    kind: reportFileKind(name),
  }))
}

export async function zipReport(files: Map<string, ReportContent>): Promise<Uint8Array> {
  const zip = new JSZip()
  for (const [name, content] of files) zip.file(name, content)
  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
}

/** Builds the bundle and writes its zip into `dir`, or says why it could not. */
export async function writeReport(parts: ReportParts, dir: string): Promise<ReportBuildResult> {
  try {
    const files = await buildReportFiles(parts)
    const zip = await zipReport(files)
    if (zip.byteLength > REPORT_MAX_BYTES) {
      return {
        ok: false,
        reason: 'too_large',
        message: `The report is ${zip.byteLength} bytes, over ${REPORT_MAX_BYTES}`,
      }
    }
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `${randomUUID()}.zip`)
    await fs.writeFile(file, zip, { mode: 0o600 })
    return { ok: true, file, files: reportListing(files), size: zip.byteLength }
  } catch (error) {
    return { ok: false, reason: 'failed', message: (error as Error).message }
  }
}

/**
 * A built bundle as the owner's device receives it, read into base64 and dropped here. Only a file
 * in `dir` is read, where the builder writes.
 */
export async function bundleForDevice(
  built: ReportBuildResult,
  dir: string,
): Promise<DeviceReport> {
  if (!built.ok) return { ok: false, reason: built.reason }
  try {
    if (path.dirname(path.resolve(built.file)) !== path.resolve(dir)) {
      return { ok: false, reason: 'failed' }
    }
    if (built.size > REMOTE_REPORT_MAX_BYTES) return { ok: false, reason: 'too_large' }
    const bytes = await fs.readFile(built.file)
    return { ok: true, zip: bytes.toString('base64'), files: built.files, size: built.size }
  } catch {
    return { ok: false, reason: 'failed' }
  } finally {
    await fs.rm(built.file, { force: true }).catch(() => {})
  }
}
