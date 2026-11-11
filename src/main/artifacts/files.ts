// What the user does with an artifact's files: open them in the browser, export them, or import a
// file or folder.

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, type BrowserWindow, dialog, shell } from 'electron'
import { ARTIFACT_ENTRY } from '@shared/artifact-files'
import { CANVAS_FILE } from '@shared/canvas-doc'
import { isImagePath } from '@shared/artifact-document'
import {
  type ArtifactExportFormat,
  type ArtifactTypeInfo,
  EXPORT_EXTENSIONS,
  type ExportedFile,
  isExportFormat,
} from '@shared/artifact-types'
import {
  type ArtifactImportKind,
  type ArtifactImportResult,
  parseArtifactRef,
} from '@shared/artifacts'
import type { ArtifactContentFile, ArtifactContentResult } from '@shared/host-control'
import { safeName } from '@shared/file-name'
import { overviewOf } from './overview'
import { isInside, isStored } from './protocol'

const MAX_PROJECT_CHARS = 4_096
const HTML_FILTER = { name: 'HTML', extensions: ['html', 'htm'] }

/** An artifact's reference and a version number from the renderer, checked. */
export function parseVersion(id: unknown, version: unknown): { id: string; version: number } {
  if (typeof id !== 'string' || !parseArtifactRef(id)) throw new Error('Not an artifact id')
  if (!Number.isSafeInteger(version) || (version as number) < 1) throw new Error('Not a version')
  return { id, version: version as number }
}

/**
 * Where each of a version's files goes under `folder`: the paths the host stored, which have no
 * `..` or root, checked again so none lands outside.
 */
export function placed(
  folder: string,
  files: readonly Pick<ArtifactContentFile, 'path'>[],
): string[] {
  return files.map((file) => {
    const target = path.join(folder, ...file.path.split('/'))
    if (!isInside(folder, target))
      throw new Error(`Refused a path outside the folder: ${file.path}`)
    return target
  })
}

/** Copies a version's files into `folder`, making the folders they need. */
async function copyInto(folder: string, files: readonly ArtifactContentFile[]): Promise<void> {
  const targets = placed(folder, files)
  for (const [i, file] of files.entries()) {
    await mkdir(path.dirname(targets[i]!), { recursive: true })
    await copyFile(file.file, targets[i]!)
  }
}

export interface ArtifactFilesDeps {
  content(id: string, version: number | null): Promise<ArtifactContentResult>
  /** `artifacts/content/` in the data folder, where the bytes of every file lie. */
  contentDir: string
  /** Where the files main fetched from other hosts lie. */
  remoteDir?: string
  /** Has the host make an artifact of a file or folder, in a project, or No project when null. */
  importFile(path: string, project: string | null): Promise<NonNullable<ArtifactImportResult>>
  /** Where the copies for the browser go. */
  tempDir?: string
}

interface FoundVersion {
  id: string
  version: number
  title: string
  files: ArtifactContentFile[]
}

export class ArtifactFiles {
  private readonly tempDir: string

  constructor(private readonly deps: ArtifactFilesDeps) {
    this.tempDir = deps.tempDir ?? path.join(os.tmpdir(), 'kettu-artifacts')
  }

  /**
   * `artifact:open-external`: a copy of the version in the system's temporary folder, opened; a
   * version of several files in a folder of its own.
   */
  async openExternal(id: unknown, version: unknown): Promise<void> {
    const found = await this.find(id, version)
    await mkdir(this.tempDir, { recursive: true, mode: 0o700 })
    const name = `${found.id}-v${found.version}`
    const overview = await overviewOf(found.files, found.title)
    let page: string
    if (found.files.length === 1 && !overview) {
      page = path.join(this.tempDir, `${name}.html`)
      await copyFile(found.files[0]!.file, page)
    } else {
      const folder = path.join(this.tempDir, name)
      await rm(folder, { recursive: true, force: true })
      await copyInto(folder, found.files)
      page = path.join(folder, ARTIFACT_ENTRY)
      if (overview) await writeFile(page, overview)
    }
    await shell.openExternal(pathToFileURL(page).href)
  }

