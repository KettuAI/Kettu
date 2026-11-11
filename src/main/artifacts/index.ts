// Main's side of artifacts: the protocol, its guards, and the origins each window opened.

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  app,
  type BrowserWindow,
  dialog,
  session as sessions,
  type Session,
  type WebContents,
} from 'electron'
import type { SelectMessage } from '@shared/artifact-runtime/page-messages'
import { type ArtifactImportResult, parseArtifactRef } from '@shared/artifacts'
import type { RuntimeAnswer } from '@shared/artifact-capabilities'
import {
  type ArtifactExportFormat,
  type ExportedFile,
  isExportFormat,
} from '@shared/artifact-types'
import { safeName } from '@shared/file-name'
import type { ArtifactContentResult, ArtifactExportResult } from '@shared/host-control'
import type { ArtifactOpenResult } from '@shared/ipc'
import { sendEvent } from '../events'
import { locale } from '../i18n'
import { ArtifactFiles, parseVersion } from './files'
import { filterArtifactRequests, guardArtifactFrames } from './guards'
import { ARTIFACT_SCHEME, ArtifactOrigins, originId } from './origins'
import { WINDOW_PROXY } from './policy'
import { serveArtifacts, type ArtifactSource } from './protocol'
import { parseLayout, parsePage, parseSize, THUMBNAIL_PARTITION, Thumbnails } from './thumbnails'
import { ViewerFiles } from './viewers'

const MAX_URL_CHARS = 2_048
const NAME_CHARS = 200
/** The picks a page may report each second; a page that sends more loses the rest. */
export const PICKS_PER_SECOND = 20

/** Counts each origin's reports per second, so a page cannot flood the windows that show it. */
export class ReportLimit {
  private readonly seconds = new Map<string, { at: number; count: number }>()

  constructor(
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  allow(key: string): boolean {
    const second = Math.floor(this.now() / 1000)
    const current = this.seconds.get(key)
    if (!current || current.at !== second) {
      if (this.seconds.size > 1_000) this.seconds.clear()
      this.seconds.set(key, { at: second, count: 1 })
      return true
    }
    current.count++
    return current.count <= this.perSecond
  }
}

/**
 * Must run before the app is ready. Blink resolves any host a page names in a `dns-prefetch` link,
 * which no policy, request filter or header stops, so a page could spell data out in a DNS query.
 * It is off for every page; the app's own names no host.
 */
export function disableDnsPrefetching(): void {
  app.commandLine.appendSwitch('blink-settings', 'dnsPrefetchingEnabled=false')
}

export interface ArtifactsDeps {
  content(id: string, version: number | null): Promise<ArtifactContentResult>
  contentDir: string
  /** Where the files main fetched from other hosts lie. */
  remoteDir?: string
  thumbnailDir: string
  /** Has the host make an artifact of a file or folder, in a project, or No project when null. */
  importFile(path: string, project: string | null): Promise<NonNullable<ArtifactImportResult>>
  /** Passes a page's capability message to the host; returns the cancel. */
  runtime(artifactId: string, message: unknown, answer: (answer: RuntimeAnswer) => void): () => void
  /** The type viewers' build folder. */
  viewersDir: string
  /** Has the host convert a typed version to one of its type's formats. */
  exportVersion(
    id: string,
    version: number,
    format: ArtifactExportFormat,
  ): Promise<ArtifactExportResult>
}

export class Artifacts {
  readonly origins = new ArtifactOrigins()
  readonly viewers: ViewerFiles
  private readonly source: ArtifactSource
  private readonly thumbnails: Thumbnails
  private readonly files: ArtifactFiles
  private readonly windows = new Set<WebContents>()
  private readonly picks = new ReportLimit(PICKS_PER_SECOND)
  /** The origin ids whose latest version declares what reads beyond the page, as last served. */
  private readonly declaredStrict = new Set<string>()
  /**
   * The origin ids a page asked for such a capability in this run. Its pages may hold what it
   * read, so they keep off the CDNs until the app quits, whatever comes later.
   */
  private readonly reading = new Set<string>()

  constructor(private readonly deps: ArtifactsDeps) {
    this.source = {
      contentDir: deps.contentDir,
      remoteDir: deps.remoteDir,
      artifactOf: (host) => this.origins.artifactOf(host),
      content: (id, version) => deps.content(id, version),
      selected: (host, message) => this.selected(host, message),
      runtime: {
        send: (id, message, answer) => deps.runtime(id, message, answer),
        reading: (id) => this.reading.add(originId(id)),
      },
      declared: (id, strict) => {
        if (strict) this.declaredStrict.add(originId(id))
        else this.declaredStrict.delete(originId(id))
      },
      viewers: (this.viewers = new ViewerFiles(deps.viewersDir)),
      locale,
    }
    this.thumbnails = new Thumbnails({
      content: (id, version) => deps.content(id, version),
      dir: deps.thumbnailDir,
      source: this.source,
      serve: (id) => this.origins.serve(id),
      strict: (host) => this.isStrict(host),
    })
    this.files = new ArtifactFiles({
      content: (id, version) => deps.content(id, version),
      contentDir: deps.contentDir,
      remoteDir: deps.remoteDir,
      importFile: (path, project) => deps.importFile(path, project),
    })
  }

