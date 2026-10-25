import { join } from 'node:path'
import type { SettingsFile } from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { JsonFileWriter, quarantineFile, readJsonFile } from './json-file'
import { createLogger } from './log'
import {
  changedSections,
  mergeSettings,
  parseSettingsFile,
  SETTINGS_VERSION,
  type SettingsSection,
  validateSettingsPatch,
  withAgentBinary,
  withAgentConfigDir,
  withShellPath,
} from './settings-schema'

const log = createLogger('settings')

export type SettingsListener = (settings: SettingsFile, changed: Set<SettingsSection>) => void

/** Owns settings.json: read once at startup, validated on every change, written atomically. */
export class SettingsStore {
  private readonly listeners = new Set<SettingsListener>()

  private constructor(
    private current: SettingsFile,
    private readonly writer: JsonFileWriter | null,
  ) {}

  static async load(userDataPath: string): Promise<SettingsStore> {
    const path = join(userDataPath, 'settings.json')
    const read = await readJsonFile(path)
    if (read.kind === 'missing') {
      return new SettingsStore(parseSettingsFile({ version: SETTINGS_VERSION }).settings, writer())
    }
    const loaded =
      read.kind === 'ok'
        ? parseSettingsFile(read.value)
        : { ...parseSettingsFile(null), problems: [read.reason], readOnly: false }
    if (loaded.readOnly) {
      log.warn('settings.json comes from a newer version; changes this run are not saved')
      return new SettingsStore(loaded.settings, null)
    }
    const store = new SettingsStore(loaded.settings, writer())
    if (loaded.problems.length > 0) {
      log.warn(`settings.json is invalid: ${loaded.problems.join('; ')}`)
      try {
        log.warn(`Moved the invalid file to ${await quarantineFile(path)}`)
      } catch (error) {
        log.error('Could not move the invalid settings.json aside', error)
        return new SettingsStore(loaded.settings, null)
      }
      store.save()
    }
    return store

    function writer(): JsonFileWriter {
      return new JsonFileWriter(path, log)
    }
  }

  get(): SettingsFile {
    return this.current
  }

  /** Applies a patch from the renderer; throws a `SettingsError` and changes nothing if invalid. */
  update(patch: unknown): SettingsFile {
    return this.replace(mergeSettings(this.current, validateSettingsPatch(patch)))
  }

  setAgentBinary(agentId: AgentId, binaryPath: string): SettingsFile {
    return this.replace(withAgentBinary(this.current, agentId, binaryPath))
  }

  setAgentConfigDir(agentId: AgentId, configDir: string): SettingsFile {
    return this.replace(withAgentConfigDir(this.current, agentId, configDir))
  }

  setShellPath(shellPath: string): SettingsFile {
    return this.replace(withShellPath(this.current, shellPath))
  }

  onChange(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  flush(): Promise<void> {
    return this.writer?.flush() ?? Promise.resolve()
  }

  private replace(next: SettingsFile): SettingsFile {
    const changed = changedSections(this.current, next)
    if (changed.size === 0) return this.current
    this.current = next
    this.save()
    for (const listener of this.listeners) {
      try {
        listener(next, changed)
      } catch (error) {
        log.error('A settings listener failed', error)
      }
    }
    return next
  }

  private save(): void {
    this.writer?.schedule(this.current)
  }
}
