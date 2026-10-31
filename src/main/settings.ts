import { randomInt } from 'node:crypto'
import { join } from 'node:path'
import type { AddedAgent, SettingsFile } from '@shared/settings'
import type { AgentId, HarnessId } from '@shared/thread'
import { JsonFileWriter, quarantineFile, readJsonFile } from './json-file'
import { createLogger } from './log'
import {
  changedSections,
  mergeSettings,
  parseSettingsFile,
  SETTINGS_VERSION,
  type SettingsSection,
  validateSettingsPatch,
  withAddedAgent,
  withAgentBinary,
  withDirectPort,
  withoutAgent,
  withRenamedAgent,
  withShellPath,
} from './settings-schema'

const log = createLogger('settings')

/** A port from the dynamic range, which no service registers, for direct connections. */
function randomDirectPort(): number {
  return randomInt(49152, 65536)
}

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
    // A file that turns direct connections on by hand gets its port as a change would.
    const settings = withDirectPort(loaded.settings, randomDirectPort)
    if (loaded.readOnly) {
      log.warn('settings.json comes from a newer version; changes this run are not saved')
      return new SettingsStore(settings, null)
    }
    const store = new SettingsStore(settings, writer())
    if (loaded.problems.length > 0) {
      log.warn(`settings.json is invalid: ${loaded.problems.join('; ')}`)
      try {
        log.warn(`Moved the invalid file to ${await quarantineFile(path)}`)
      } catch (error) {
        log.error('Could not move the invalid settings.json aside', error)
        return new SettingsStore(settings, null)
      }
      store.save()
    } else if (settings !== loaded.settings) {
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
    const merged = mergeSettings(this.current, validateSettingsPatch(patch))
    return this.replace(withDirectPort(merged, randomDirectPort))
  }

  setAgentBinary(harnessId: HarnessId, binaryPath: string): SettingsFile {
    return this.replace(withAgentBinary(this.current, harnessId, binaryPath))
  }

  addAgent(agent: AddedAgent): SettingsFile {
    return this.replace(withAddedAgent(this.current, agent))
  }

  renameAgent(agentId: AgentId, name: string): SettingsFile {
    return this.replace(withRenamedAgent(this.current, agentId, name))
  }

  removeAgent(agentId: AgentId): SettingsFile {
    return this.replace(withoutAgent(this.current, agentId))
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
