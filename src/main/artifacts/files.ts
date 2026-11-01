// What the user does with an artifact's file: open it in the browser, export it, or import one.

import { copyFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, type BrowserWindow, dialog, shell } from 'electron'
import { ARTIFACT_ID, type ArtifactImportResult } from '@shared/artifacts'
import type { ArtifactContentResult } from '@shared/host-control'
import { safeName } from '@shared/file-name'
import { isInside } from './protocol'

const MAX_PROJECT_CHARS = 4_096
const HTML_FILTER = { name: 'HTML', extensions: ['html', 'htm'] }

/** An artifact id and a version number from the renderer, checked. */
export function parseVersion(id: unknown, version: unknown): { id: string; version: number } {
  if (typeof id !== 'string' || !ARTIFACT_ID.test(id)) throw new Error('Not an artifact id')
  if (!Number.isSafeInteger(version) || (version as number) < 1) throw new Error('Not a version')
  return { id, version: version as number }
}

export interface ArtifactFilesDeps {
  content(id: string, version: number | null): Promise<ArtifactContentResult>
  /** `artifacts/content/` in the data folder, where every version's file lies. */
  contentDir: string
  /** Has the host make an artifact of a file, in a project, or in No project when null. */
  importFile(path: string, project: string | null): Promise<NonNullable<ArtifactImportResult>>
  /** Where the copies for the browser go. */
  tempDir?: string
}

export class ArtifactFiles {
  private readonly tempDir: string

  constructor(private readonly deps: ArtifactFilesDeps) {
    this.tempDir = deps.tempDir ?? path.join(os.tmpdir(), 'kettu-artifacts')
  }

  /** `artifact:open-external`: a copy of the version in the system's temporary folder, opened. */
  async openExternal(id: unknown, version: unknown): Promise<void> {
    const found = await this.find(id, version)
    await mkdir(this.tempDir, { recursive: true, mode: 0o700 })
    const copy = path.join(this.tempDir, `${found.id}-v${found.version}.html`)
    await copyFile(found.file, copy)
    await shell.openExternal(pathToFileURL(copy).href)
  }

  /** `artifact:export`: the version's HTML, as stored, where the save dialog says; false if none. */
  async export(window: BrowserWindow | null, id: unknown, version: unknown): Promise<boolean> {
    const found = await this.find(id, version)
    const options: Electron.SaveDialogOptions = {
      defaultPath: path.join(app.getPath('downloads'), `${safeName(found.title, found.id)}.html`),
      filters: [HTML_FILTER],
    }
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    await copyFile(found.file, result.filePath)
    return true
  }

  /** `artifact:import`: asks for one HTML file; the host reads it, so the renderer names no path. */
  async import(window: BrowserWindow | null, project: unknown): Promise<ArtifactImportResult> {
    if (project !== null) {
      if (typeof project !== 'string' || project.length < 1 || project.length > MAX_PROJECT_CHARS) {
        throw new Error('Not a project')
      }
    }
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile', 'dontAddToRecent'],
      filters: [HTML_FILTER],
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const [file] = result.filePaths
    if (result.canceled || !file) return null
    return this.deps.importFile(file, project)
  }

  private async find(
    id: unknown,
    version: unknown,
  ): Promise<{ id: string; version: number; file: string; title: string }> {
    const wanted = parseVersion(id, version)
    const found = await this.deps.content(wanted.id, wanted.version)
    if (found.kind === 'failed') throw new Error('The agent host did not answer')
    if (found.kind === 'not_found' || !isInside(this.deps.contentDir, found.path)) {
      throw new Error('Not found')
    }
    return { ...wanted, file: found.path, title: found.title }
  }
}