  /**
   * The protocol, the request filter, the proxy and downloads, for the session the windows use,
   * and the thumbnails' own session.
   */
  async install(session: Session): Promise<void> {
    serveArtifacts(session, this.source)
    filterArtifactRequests(session, (host) => this.isStrict(host))
    // A page may offer a file to save. With no save path set, Electron asks where in the system's
    // save dialog, so nothing lands on disk without the user's choice.
    session.on('will-download', (_, item) => {
      item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), item.getFilename()) })
    })
    await session.setProxy(WINDOW_PROXY)
    await this.thumbnails.install(sessions.fromPartition(THUMBNAIL_PARTITION))
  }

  /** A page's pick, for the windows that opened its origin; the page's data is checked already. */
  private selected(host: string, message: SelectMessage): void {
    if (!this.picks.allow(host)) return
    const origin = `${ARTIFACT_SCHEME}://${host}`
    for (const contents of this.windows) {
      if (!contents.isDestroyed() && this.origins.isOpenedIn(contents, origin)) {
        sendEvent(contents, 'artifact:selected', { origin, message })
      }
    }
  }

  /** Whether the artifact on this origin id loads nothing from the CDNs, whatever its policy. */
  private isStrict(host: string): boolean {
    return this.declaredStrict.has(host) || this.reading.has(host)
  }

  watchWindow(contents: WebContents): void {
    this.windows.add(contents)
    contents.once('destroyed', () => this.windows.delete(contents))
    this.origins.watch(contents)
    // No UDP for WebRTC, so its connections go through the session's proxy, which refuses them.
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    guardArtifactFrames(contents, {
      platform: process.platform,
      blocked: (event) => sendEvent(contents, 'artifact:blocked', event),
      stopped: (event) => sendEvent(contents, 'artifact:stopped', event),
      shortcut: (key) => sendEvent(contents, 'app:shortcut', key),
    })
  }

  /** `artifact:open`: lets the window frame an artifact the host knows. */
  async open(contents: WebContents, id: unknown): Promise<ArtifactOpenResult> {
    if (typeof id !== 'string' || !parseArtifactRef(id)) throw new Error('Not an artifact id')
    const found = await this.deps.content(id, null)
    if (found.kind === 'not_found') return { failed: 'not_found' }
    if (found.kind === 'failed') return { failed: 'unavailable' }
    return { url: this.origins.open(contents, id) }
  }

  /** `artifact:thumbnail`. */
  async thumbnail(id: unknown, version: unknown, layout: unknown): Promise<string | null> {
    const wanted = parseVersion(id, version)
    return this.thumbnails.thumbnail(wanted.id, wanted.version, parseLayout(layout))
  }

  /** A page of a version as a PNG at its own size; null when it cannot render. */
  async png(id: unknown, version: unknown, page: unknown, size: unknown): Promise<Buffer | null> {
    const wanted = parseVersion(id, version)
    const checked = parseSize(size)
    if (!checked) throw new Error('Not a page size')
    return this.thumbnails.image(wanted.id, wanted.version, parsePage(page), checked)
  }

  /** `artifact:png`: the page's image where the save dialog says; false when cancelled. */
  async savePng(
    window: BrowserWindow | null,
    id: unknown,
    version: unknown,
    page: unknown,
    size: unknown,
    name: unknown,
  ): Promise<boolean> {
    if (typeof name !== 'string' || name.length > NAME_CHARS) throw new Error('Not a file name')
    const image = await this.png(id, version, page, size)
    if (!image) throw new Error('The page could not be rendered')
    const options: Electron.SaveDialogOptions = {
      defaultPath: join(app.getPath('downloads'), `${safeName(name, 'page')}.png`),
      filters: [{ name: 'PNG', extensions: ['png'] }],
    }
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, image)
    return true
  }

  /** `artifact:open-external`. */
  openExternal(id: unknown, version: unknown): Promise<void> {
    return this.files.openExternal(id, version)
  }

  /** `artifact:export`. */
  export(window: BrowserWindow | null, id: unknown, version: unknown): Promise<boolean> {
    return this.files.export(window, id, version)
  }

  /** `artifact:export-as`: a typed version in one of its type's formats. */
  exportAs(
    window: BrowserWindow | null,
    id: unknown,
    version: unknown,
    format: unknown,
  ): Promise<boolean> {
    return this.files.exportAs(window, id, version, format, async (wanted, _type, as) => {
      if (as === 'pdf') {
        return [
          { path: 'slides.pdf', bytes: await this.thumbnails.print(wanted.id, wanted.version) },
        ]
      }
      return this.converted(wanted.id, wanted.version, as)
    })
  }

  /** A typed version's PDF, for a paired device to save. */
  async printPdf(id: unknown, version: unknown): Promise<Buffer> {
    const wanted = parseVersion(id, version)
    const found = await this.deps.content(wanted.id, wanted.version)
    if (found.kind !== 'found' || !found.type) throw new Error('Not found')
    if (!isExportFormat(found.type.name, 'pdf'))
      throw new Error('Not a format this type exports to')
    return this.thumbnails.print(wanted.id, wanted.version)
  }

  private async converted(
    id: string,
    version: number,
    format: ArtifactExportFormat,
  ): Promise<ExportedFile[]> {
    const result = await this.deps.exportVersion(id, version, format)
    if (result.kind === 'not_found') throw new Error('Not found')
    if (result.kind === 'failed') throw new Error(`The export failed: ${result.message}`)
    return result.files
  }

  /** `artifact:import`. */
  import(
    window: BrowserWindow | null,
    project: unknown,
    kind: unknown,
  ): Promise<ArtifactImportResult> {
    return this.files.import(window, project, kind)
  }

  /** `artifact:close`. */
  close(contents: WebContents, url: unknown): void {
    if (typeof url !== 'string' || url.length > MAX_URL_CHARS) {
      throw new Error('Not an artifact URL')
    }
    this.origins.close(contents, url)
  }
}
