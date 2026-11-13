// Problem reports on the desktop app: the bundles the agent host builds, kept until the user saves,
// submits or drops them, a bundle another host built for this window, the window's screenshot, and
// the recording of steps to reproduce.

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, type BrowserWindow, dialog, type NativeImage } from 'electron'
import JSZip from 'jszip'
import { flushLog } from '@shared/log/process-log'
import { bundleForDevice, ReportShelf } from '@shared/log/report-bundle'
import {
  isReportPath,
  RECORDING_MAX_MS,
  REMOTE_REPORT_MAX_BYTES,
  REPORT_MAX_BYTES,
  reportFileKind,
  type PreparedReport,
  type ReportFileInfo,
  type ReportFileView,
  type ReportRequest,
  type ReportSubmitFailure,
  type ReportSubmitResult,
} from '@shared/report'
import type { SettingsFile } from '@shared/settings'
import type { ReportRecording } from '@shared/ipc'
import type { DeviceReport } from '@shared/remote/host-admin'
import type { ReportUpload } from './account/service'
import { t } from './i18n'
import { createLogger } from './log'

const log = createLogger('report')

// What the dialog shows of one text file; saving still takes all of it.
const VIEW_CHARS = 2 * 1024 * 1024
const MAX_FILES = 2_000

export class ReportError extends Error {
  constructor(
    readonly code: 'too_large' | 'failed' | 'not_found',
    message: string,
  ) {
    super(message)
  }
}

export interface ReportDeps {
  /** The agent host's bundle, which it writes under the folder's parent. */
  build(params: {
    request: ReportRequest
    parent: Record<string, unknown>
    settings: SettingsFile | null
    crashDir: string | null
    screenshot: string | null
  }): Promise<
    | { ok: true; file: string; files: ReportFileInfo[]; size: number }
    | { ok: false; reason: 'too_large' | 'failed'; message: string }
  >
  parent(): Record<string, unknown>
  settings(): SettingsFile
  /** Turns detailed records on until `until`, or off with null. */
  setVerbose(until: number | null): void
  verboseUntil(): number | null
  onRecording(recording: ReportRecording | null): void
  /** A recording ended: the dialog opens with its span. */
  onRecorded(span: { from: number; to: number }): void
  /** Submits with this computer's sign-in; null for its id once it is. */
  submit(
    upload: ReportUpload,
  ): Promise<{ ok: true; id: string } | { ok: false; reason: ReportSubmitFailure }>
  /** This app's version and system, as a bug report names them. */
  about(): Promise<{ version: string; system: string }>
}

