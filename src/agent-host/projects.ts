// Recent project folders, kept in state/projects.json.

import { realpath as fsRealpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type { NoProject, Project } from '@shared/agent-host'
import { validateProjectIcon, type ProjectIcon } from '@shared/project-icon'
import { DEFAULT_WORKTREE_SETTINGS, type ProjectWorktreeSettings } from '@shared/git'
import type { Platform } from '@shared/platform'
import { invalidParams, notFound } from './errors'
import { t } from './i18n'
import { canonicalizePath, folderName, isAbsolutePath, pathKey } from './paths'
import type { JsonFile, ProjectRecord, ProjectsFile } from './storage'

export const PROJECT_NAME_MAX = 200
export const MAX_PROJECT_FOLDERS = 50

export interface ProjectsDeps {
  file: JsonFile<ProjectsFile>
  platform: Platform
  now?: () => number
  realpath?: (value: string) => Promise<string>
  isDirectory?: (value: string) => Promise<boolean>
}

export interface ProjectUpdate {
  name?: string | null
  folders?: string[]
  icon?: ProjectIcon | null
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
    this.records = file.projects.map((record) => {
      const seen = new Set<string>([this.key(record.path)])
      const folders = (record.folders ?? []).filter((folder) => {
        const key = this.key(folder)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      return {
        ...record,
        ...(folders.length > 0 ? { folders } : {}),
      }
    })
    for (const record of this.records) {
      if (record.folders && record.folders.length === 0) delete record.folders
    }
    this.noProjectPinnedAt = file.noProjectPinnedAt
    await this.refreshMissing(false)
  }

  private key(value: string): string {
    return pathKey(value, this.deps.platform)
  }

  private toProject(record: ProjectRecord): Project {
    const extra = record.folders ?? []
    const all = [record.path, ...extra]
    const missingFolders =
      extra.length > 0 ? all.filter((folder) => this.missing.get(this.key(folder)) ?? false) : []
    return {
      path: record.path,
      name: record.name,
      ...(record.customName ? { customName: true as const } : {}),
      ...(record.icon ? { icon: { ...record.icon } } : {}),
      ...(extra.length > 0 ? { folders: all } : {}),
      ...(missingFolders.length > 0 ? { missingFolders } : {}),
      missing: this.missing.get(this.key(record.path)) ?? false,
      lastOpenedAt: record.lastOpenedAt,
      pinnedAt: record.pinnedAt ?? null,
      archivedAt: record.archivedAt ?? null,
      order: record.order ?? null,
    }
  }

  list(): Project[] {
    return this.ordered().map((record) => this.toProject(record))
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

  /** All folders associated with a project record, primary folder first. */
  foldersOf(record: ProjectRecord): string[] {
    return record.folders && record.folders.length > 0
      ? [record.path, ...record.folders]
      : [record.path]
  }

  /** All folders across every registered project (primary + additional), deduplicated. */
  paths(): string[] {
    const out = new Map<string, string>()
    for (const record of this.records) {
      for (const folder of this.foldersOf(record)) {
        const key = this.key(folder)
        if (!out.has(key)) out.set(key, folder)
      }
    }
    return [...out.values()]
  }

  /** Matches a project strictly by its primary path. */
  findPrimary(value: string): ProjectRecord | undefined {
    const key = this.key(value)
    return this.records.find((record) => this.key(record.path) === key)
  }

  /** Matches a project by its primary path or any of its associated source folders. */
  find(value: string): ProjectRecord | undefined {
    const key = this.key(value)
    return (
      this.records.find((record) => this.key(record.path) === key) ??
      this.records.find((record) => record.folders?.some((folder) => this.key(folder) === key))
    )
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

  /** Adds a folder, or marks an existing project (primary or additional folder) as opened now. */
  async add(value: string): Promise<Project> {
    const canonical = await this.resolveDirectory(value)
    const existing = this.find(canonical)
    if (existing) {
      existing.lastOpenedAt = this.now()
      // Re-opening an archived project restores it to the sidebar while keeping its settings.
      delete existing.archivedAt
      this.missing.set(this.key(canonical), false)
      this.changed()
      return this.toProject(existing)
    }
    const now = this.now()
    const places = this.records.flatMap((record) => record.order ?? [])
    const created: ProjectRecord = {
      path: canonical,
      name: folderName(canonical, this.deps.platform),
      addedAt: now,
      lastOpenedAt: now,
      // Once the user has an order, a new project goes to its end.
      ...(places.length > 0 ? { order: Math.max(...places) + 1 } : {}),
    }
    this.records.push(created)
    this.missing.set(this.key(canonical), false)
    this.changed()
    return this.toProject(created)
  }

  /** The stored project for a primary path that may no longer exist, matched without realpath. */
  matchPrimary(value: string): ProjectRecord {
    if (!isAbsolutePath(value, this.deps.platform)) {
      throw invalidParams('path must be an absolute path')
    }
    const api = this.deps.platform === 'win32' ? path.win32 : path.posix
    const record = this.findPrimary(api.resolve(value))
    if (!record) throw notFound(t('project.noProject', { path: value }))
    return record
  }

  /** The stored project for a path (primary or additional) that may no longer exist. */
  match(value: string): ProjectRecord {
    if (!isAbsolutePath(value, this.deps.platform)) {
      throw invalidParams('path must be an absolute path')
    }
    const api = this.deps.platform === 'win32' ? path.win32 : path.posix
    const record = this.find(api.resolve(value))
    if (!record) throw notFound(t('project.noProject', { path: value }))
    return record
  }

  /**
   * Updates a project's display name and/or associated source folders.
   * Clearing `name` (empty or null) restores the primary folder basename.
   * `folders` must retain the primary folder, reject duplicates, invalid paths, and folders
   * already belonging to another project.
   */
  async update(record: ProjectRecord, changes: ProjectUpdate): Promise<Project> {
    const api = this.deps.platform === 'win32' ? path.win32 : path.posix
    const primaryKey = this.key(record.path)
    let nextFolders: string[] | undefined
    const nextMissing = new Map<string, boolean>()

    if (changes.folders !== undefined) {
      if (changes.folders.length === 0) {
        throw invalidParams(t('project.atLeastOneFolder'))
      }
      if (changes.folders.length > MAX_PROJECT_FOLDERS) {
        throw invalidParams(`folders holds more than ${MAX_PROJECT_FOLDERS}`)
      }
      const existingByKey = new Map<string, string>(
        this.foldersOf(record).map((folder) => [this.key(folder), folder]),
      )
      const seen = new Set<string>()
      const resolvedList: string[] = []
      for (const raw of changes.folders) {
        if (!isAbsolutePath(raw, this.deps.platform)) {
          throw invalidParams(t('project.notAbsolute'))
        }
        const resolved = api.resolve(raw)
        const existing = existingByKey.get(this.key(resolved))
        let canonical: string
        let isMissing = false
        try {
          canonical = await this.resolveDirectory(raw)
        } catch (error) {
          // Keep an already-associated folder that is currently unmounted/missing so renaming or
          // editing other folders still succeeds; newly added folders must exist on disk.
          if (existing !== undefined) {
            canonical = existing
            isMissing = true
          } else {
            throw error
          }
        }
        const key = this.key(canonical)
        if (seen.has(key)) {
          throw invalidParams(t('project.duplicateFolder', { path: raw }))
        }
        const owner = this.find(canonical)
        if (owner && owner !== record) {
          throw invalidParams(t('project.folderInOtherProject', { path: raw, name: owner.name }))
        }
        seen.add(key)
        nextMissing.set(key, isMissing)
        resolvedList.push(canonical)
      }
      if (!seen.has(primaryKey)) {
        throw invalidParams(t('project.primaryFolderRequired'))
      }
      nextFolders = resolvedList.filter((folder) => this.key(folder) !== primaryKey)
    }

    let nextIcon: ProjectIcon | null | undefined
    if (changes.icon !== undefined) {
      if (changes.icon === null) {
        nextIcon = null
      } else {
        const checked = validateProjectIcon(changes.icon)
        if (!checked.ok) throw invalidParams(checked.reason)
        nextIcon = checked.icon
      }
    }

    if (changes.name !== undefined) {
      const trimmed = changes.name === null ? '' : changes.name.trim()
      if (trimmed.length > PROJECT_NAME_MAX) {
        throw invalidParams(t('project.nameTooLong', { max: PROJECT_NAME_MAX }))
      }
      const fallback = folderName(record.path, this.deps.platform)
      if (trimmed === '' || trimmed === fallback) {
        record.name = fallback
        delete record.customName
      } else {
        record.name = trimmed
        record.customName = true
      }
    }

    if (nextIcon !== undefined) {
      if (nextIcon === null) delete record.icon
      else record.icon = nextIcon
    }

    if (nextFolders !== undefined) {
      for (const oldFolder of record.folders ?? []) {
        const oldKey = this.key(oldFolder)
        if (!nextMissing.has(oldKey)) this.missing.delete(oldKey)
      }
      for (const [key, isMissing] of nextMissing) {
        this.missing.set(key, isMissing)
      }
      if (nextFolders.length > 0) record.folders = nextFolders
      else delete record.folders
    }

    this.changed()
    return this.toProject(record)
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
    for (const folder of this.foldersOf(record)) {
      this.missing.delete(this.key(folder))
    }
    this.changed()
  }

  /** Hides a project from the sidebar while keeping its record, settings and history. */
  archive(record: ProjectRecord): Project {
    if (record.archivedAt !== undefined) return this.toProject(record)
    delete record.pinnedAt
    record.archivedAt = this.now()
    this.changed()
    return this.toProject(record)
  }

  /** Restores an archived project back to the sidebar. */
  unarchive(record: ProjectRecord): Project {
    if (record.archivedAt === undefined) return this.toProject(record)
    delete record.archivedAt
    record.lastOpenedAt = this.now()
    this.changed()
    return this.toProject(record)
  }

  touch(record: ProjectRecord): void {
    record.lastOpenedAt = this.now()
    this.changed()
  }

  pin(record: ProjectRecord, pinned: boolean): void {
    if (pinned && record.archivedAt !== undefined) return
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

  /** Marks projects whose folders are gone; they stay listed, so an unmounted drive loses nothing. */
  async refreshMissing(notify = true): Promise<void> {
    let changed = false
    await Promise.all(
      this.records.flatMap((record) =>
        this.foldersOf(record).map(async (folder) => {
          const missing = !(await this.isDirectory(folder))
          const key = this.key(folder)
          if (this.missing.get(key) !== missing) {
            this.missing.set(key, missing)
            changed = true
          }
        }),
      ),
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
      projects: this.records.map((record) => ({
        ...record,
        ...(record.folders ? { folders: [...record.folders] } : {}),
      })),
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
