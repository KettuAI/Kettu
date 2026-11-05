import { randomInt } from 'node:crypto'
import { join } from 'node:path'
import type { AddedAgent, SettingsFile } from '@shared/settings'
import { HARNESS_IDS, isHarnessId, type AgentId, type HarnessId } from '@shared/thread'
import { parseSessionsFile, parseRoutinesFile } from '../agent-host/storage'
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
  withAgentColor,
  withDirectPort,
  withMovedAgent,
  withoutAgent,
  withRenamedAgent,
  withAllowedComputerApp,
  withShellPath,
} from './settings-schema'

const log = createLogger('settings')

/** A port from the dynamic range, which no service registers, for direct connections. */
function randomDirectPort(): number {
  return randomInt(49152, 65536)
}

export type SettingsListener = (settings: SettingsFile, changed: Set<SettingsSection>) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads only Kettu's indexes; a failed read must never erase evidence of an agent's use. */
async function migrateAgentRegistration(
  settings: SettingsFile,
  userDataPath: string,
): Promise<void> {
  const used = new Set<HarnessId>()
  const keep = (id: AgentId | null): void => {
    if (isHarnessId(id)) used.add(id)
  }
  keep(settings.general.defaultAgent)
  settings.mcp.kettu.off.forEach(keep)
  for (const id of HARNESS_IDS) {
    if (settings.agents[id]?.configDir) used.add(id)
  }
  const readIndex = async (name: string): Promise<Record<string, unknown> | null> => {
    const file = join(userDataPath, 'state', name)
    const read = await readJsonFile(file)
    if (read.kind === 'missing') return null
    if (read.kind !== 'ok')
      throw new Error(`Cannot migrate agent registration: ${file}: ${read.reason}`)
    if (!isRecord(read.value) || read.value.version !== 1) {
      throw new Error(`Cannot migrate agent registration: ${file}: unsupported or malformed index`)
    }
    return read.value
  }
  for (const [name, parse] of [
    ['sessions.json', parseSessionsFile],
    ['routines.json', parseRoutinesFile],
  ] as const) {
    const raw = await readIndex(name)
    if (!raw) continue
    const parsed = parse(raw)
    if (typeof parsed === 'string')
      throw new Error(`Cannot migrate agent registration: ${name}: ${parsed}`)
    const records = 'sessions' in parsed ? parsed.sessions : parsed.routines
    records.forEach((record) => keep(record.agentId))
  }
  const options = await readIndex('agent-options.json')
  if (options) {
    if (!isRecord(options.agents))
      throw new Error(
        'Cannot migrate agent registration: agent-options.json: agents is not an object',
      )
    for (const [id, entry] of Object.entries(options.agents)) {
      if (!isRecord(entry))
        throw new Error(
          `Cannot migrate agent registration: agent-options.json: malformed entry ${id}`,
        )
      if (entry.remembered !== undefined && !isRecord(entry.remembered)) {
        throw new Error(
          `Cannot migrate agent registration: agent-options.json: malformed remembered options ${id}`,
        )
      }
      if (isHarnessId(id) && isRecord(entry.remembered) && Object.keys(entry.remembered).length > 0)
        used.add(id)
    }
  }
  for (const id of HARNESS_IDS) {
    const entry = settings.agents[id]
    if (entry?.enabled !== undefined) continue
    // Hiding belonged to the old always-registered default; an agent is now removed instead.
    if (entry) delete entry.hidden
    if (used.has(id)) settings.agents[id] = { ...entry, enabled: true }
    else if (entry && Object.keys(entry).length === 0) delete settings.agents[id]
  }
  settings.agentRegistrationVersion = 1
}

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
    const savedMarker =
      read.kind === 'ok' && isRecord(read.value) ? read.value.agentRegistrationVersion : undefined
    // An unreadable file still has history to go on; one from a newer build is never rewritten.
    const needsRegistration = !loaded.readOnly && savedMarker === undefined
    if (needsRegistration) {
      try {
        await migrateAgentRegistration(settings, userDataPath)
      } catch (error) {
        // Keeping every harness is the safe side: an unreadable index must not drop a used agent.
        log.error('Could not read the history to register agents; keeping all harnesses', error)
        for (const id of HARNESS_IDS) {
          settings.agents[id] = { ...settings.agents[id], enabled: true }
        }
        settings.agentRegistrationVersion = 1
      }
    }
    // The Agents page no longer has a control for this, so a stored true would keep the account,
    // sharing and git names masked with no way to show them.
    const clearedHide = settings.privacy.hideAccount
    if (clearedHide) settings.privacy.hideAccount = false
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
    } else if (settings !== loaded.settings || needsRegistration || clearedHide) {
      store.save()
    }
    if (needsRegistration) await store.flush()
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

  colorAgent(agentId: unknown, color: unknown): SettingsFile {
    return this.replace(withAgentColor(this.current, agentId, color))
  }

  removeAgent(agentId: AgentId): SettingsFile {
    return this.replace(withoutAgent(this.current, agentId))
  }

  moveAgent(agentId: AgentId, configDir: string): SettingsFile {
    return this.replace(withMovedAgent(this.current, agentId, configDir))
  }

  setShellPath(shellPath: string): SettingsFile {
    return this.replace(withShellPath(this.current, shellPath))
  }

  /** A session's card allowed an app always. */
  allowComputerApp(app: unknown): SettingsFile {
    return this.replace(withAllowedComputerApp(this.current, app))
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