export class Reports {
  private readonly shelf: ReportShelf
  /** The zips read to show their files, by the shelf's ids. */
  private readonly zips = new Map<string, JSZip>()
  private readonly shots = new Map<number, NativeImage>()
  private recording: (ReportRecording & { verboseBefore: number | null }) | null = null
  private recordingTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly deps: ReportDeps,
    readonly folder = path.join(app.getPath('userData'), 'reports'),
  ) {
    this.shelf = new ReportShelf(folder, (id) => this.zips.delete(id))
  }

  /** Bundles a run before left behind, which nobody can save any more. */
  async clearFolder(): Promise<void> {
    const names = await readdir(this.folder).catch(() => [] as string[])
    await Promise.all(
      names.map((name) => rm(path.join(this.folder, name), { force: true }).catch(() => {})),
    )
  }

  /**
   * The window as it looks now, before the dialog covers it; kept for its next bundle, and encoded
   * only then so the dialog opens without waiting for it.
   */
  async capture(window: BrowserWindow): Promise<void> {
    const image = await window.webContents.capturePage()
    this.shots.set(window.id, image)
    window.once('closed', () => this.shots.delete(window.id))
  }

  /** This computer's bundle, built by its agent host. */
  async prepare(window: BrowserWindow | null, request: ReportRequest): Promise<PreparedReport> {
    const built = await this.build(request, window)
    return this.keep(built.file, built.files, built.size, request)
  }

  /** The bundle for a device of the owner's: the zip itself, kept here for it to submit. */
  async forDevice(request: ReportRequest): Promise<DeviceReport> {
    await flushLog()
    const built = await this.deps.build({
      request: { ...request, extras: request.extras.filter((extra) => extra !== 'screenshot') },
      parent: this.deps.parent(),
      settings: this.deps.settings(),
      crashDir: app.getPath('crashDumps'),
      screenshot: null,
    })
    if (!built.ok) log.warn(`No problem report for a device: ${built.message}`)
    return bundleForDevice(built, request, this.shelf)
  }

  /** A bundle another host built, checked and kept like this computer's. */
  async adopt(zip: unknown): Promise<PreparedReport> {
    if (typeof zip !== 'string' || zip.length > (REMOTE_REPORT_MAX_BYTES * 4) / 3 + 4) {
      throw new ReportError('failed', 'The bundle is not one a host sends')
    }
    const bytes = Buffer.from(zip, 'base64')
    let parsed: JSZip
    try {
      parsed = await JSZip.loadAsync(bytes)
    } catch {
      throw new ReportError('failed', 'The bundle is not a zip')
    }
    const entries = Object.values(parsed.files).filter((entry) => !entry.dir)
    if (entries.length > MAX_FILES || !entries.every((entry) => isReportPath(entry.name))) {
      throw new ReportError('failed', 'The bundle holds files a report does not')
    }
    const files: ReportFileInfo[] = []
    for (const entry of entries) {
      // Its size is read by inflating it, which also proves it is whole.
      const content = await entry.async('uint8array')
      files.push({ path: entry.name, size: content.byteLength, kind: reportFileKind(entry.name) })
    }
    await mkdir(this.folder, { recursive: true })
    const file = path.join(this.folder, `${randomUUID()}.zip`)
    await writeFile(file, bytes, { mode: 0o600 })
    const prepared = this.keep(file, files, bytes.byteLength, null)
    this.zips.set(prepared.id, parsed)
    return prepared
  }

  async view(id: unknown, filePath: unknown): Promise<ReportFileView> {
    const kept = this.shelf.get(id)
    if (!kept) throw new ReportError('not_found', 'This report is no longer prepared')
    const info = kept.files.find((file) => file.path === filePath)
    if (!info) throw new ReportError('not_found', 'The bundle has no such file')
    let zip = this.zips.get(id as string)
    if (!zip) {
      zip = await JSZip.loadAsync(await readFile(kept.file))
      if (this.shelf.get(id)) this.zips.set(id as string, zip)
    }
    const entry = zip.file(info.path)
    if (!entry) throw new ReportError('not_found', 'The bundle has no such file')
    if (info.kind === 'binary') return { kind: 'binary' }
    if (info.kind === 'image') {
      return { kind: 'image', dataUrl: `data:image/png;base64,${await entry.async('base64')}` }
    }
    const text = await entry.async('string')
    return {
      kind: 'text',
      text: text.length > VIEW_CHARS ? text.slice(0, VIEW_CHARS) : text,
      truncated: text.length > VIEW_CHARS,
    }
  }

  /** Asks where to save the zip, warning that a public issue lets anyone download it. */
  async save(window: BrowserWindow | null, id: unknown): Promise<string | null> {
    const kept = this.shelf.get(id)
    if (!kept) throw new ReportError('not_found', 'This report is no longer prepared')
    const options: Electron.SaveDialogOptions = {
      title: t('dialogs.saveReport'),
      message: t('dialogs.saveReportWarning'),
      defaultPath: path.join(app.getPath('downloads'), `kettu-report-${stamp(new Date())}.zip`),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    }
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await copyFile(kept.file, result.filePath)
    log.info('Saved a problem report', { files: kept.files.length, size: kept.size })
    return result.filePath
  }

  discard(id: unknown): void {
    this.shelf.drop(id)
  }

  /**
   * Submits a bundle this computer built, as the user reviewed it, with this computer's sign-in.
   * One another host built is that host's to submit.
   */
  async submit(id: unknown): Promise<ReportSubmitResult> {
    const kept = this.shelf.get(id)
    if (!kept?.request) return { ok: false, reason: 'failed' }
    const [bytes, about] = await Promise.all([readFile(kept.file), this.deps.about()])
    const result = await this.deps.submit({
      bundle: new Uint8Array(bytes),
      description: kept.request.description,
      version: about.version,
      platform: about.system,
    })
    if (!result.ok) return result
    log.info('Submitted a problem report', { id: result.id, size: kept.size })
    return { ok: true, id: result.id, ...about }
  }

  recordingState(): ReportRecording | null {
    if (!this.recording) return null
    const { startedAt, endsAt } = this.recording
    return { startedAt, endsAt }
  }

  /**
   * Starts recording steps to reproduce: detailed records on, the start marked in the log, and an
   * end at most 30 minutes on, when the dialog opens with the span.
   */
  startRecording(): ReportRecording {
    if (this.recording) return this.recordingState()!
    const startedAt = Date.now()
    const verboseBefore = this.deps.verboseUntil()
    const endsAt = startedAt + RECORDING_MAX_MS
    if (verboseBefore === null || verboseBefore < endsAt) this.deps.setVerbose(endsAt)
    this.recording = { startedAt, endsAt, verboseBefore }
    log.info('Recording steps to reproduce: started')
    this.recordingTimer = setTimeout(() => this.stopRecording(), RECORDING_MAX_MS)
    this.recordingTimer.unref()
    this.deps.onRecording(this.recordingState())
    return this.recordingState()!
  }

  /** Ends the recording, puts detailed records back as they were, and opens the dialog. */
  stopRecording(): void {
    const recording = this.recording
    if (!recording) return
    if (this.recordingTimer) clearTimeout(this.recordingTimer)
    this.recordingTimer = null
    this.recording = null
    const now = Date.now()
    log.info('Recording steps to reproduce: stopped')
    const before = recording.verboseBefore
    this.deps.setVerbose(before !== null && before > now ? before : null)
    this.deps.onRecording(null)
    this.deps.onRecorded({ from: recording.startedAt, to: now })
  }

  private async build(request: ReportRequest, window: BrowserWindow | null) {
    await flushLog()
    const result = await this.deps.build({
      request,
      parent: this.deps.parent(),
      settings: this.deps.settings(),
      crashDir: app.getPath('crashDumps'),
      screenshot:
        window && request.extras.includes('screenshot')
          ? (this.shots.get(window.id)?.toPNG().toString('base64') ?? null)
          : null,
    })
    if (!result.ok) {
      log.warn(`No problem report: ${result.message}`)
      throw new ReportError(result.reason, result.message)
    }
    // The host writes nowhere else; anything outside the folder is refused, not read.
    if (path.dirname(path.resolve(result.file)) !== path.resolve(this.folder)) {
      throw new ReportError('failed', 'The host put the bundle somewhere else')
    }
    if (result.size > REPORT_MAX_BYTES) {
      await rm(result.file, { force: true }).catch(() => {})
      throw new ReportError('too_large', 'The report is too large')
    }
    return result
  }

  private keep(
    file: string,
    files: ReportFileInfo[],
    size: number,
    request: ReportRequest | null,
  ): PreparedReport {
    const id = this.shelf.put({ file, files, size, request })
    if (id === null) throw new ReportError('failed', 'The bundle is somewhere else')
    return { id, files, size }
  }
}

function stamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}
