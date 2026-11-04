// Main's side of artifacts: the protocol, its guards, and the origins each window opened.

import { join } from 'node:path'
import {
  app,
  type BrowserWindow,
  session as sessions,
  type Session,
  type WebContents,
} from 'electron'
import { ARTIFACT_ID, type ArtifactImportResult } from '@shared/artifacts'
import {
  type ArtifactExportFormat,
  type ExportedFile,
  isExportFormat,
} from '@shared/artifact-types'
import type { ArtifactContentResult, ArtifactExportResult } from '@shared/host-control'
import type { ArtifactOpenResult } from '@shared/ipc'
import { sendEvent } from '../events'
import { locale } from '../i18n'
import { ArtifactFiles, parseVersion } from './files'
import { filterArtifactRequests, guardArtifactFrames } from './guards'
import { ArtifactOrigins } from './origins'
import { WINDOW_PROXY } from './policy'
import { serveArtifacts, type ArtifactSource } from './protocol'
import { parseLayout, THUMBNAIL_PARTITION, Thumbnails } from './thumbnails'
import { ViewerFiles } from './viewers'

const MAX_URL_CHARS = 2_048

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
  thumbnailDir: string
  /** Has the host make an artifact of a file or folder, in a project, or No project when null. */
  importFile(path: string, project: string | null): Promise<NonNullable<ArtifactImportResult>>
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

  constructor(private readonly deps: ArtifactsDeps) {
    this.source = {
      contentDir: deps.contentDir,
      artifactOf: (host) => this.origins.artifactOf(host),
      content: (id, version) => deps.content(id, version),
      viewers: (this.viewers = new ViewerFiles(deps.viewersDir)),
      locale,
    }
    this.thumbnails = new Thumbnails({
      content: (id, version) => deps.content(id, version),
      dir: deps.thumbnailDir,
      source: this.source,
      serve: (id) => this.origins.serve(id),
    })
    this.files = new ArtifactFiles({
      content: (id, version) => deps.content(id, version),
      contentDir: deps.contentDir,
      importFile: (path, project) => deps.importFile(path, project),
    })
  }

  /**
   * The protocol, the request filter, the proxy and downloads, for the session the windows use,
   * and the thumbnails' own session.
   */
  async install(session: Session): Promise<void> {
    serveArtifacts(session, this.source)
    filterArtifactRequests(session)
    // A page may offer a file to save. With no save path set, Electron asks where in the system's
    // save dialog, so nothing lands on disk without the user's choice.
    session.on('will-download', (_, item) => {
      item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), item.getFilename()) })
    })
    await session.setProxy(WINDOW_PROXY)
    await this.thumbnails.install(sessions.fromPartition(THUMBNAIL_PARTITION))
  }

  watchWindow(contents: WebContents): void {
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
    if (typeof id !== 'string' || !ARTIFACT_ID.test(id)) throw new Error('Not an artifact id')
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