  /**
   * `artifact:export`: the version's files, as stored, where the save dialog says: one HTML file,
   * or a folder for a version of several. False when the user cancelled.
   */
  async export(window: BrowserWindow | null, id: unknown, version: unknown): Promise<boolean> {
    const found = await this.find(id, version)
    const overview = await overviewOf(found.files, found.title)
    const single = found.files.length === 1 && !overview
    const name = safeName(found.title, found.id)
    const options: Electron.SaveDialogOptions = single
      ? {
          defaultPath: path.join(app.getPath('downloads'), `${name}.html`),
          filters: [HTML_FILTER],
        }
      : {
          defaultPath: path.join(app.getPath('downloads'), name),
          properties: ['createDirectory', 'showOverwriteConfirmation'],
        }
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    if (single) await copyFile(found.files[0]!.file, result.filePath)
    else {
      await copyInto(result.filePath, found.files)
      if (overview) await writeFile(path.join(result.filePath, ARTIFACT_ENTRY), overview)
    }
    return true
  }

  /**
   * `artifact:export-as`: a typed version in one of its type's formats, `make` converting it once
   * the user chose where: one file, or a folder for Markdown with pictures. False when cancelled.
   */
  async exportAs(
    window: BrowserWindow | null,
    id: unknown,
    version: unknown,
    format: unknown,
    make: (
      wanted: { id: string; version: number },
      type: ArtifactTypeInfo,
      format: ArtifactExportFormat,
    ) => Promise<ExportedFile[]>,
  ): Promise<boolean> {
    const wanted = parseVersion(id, version)
    const found = await this.deps.content(wanted.id, wanted.version)
    if (found.kind === 'failed') throw new Error('The agent host did not answer')
    if (found.kind === 'not_found' || !found.type) throw new Error('Not found')
    const type = found.type
    if (!isExportFormat(type.name, format)) throw new Error('Not a format this type exports to')
    const name = safeName(found.title, wanted.id)
    const folder = format === 'md' && found.files.some((file) => isImagePath(file.path))
    const extension = EXPORT_EXTENSIONS[format]
    const options: Electron.SaveDialogOptions = folder
      ? {
          defaultPath: path.join(app.getPath('downloads'), name),
          properties: ['createDirectory', 'showOverwriteConfirmation'],
        }
      : {
          defaultPath: path.join(app.getPath('downloads'), `${name}.${extension}`),
          filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
        }
    const result = window
      ? await dialog.showSaveDialog(window, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    const files = await make(wanted, type, format)
    if (!folder) {
      await writeFile(result.filePath, files[0]!.bytes)
      return true
    }
    const targets = placed(result.filePath, files)
    for (const [i, file] of files.entries()) {
      await mkdir(path.dirname(targets[i]!), { recursive: true })
      await writeFile(targets[i]!, file.bytes)
    }
    return true
  }

  /**
   * `artifact:import`: asks for one HTML file or for a folder with an `index.html`; the host reads
   * it, so the renderer names no path.
   */
  async import(
    window: BrowserWindow | null,
    project: unknown,
    kind: unknown,
  ): Promise<ArtifactImportResult> {
    if (project !== null) {
      if (typeof project !== 'string' || project.length < 1 || project.length > MAX_PROJECT_CHARS) {
        throw new Error('Not a project')
      }
    }
    if (kind !== 'file' && kind !== 'folder') throw new Error('Not a kind of import')
    const options: Electron.OpenDialogOptions =
      (kind as ArtifactImportKind) === 'file'
        ? { properties: ['openFile', 'dontAddToRecent'], filters: [HTML_FILTER] }
        : { properties: ['openDirectory', 'dontAddToRecent'] }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    const [chosen] = result.filePaths
    if (result.canceled || !chosen) return null
    return this.deps.importFile(chosen, project)
  }

  private async find(id: unknown, version: unknown): Promise<FoundVersion> {
    const wanted = parseVersion(id, version)
    const found = await this.deps.content(wanted.id, wanted.version)
    if (found.kind === 'failed') throw new Error('The agent host did not answer')
    if (
      found.kind === 'not_found' ||
      !found.files.some((file) => file.path === ARTIFACT_ENTRY || file.path === CANVAS_FILE) ||
      !found.files.every((file) => isStored(this.deps, wanted.id, file.file))
    ) {
      throw new Error('Not found')
    }
    return { ...wanted, title: found.title, files: found.files }
  }
}
