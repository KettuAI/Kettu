// A plugin's own storage: a small key-value file in the plugin's folder on the host, which goes
// when the plugin does. Each write replaces the file whole, so a crash leaves the file as it was.

import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { PLUGIN_STORAGE_LIMITS } from '@shared/plugins'
import type { LogFn } from '../storage'

type Entries = Record<string, unknown>

export const STORAGE_FILE = 'storage.json'

function isRecord(value: unknown): value is Entries {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class PluginStorage {
  private readonly loaded = new Map<string, Promise<Entries>>()
  private readonly queues = new Map<string, Promise<unknown>>()

  /** `folder` is where a plugin's own files live; it exists while the plugin is installed. */
  constructor(
    private readonly folder: (pluginId: string) => string,
    private readonly log: LogFn,
  ) {}

  async get(pluginId: string, key: string): Promise<unknown> {
    const entries = await this.read(pluginId)
    return Object.hasOwn(entries, key) ? entries[key] : null
  }

  async keys(pluginId: string): Promise<string[]> {
    return Object.keys(await this.read(pluginId)).sort()
  }

  set(pluginId: string, key: string, value: unknown): Promise<null> {
    return this.write(pluginId, (entries) => {
      if (key.length === 0 || key.length > PLUGIN_STORAGE_LIMITS.keyChars) {
        throw new Error(`A storage key takes 1 to ${PLUGIN_STORAGE_LIMITS.keyChars} characters`)
      }
      const next = { ...entries, [key]: value ?? null }
      if (Object.keys(next).length > PLUGIN_STORAGE_LIMITS.keys) {
        throw new Error(`Storage holds at most ${PLUGIN_STORAGE_LIMITS.keys} keys`)
      }
      if (Buffer.byteLength(JSON.stringify(next)) > PLUGIN_STORAGE_LIMITS.bytes) {
        throw new Error(`Storage is full: it holds at most ${PLUGIN_STORAGE_LIMITS.bytes} bytes`)
      }
      return next
    })
  }

  delete(pluginId: string, key: string): Promise<null> {
    return this.write(pluginId, (entries) => {
      return Object.fromEntries(Object.entries(entries).filter(([name]) => name !== key))
    })
  }

  /** Lets go of what is held in memory for a plugin that was removed. */
  forget(pluginId: string): void {
    this.loaded.delete(pluginId)
    this.queues.delete(pluginId)
  }

  private file(pluginId: string): string {
    return path.join(this.folder(pluginId), STORAGE_FILE)
  }

  private read(pluginId: string): Promise<Entries> {
    let held = this.loaded.get(pluginId)
    if (!held) {
      held = readFile(this.file(pluginId), 'utf8').then(
        (text) => {
          try {
            const parsed: unknown = JSON.parse(text)
            if (isRecord(parsed)) return parsed
          } catch {
            // Treated as empty below.
          }
          this.log('warn', `The storage of ${pluginId} is not JSON; it starts empty`)
          return {}
        },
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') {
            this.log('warn', `Could not read the storage of ${pluginId}: ${error.message}`)
          }
          return {}
        },
      )
      this.loaded.set(pluginId, held)
    }
    return held
  }

  /** Changes run one at a time per plugin, so none is lost to another. */
  private write(pluginId: string, change: (entries: Entries) => Entries): Promise<null> {
    const run = async (): Promise<null> => {
      const next = change(await this.read(pluginId))
      const file = this.file(pluginId)
      // The folder is the plugin's own: a write after it was removed fails instead of making it.
      await writeFile(`${file}.tmp`, JSON.stringify(next))
      await rename(`${file}.tmp`, file)
      this.loaded.set(pluginId, Promise.resolve(next))
      return null
    }
    const queued = (this.queues.get(pluginId) ?? Promise.resolve()).then(run, run)
    this.queues.set(
      pluginId,
      queued.catch(() => undefined),
    )
    return queued
  }
}
