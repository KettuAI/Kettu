// Recent project folders, kept in state/projects.json.

import { realpath as fsRealpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { NoProject, Project } from '@shared/agent-host'
import { DEFAULT_WORKTREE_SETTINGS, type ProjectWorktreeSettings } from '@shared/git'
import type { Platform } from '@shared/platform'
import { invalidParams, notFound } from './errors'
import { t } from './i18n'
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
  private noProjectPinnedAt: number | undefined
  private missing = new Map<string, boolean>()
  private listeners = new Set<(projects: Project[], noProject: NoProject) => void>()
  private readonly now: () => number
  private readonly realpath: (value: string) => Promise<string>
  private readonly isDirectory: (value: string) => Promise<boolean>

  constructor(private readonly deps: ProjectsDeps) {
    this.now = deps.now ?? Date.now
    this.realpath = deps.realpath ?? ((value) => fsRealpath(value))
    this.isDirectory = deps.isDirectory ?? isDirectory
  }

  async load(): Promise<void> {
    const file = await this.deps.file.load()
    this.records = file.projects
    this.noProjectPinnedAt = file.noProjectPinnedAt
    await this.refreshMissing(false)
  }

  private key(value: string): string {
    return pathKey(value, this.deps.platform)
  }

  list(): Project[] {
    return this.ordered().map((record) => ({
      path: record.path,
      name: record.name,
      missing: this.missing.get(this.key(record.path)) ?? false,
      lastOpenedAt: record.lastOpenedAt,
      pinnedAt: record.pinnedAt ?? null,
      order: record.order ?? null,
    }))
  }

  /** The user's order once they moved a project, the latest opened first until then. */
  private ordered(): ProjectRecord[] {
    if (!this.records.some((record) => record.order !== undefined)) {
      return [...this.records].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    }
    // A record without a place, such as one an older version added, goes after the others.
    return [...this.records].sort(
      (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.addedAt - b.addedAt,
    )
  }

  /** The No project group, which holds the sessions started without a project. */
  noProject(): NoProject {
    return { pinnedAt: this.noProjectPinnedAt ?? null }
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
      throw invalidParams(t('project.notAbsolute'))
    }
    let canonical: string
    try {
      canonical = await canonicalizePath(value, this.deps.platform, this.realpath)
    } catch {
      throw invalidParams(t('project.notExist', { path: value }))
    }
    if (!(await this.isDirectory(canonical)))
      throw invalidParams(t('project.notFolder', { path: value }))
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
      const places = this.records.flatMap((record) => record.order ?? [])
      this.records.push({
        path: canonical,
        name: folderName(canonical, this.deps.platform),
        addedAt: now,
        lastOpenedAt: now,
        // Once the user has an order, a new project goes to its end.
        ...(places.length > 0 ? { order: Math.max(...places) + 1 } : {}),
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
    if (!record) throw notFound(t('project.noProject', { path: value }))
    return record
  }

  /** How the project names and prepares its sessions' worktrees, with the defaults filled in. */
  worktreeSettings(value: string): ProjectWorktreeSettings {
    const stored = this.find(value)?.worktree ?? {}
    return { ...DEFAULT_WORKTREE_SETTINGS, ...stored, copy: [...(stored.copy ?? [])] }
  }

  /** Stores only what differs from the defaults; a project that is not listed is refused. */
  setWorktreeSettings(value: string, settings: ProjectWorktreeSettings): void {
    const record = this.find(value)
    if (!record) throw notFound(t('project.noProject', { path: value }))
    const differs: Partial<ProjectWorktreeSettings> = {}
    for (const key of Object.keys(DEFAULT_WORKTREE_SETTINGS) as (keyof ProjectWorktreeSettings)[]) {
      if (JSON.stringify(settings[key]) !== JSON.stringify(DEFAULT_WORKTREE_SETTINGS[key])) {
        Object.assign(differs, { [key]: settings[key] })
      }
    }
    if (Object.keys(differs).length > 0) record.worktree = differs
    else delete record.worktree
    this.changed()
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

  pin(record: ProjectRecord, pinned: boolean): void {
    if (pinned === (record.pinnedAt !== undefined)) return
    if (pinned) record.pinnedAt = this.now()
    else delete record.pinnedAt
    this.changed()
  }

  /** Puts a project just before `before`, or last with null; every project then has a place. */
  move(record: ProjectRecord, before: ProjectRecord | null): void {
    if (before === record) throw invalidParams(t('project.moveBeforeItself'))
    const ordered = this.ordered().filter((item) => item !== record)
    ordered.splice(before ? ordered.indexOf(before) : ordered.length, 0, record)
    for (const [index, item] of ordered.entries()) item.order = index
    this.changed()
  }

  pinNoProject(pinned: boolean): void {
    if (pinned === (this.noProjectPinnedAt !== undefined)) return
    this.noProjectPinnedAt = pinned ? this.now() : undefined
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

  onChange(listener: (projects: Project[], noProject: NoProject) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    this.deps.file.save({
      version: 1,
      projects: this.records.map((record) => ({ ...record })),
      ...(this.noProjectPinnedAt === undefined
        ? {}
        : { noProjectPinnedAt: this.noProjectPinnedAt }),
    })
    this.notify()
  }

  private notify(): void {
    const projects = this.list()
    const noProject = this.noProject()
    for (const listener of this.listeners) listener(projects, noProject)
  }

  flush(): Promise<void> {
    return this.deps.file.flush()
  }
}
