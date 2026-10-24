// Main's side of artifacts: the protocol, its guards, and the origins each window opened.

import { join } from 'node:path'
import { app, session as sessions, type Session, type WebContents } from 'electron'
import { ARTIFACT_ID } from '@shared/artifacts'
import type { ArtifactContentResult } from '@shared/host-control'
import type { ArtifactOpenResult } from '@shared/ipc'
import { sendEvent } from '../events'
import { filterArtifactRequests, guardArtifactFrames } from './guards'
import { ArtifactOrigins } from './origins'
import { WINDOW_PROXY } from './policy'
import { serveArtifacts, type ArtifactSource } from './protocol'
import { parseLayout, THUMBNAIL_PARTITION, Thumbnails } from './thumbnails'

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
}

export class Artifacts {
  readonly origins = new ArtifactOrigins()
  private readonly source: ArtifactSource
  private readonly thumbnails: Thumbnails

  constructor(private readonly deps: ArtifactsDeps) {
    this.source = {
      contentDir: deps.contentDir,
      artifactOf: (host) => this.origins.artifactOf(host),
      content: (id, version) => deps.content(id, version),
    }
    this.thumbnails = new Thumbnails({
      content: (id, version) => deps.content(id, version),
      dir: deps.thumbnailDir,
      source: this.source,
      serve: (id) => this.origins.serve(id),
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
    if (typeof id !== 'string' || !ARTIFACT_ID.test(id)) throw new Error('Not an artifact id')
    if (!Number.isSafeInteger(version) || (version as number) < 1) throw new Error('Not a version')
    return this.thumbnails.thumbnail(id, version as number, parseLayout(layout))
  }

  /** `artifact:close`. */
  close(contents: WebContents, url: unknown): void {
    if (typeof url !== 'string' || url.length > MAX_URL_CHARS) {
      throw new Error('Not an artifact URL')
    }
    this.origins.close(contents, url)
  }
}
