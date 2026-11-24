// The artifact templates of plugins that are on: a description of what to make and the starter
// files it begins from, read from the plugin's package on the host. A template adds no code: the
// viewer is its type's own, and its files are held to what that type's content may hold and to the
// limits of any artifact. One that does not read is left out and logged once.

import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { isImagePath } from '@shared/artifact-document'
import {
  artifactPathProblem,
  caseClash,
  DISK_FILE_BYTES,
  VERSION_BYTES,
  VERSION_FILES,
} from '@shared/artifact-files'
import {
  ARTIFACT_TYPES,
  CONTENT_ENTRIES,
  isArtifactTypeName,
  type ArtifactTypeName,
} from '@shared/artifact-types'
import type { PluginResource } from '@shared/plugins'
import type { LogFn } from '../storage'

const DESCRIPTION_BYTES = 64 * 1024
const GUIDANCE_CHARS = 8_000
/** What the folder form's description is called, which is not one of the starter files. */
const DESCRIPTION_FILE = 'template.json'

export interface TemplateFile {
  /** The path the artifact gets, relative to the template's folder. */
  path: string
  size: number
}

export interface PluginTemplate {
  /** What tools name it by: the plugin's name, a colon and the template's name. */
  id: string
  pluginId: string
  /** The plugin's title. */
  plugin: string
  title: string
  summary: string
  /** The built-in type it makes, whose viewer shows it. */
  type: ArtifactTypeName
  /** What the agent reads besides the type's own guidance. */
  guidance: string
  files: TemplateFile[]
  /** The folder the starter files are in; null for a template without any. */
  folder: string | null
}

export interface PluginTemplatesDeps {
  /** The templates of the plugins that are on, each with the file that describes it. */
  resources(): Promise<PluginResource[]>
  log: LogFn
}

export class PluginTemplates {
  private readonly told = new Set<string>()

  constructor(private readonly deps: PluginTemplatesDeps) {}

  /** The templates that read, read again each time, so a plugin turned off is gone at once. */
  async list(): Promise<PluginTemplate[]> {
    const out: PluginTemplate[] = []
    const ids = new Set<string>()
    const resources = [...(await this.deps.resources())].sort(
      (a, b) => a.pluginName.localeCompare(b.pluginName) || a.name.localeCompare(b.name),
    )
    for (const resource of resources) {
      const id = `${resource.pluginName}:${resource.name}`
      try {
        if (ids.has(id)) throw new Error('another plugin of the same name has a template of it')
        out.push(await this.read(resource, id))
        ids.add(id)
      } catch (error) {
        const reason = (error as Error).message
        if (!this.told.has(`${id} ${reason}`)) {
          this.told.add(`${id} ${reason}`)
          this.deps.log('warn', `Left out the artifact template ${id}: ${reason}`)
        }
      }
    }
    return out
  }

  /** The starter files of a template with their bytes, read again from the package. */
  async starters(template: PluginTemplate): Promise<{ path: string; data: Buffer }[]> {
    const { folder } = template
    if (!folder) return []
    const out: { path: string; data: Buffer }[] = []
    for (const file of template.files) {
      const at = path.join(folder, ...file.path.split('/'))
      const info = await lstat(at)
      if (!info.isFile() || info.size > DISK_FILE_BYTES) {
        throw new Error(`${file.path} changed since the template was read`)
      }
      out.push({ path: file.path, data: await readFile(at) })
    }
    return out
  }

  private async read(resource: PluginResource, id: string): Promise<PluginTemplate> {
    const parts = resource.path.split('/')
    const inFolder = parts.length === 4 && parts[3] === DESCRIPTION_FILE
    if (!inFolder && !(parts.length === 3 && resource.path.toLowerCase().endsWith('.json'))) {
      throw new Error(`it is not a ${DESCRIPTION_FILE} in a folder of its own or a .json file`)
    }
    const description = await regularFile(resource.file, DESCRIPTION_BYTES)
    const raw = parseObject(description.toString('utf8'))
    const type = raw.type
    if (!isArtifactTypeName(type)) {
      throw new Error(`its type must be one of ${ARTIFACT_TYPES.join(', ')}`)
    }
    const { guidance } = raw
    if (
      guidance !== undefined &&
      (typeof guidance !== 'string' || guidance.length > GUIDANCE_CHARS)
    ) {
      throw new Error(`its guidance must be text of at most ${GUIDANCE_CHARS} characters`)
    }
    const folder = inFolder ? path.dirname(resource.file) : null
    return {
      id,
      pluginId: resource.pluginId,
      plugin: resource.plugin,
      title: resource.title ?? resource.name,
      summary: resource.description,
      type,
      guidance: guidance?.trim() ?? '',
      files: folder ? await startersOf(folder, type) : [],
      folder,
    }
  }
}

async function regularFile(file: string, max: number): Promise<Buffer> {
  const info = await lstat(file)
  if (!info.isFile()) throw new Error('its description is not a plain file')
  if (info.size > max) throw new Error(`its description is larger than ${max / 1024} KB`)
  return readFile(file)
}

function parseObject(text: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new Error('its description is not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('its description is not an object')
  }
  return value as Record<string, unknown>
}

/**
 * The files of a template's folder besides its description, which become the artifact's own: only
 * what the type holds, within the limits of any artifact, and nothing that links out of the folder.
 */
async function startersOf(folder: string, type: ArtifactTypeName): Promise<TemplateFile[]> {
  const files: TemplateFile[] = []
  let total = 0
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const relative = `${prefix}${entry.name}`
      if (relative === DESCRIPTION_FILE) continue
      const at = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`${relative} is a link`)
      if (entry.isDirectory()) {
        await walk(at, `${relative}/`)
        continue
      }
      if (!entry.isFile()) throw new Error(`${relative} is not a plain file`)
      const problem = artifactPathProblem(relative)
      if (problem) throw new Error(`the path ${relative} ${problem}`)
      if (relative !== CONTENT_ENTRIES[type] && !isImagePath(relative)) {
        throw new Error(
          `it holds ${relative}, which a ${type} does not hold; a template adds no code and ` +
            `only ${CONTENT_ENTRIES[type]} and pictures under images/`,
        )
      }
      const { size } = await lstat(at)
      if (size > DISK_FILE_BYTES) throw new Error(`${relative} is larger than a file may be`)
      total += size
      files.push({ path: relative, size })
      if (files.length > VERSION_FILES || total > VERSION_BYTES) {
        throw new Error('it holds more than an artifact may')
      }
    }
  }
  await walk(folder, '')
  const clash = caseClash(files.map((file) => file.path))
  if (clash) throw new Error(`${clash[0]} and ${clash[1]} differ only in case`)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}
