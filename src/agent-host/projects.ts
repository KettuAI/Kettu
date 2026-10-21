// Recent project folders, kept in state/projects.json.

import { realpath as fsRealpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Project } from '@shared/agent-host'
import type { Platform } from '@shared/platform'
import { invalidParams, notFound } from './errors'
import { canonicalizePath, folderName, isAbsolutePath, pathKey } from './paths'
import type { JsonFile, ProjectRecord, ProjectsFile } from './storage'

export interface ProjectsDeps {
  file: JsonFile<ProjectsFile>
  platform: Platform
  now?: () => number
  realpath?: (value: string) => Promise<string>
  isDirectory?: (value: string) => Promise<boolean>
}

async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory()
  } catch {
    return false
  }
}

export class Projects {
  private records: ProjectRecord[] = []
  private missing = new Map<string, boolean>()
  private listeners = new Set<(projects: Project[]) => void>()
  private readonly now: () => number
  private readonly realpath: (value: string) => Promise<string>
  private readonly isDirectory: (value: string) => Promise<boolean>

  constructor(private readonly deps: ProjectsDeps) {
    this.now = deps.now ?? Date.now
    this.realpath = deps.realpath ?? ((value) => fsRealpath(value))
    this.isDirectory = deps.isDirectory ?? isDirectory
  }

  async load(): Promise<void> {
    this.records = (await this.deps.file.load()).projects
    await this.refreshMissing(false)
  }

  private key(value: string): string {
    return pathKey(value, this.deps.platform)
  }

  list(): Project[] {
    return [...this.records]
      .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
      .map((record) => ({
        path: record.path,
        name: record.name,
        missing: this.missing.get(this.key(record.path)) ?? false,
        lastOpenedAt: record.lastOpenedAt,
      }))
  }

  paths(): string[] {
    return this.records.map((record) => record.path)
  }

  find(value: string): ProjectRecord | undefined {
    const key = this.key(value)
    return this.records.find((record) => this.key(record.path) === key)
  }

  /**
   * The canonical path of an existing folder, for any request that names one. Rejects
   * relative paths, missing paths and files with `invalid_params`.
   */
  async resolveDirectory(value: string): Promise<string> {
    if (!isAbsolutePath(value, this.deps.platform)) {
      throw invalidParams('projectPath must be an absolute path')
    }
    let canonical: string
    try {
      canonical = await canonicalizePath(value, this.deps.platform, this.realpath)
    } catch {
      throw invalidParams(`${value} does not exist`)
    }
    if (!(await this.isDirectory(canonical))) throw invalidParams(`${value} is not a folder`)
    return canonical
  }

  /** Adds a folder, or marks an existing project as opened now. */
  async add(value: string): Promise<Project> {
    const canonical = await this.resolveDirectory(value)
    const existing = this.find(canonical)
    if (existing) {
      existing.lastOpenedAt = this.now()
      this.missing.set(this.key(existing.path), false)
    } else {
      const now = this.now()
      this.records.push({
        path: canonical,
        name: folderName(canonical, this.deps.platform),
        addedAt: now,
        lastOpenedAt: now,
      })
      this.missing.set(this.key(canonical), false)
    }
    this.changed()
    return this.list().find((project) => this.key(project.path) === this.key(canonical))!
  }

  /** The stored project for a path that may no longer exist, matched without realpath. */
  match(value: string): ProjectRecord {
    if (!isAbsolutePath(value, this.deps.platform)) {
      throw invalidParams('path must be an absolute path')
    }
    const api = this.deps.platform === 'win32' ? path.win32 : path.posix
    const record = this.find(api.resolve(value))
    if (!record) throw notFound(`No project at ${value}`)
    return record
  }

  remove(record: ProjectRecord): void {
    this.records = this.records.filter((item) => item !== record)
    this.missing.delete(this.key(record.path))
    this.changed()
  }

  touch(record: ProjectRecord): void {
    record.lastOpenedAt = this.now()
    this.changed()
  }

  /** Marks projects whose folder is gone; they stay listed, so an unmounted drive loses nothing. */
  async refreshMissing(notify = true): Promise<void> {
    let changed = false
    await Promise.all(
      this.records.map(async (record) => {
        const missing = !(await this.isDirectory(record.path))
        const key = this.key(record.path)
        if (this.missing.get(key) !== missing) {
          this.missing.set(key, missing)
          changed = true
        }
      }),
    )
    if (changed && notify) this.notify()
  }

  onChange(listener: (projects: Project[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    this.deps.file.save({ version: 1, projects: this.records.map((record) => ({ ...record })) })
    this.notify()
  }

  private notify(): void {
    const projects = this.list()
    for (const listener of this.listeners) listener(projects)
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }
}
