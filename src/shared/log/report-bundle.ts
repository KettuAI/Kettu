// Builds a problem report's bundle: the facts that always go in, the log records of the range,
// and only the extras the user chose. Every text file is masked again as it is packed, so what
// the user reviews is what leaves, with no secret the logs might still hold.

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import type { AgentDiagnostics, DiagnosticsBundle, SessionSummary } from '../agent-host'
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

/** What stands for a value the report leaves out. */
const SET = '<set>'
/** What stands for an email the report leaves out, so it still shows that one was there. */
const EMAIL_MARK = '<email>'
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function count(value: unknown): unknown {
  if (Array.isArray(value)) return { count: value.length }
  return isObject(value) ? { count: Object.keys(value).length } : value
}

/**
 * Settings without what says who the user is or what they visit: the sites links open in, this
 * computer's name and own addresses, the own relay's address, the agents' given names and a
 * proxy's credentials. Paths stay, as they show how things are set up. Takes the whole file or a
 * patch of it, as a settings change in the log holds, and changes only the keys it has.
 */
export function settingsForReport(settings: SettingsFile | Record<string, unknown>): unknown {
  const copy = structuredClone(settings) as Record<string, unknown>
  const { thread, addedAgents, proxy, remote } = copy
  if (isObject(thread) && 'alwaysOpenIn' in thread) {
    copy['thread'] = { ...thread, alwaysOpenIn: count(thread['alwaysOpenIn']) }
  }
  if (Array.isArray(addedAgents)) {
    copy['addedAgents'] = addedAgents.map((agent: unknown) =>
      isObject(agent) && 'name' in agent ? { ...agent, name: SET } : agent,
    )
  }
  if (isObject(proxy) && typeof proxy['url'] === 'string') {
    const url = URL.parse(proxy['url'])
    const credentials = url && (url.username || url.password) ? '<redacted>@' : ''
    copy['proxy'] = { ...proxy, url: url ? `${url.protocol}//${credentials}${url.host}` : SET }
  }
  if (isObject(remote)) {
    const next = { ...remote }
    if (typeof next['name'] === 'string') next['name'] = SET
    if (isObject(next['direct']) && 'addresses' in next['direct']) {
      next['direct'] = { ...next['direct'], addresses: count(next['direct']['addresses']) }
    }
    if (isObject(next['ownRelay']) && 'url' in next['ownRelay']) {
      next['ownRelay'] = { ...next['ownRelay'], url: SET }
    }
    copy['remote'] = next
  }
  return copy
}

/**
 * An agent's status and capabilities, its events and its adapter's files, without its account's
 * email and, for an agent the user added, the name they gave it; the account's kind and plan stay.
 */
export function agentForReport(agent: AgentDiagnostics): unknown {
  const { status } = agent
  return {
    status: {
      ...status,
      name: status.isDefault ? status.name : SET,
      account: status.account && {
        ...status.account,
        email: status.account.email === null ? null : EMAIL_MARK,
      },
      providers: status.providers?.map((provider) => ({
        ...provider,
        accounts: provider.accounts.map((account) =>
          EMAIL.test(account.label) ? { ...account, label: EMAIL_MARK } : account,
        ),
      })),
    },
    capabilities: agent.capabilities,
    events: agent.events,
    adapter: agent.adapter,
  }
}

/** The emails the agents' accounts report, which the bundle leaves out wherever they appear. */
function accountEmails(host: DiagnosticsBundle | null): string[] {
  const emails = new Set<string>()
  for (const { status } of host?.agents ?? []) {
    if (status.account?.email) emails.add(status.account.email)
    for (const provider of status.providers ?? []) {
      for (const account of provider.accounts) {
        if (EMAIL.test(account.label)) emails.add(account.label)
      }
    }
  }
  return [...emails]
}

/** Masks each of `values` wherever it appears, in any case. */
function valueMasker(values: string[], mark: string): (text: string) => string {
  if (values.length === 0) return (text) => text
  const pattern = new RegExp(
    values.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
    'gi',
  )
  return (text) => text.replace(pattern, mark)
}

/** A log record as the bundle holds it: a settings change's personal values left out. */
function recordForReport(line: string): string {
  if (!line.includes('"settings.update"')) return line
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return line
  }
  if (!isObject(record) || record['source'] !== 'action' || record['message'] !== 'settings.update')
    return line
  const data = record['data']
  if (!isObject(data) || !isObject(data['patch'])) return line
  return JSON.stringify({ ...record, data: { ...data, patch: settingsForReport(data['patch']) } })
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
  const emails = valueMasker(accountEmails(host), EMAIL_MARK)
  const text = (name: string, value: string): void => void files.set(name, redact(emails(value)))

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
    text('agents.json', json(host.agents.map(agentForReport)))
    text('host-log.json', json(host.log.filter((entry) => entry.at >= from && entry.at <= to)))
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
      const lines = (await recordsInRange(group, from, to)).map(recordForReport)
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

/** A built bundle waiting to be viewed, saved or submitted. */
export interface ShelvedReport {
  file: string
  files: ReportFileInfo[]
  size: number
  /** What it was built from; null for one another host built. */
  request: ReportRequest | null
  at: number
}

const SHELVED = 5
const SHELVED_MS = 60 * 60 * 1000

/**
 * The bundles a host or window built lately, by id: at most five, for an hour, each file removed
 * when it goes. Only files in `dir`, where the builder writes, are taken.
 */
export class ReportShelf {
  private readonly kept = new Map<string, ShelvedReport>()

  constructor(
    readonly dir: string,
    private readonly dropped: (id: string) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  /** Keeps a built bundle; null when its file is not in the folder. */
  put(entry: Omit<ShelvedReport, 'at'>): string | null {
    if (path.dirname(path.resolve(entry.file)) !== path.resolve(this.dir)) return null
    const now = this.now()
    for (const [id, kept] of this.kept) {
      if (now - kept.at > SHELVED_MS) this.drop(id)
    }
    while (this.kept.size >= SHELVED) this.drop(this.kept.keys().next().value!)
    const id = randomUUID()
    this.kept.set(id, { ...entry, at: now })
    return id
  }

  get(id: unknown): ShelvedReport | null {
    return (typeof id === 'string' && this.kept.get(id)) || null
  }

  drop(id: unknown): void {
    const kept = this.get(id)
    if (!kept) return
    this.kept.delete(id as string)
    this.dropped(id as string)
    void fs.rm(kept.file, { force: true }).catch(() => {})
  }
}

/**
 * A built bundle as the owner's device receives it, read into base64 and kept on the shelf, so the
 * device can have the host submit what it reviewed.
 */
export async function bundleForDevice(
  built: ReportBuildResult,
  request: ReportRequest,
  shelf: ReportShelf,
): Promise<DeviceReport> {
  if (!built.ok) return { ok: false, reason: built.reason }
  const fail = async (reason: 'too_large' | 'failed'): Promise<DeviceReport> => {
    await fs.rm(built.file, { force: true }).catch(() => {})
    return { ok: false, reason }
  }
  if (built.size > REMOTE_REPORT_MAX_BYTES) return fail('too_large')
  const bytes = await fs.readFile(built.file).catch(() => null)
  if (!bytes) return fail('failed')
  const ref = shelf.put({ file: built.file, files: built.files, size: built.size, request })
  if (ref === null) return fail('failed')
  return { ok: true, zip: bytes.toString('base64'), files: built.files, size: built.size, ref }
}
