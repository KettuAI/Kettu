// Main's side of artifacts: the protocol, its guards, and the origins each window opened.

import { join } from 'node:path'
import { app, type Session, type WebContents } from 'electron'
import { ARTIFACT_ID } from '@shared/artifacts'
import type { ArtifactContentResult } from '@shared/host-control'
import type { ArtifactOpenResult } from '@shared/ipc'
import { sendEvent } from '../events'
import { filterArtifactRequests, guardArtifactFrames } from './guards'
import { ArtifactOrigins } from './origins'
import { serveArtifacts } from './protocol'

const MAX_URL_CHARS = 2_048

export interface ArtifactsDeps {
  content(id: string, version: number | null): Promise<ArtifactContentResult>
  contentDir: string
}

export class Artifacts {
  readonly origins = new ArtifactOrigins()

  constructor(private readonly deps: ArtifactsDeps) {}

  /** The protocol, the request filter and downloads, for the session the windows use. */
  install(session: Session): void {
    serveArtifacts(session, {
      contentDir: this.deps.contentDir,
      artifactOf: (host) => this.origins.artifactOf(host),
      content: (id, version) => this.deps.content(id, version),
    })
    filterArtifactRequests(session)
    // A page may offer a file to save. With no save path set, Electron asks where in the system's
    // save dialog, so nothing lands on disk without the user's choice.
    session.on('will-download', (_, item) => {
      item.setSaveDialogOptions({ defaultPath: join(app.getPath('downloads'), item.getFilename()) })
    })
  }

  watchWindow(contents: WebContents): void {
    this.origins.watch(contents)
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

  /** `artifact:close`. */
  close(contents: WebContents, url: unknown): void {
    if (typeof url !== 'string' || url.length > MAX_URL_CHARS) {
      throw new Error('Not an artifact URL')
    }
    this.origins.close(contents, url)
  }
}
