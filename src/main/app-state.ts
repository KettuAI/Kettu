import { join } from 'node:path'
import { JsonFileWriter, quarantineFile, readJsonFile } from './json-file'
import { createLogger } from './log'
import type { SignedSourceList } from './update-sources'

const log = createLogger('app-state')

export interface AppState {
  lastRunVersion: string | null // the version that ran last, to tell a launch after an update
  dismissedUpdate: string | null // the version whose update notice was dismissed
  updateAfterMove: string | null // the version Update moved the app to /Applications for
  notifiedUpdate: string | null // the version the island or a notification announced, once
  updateSources: SignedSourceList | null // the latest source list, checked again when read
  askedClients: string[] // the account's clients already asked about turning remote access on for
}

interface AppStateFile extends AppState {
  version: 1
}

function signedList(value: unknown): SignedSourceList | null {
  if (typeof value !== 'object' || value === null) return null
  const { payload, signature } = value as Record<string, unknown>
  return typeof payload === 'string' && typeof signature === 'string'
    ? { payload, signature }
    : null
}

function parseAppState(raw: unknown): AppState | null {
  if (typeof raw !== 'object' || raw === null) return null
  // Files written before updateAfterMove, updateSources or notifiedUpdate existed lack them.
  const {
    version,
    lastRunVersion,
    dismissedUpdate,
    updateAfterMove = null,
    updateSources = null,
    notifiedUpdate = null,
    askedClients = [],
  } = raw as Record<string, unknown>
  const optionalString = (value: unknown): value is string | null =>
    value === null || (typeof value === 'string' && value.length <= 256)
  if (
    version !== 1 ||
    !optionalString(lastRunVersion) ||
    !optionalString(dismissedUpdate) ||
    !optionalString(updateAfterMove) ||
    !optionalString(notifiedUpdate)
  ) {
    return null
  }
  // A kept list that no longer reads is only dropped: the next check fetches it again.
  return {
    lastRunVersion,
    dismissedUpdate,
    updateAfterMove,
    updateSources: signedList(updateSources),
    notifiedUpdate,
    askedClients: clientIds(askedClients),
  }
}

/** The most clients kept as asked about, the newest kept. */
const MAX_ASKED = 200

function clientIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 128)
    .slice(-MAX_ASKED)
}

/** Owns app-state.json: small facts main remembers between launches. */
export class AppStateStore {
  private constructor(
    private state: AppState,
    private readonly writer: JsonFileWriter,
  ) {}

  static async load(userDataPath: string): Promise<AppStateStore> {
    const path = join(userDataPath, 'app-state.json')
    const empty: AppState = {
      lastRunVersion: null,
      dismissedUpdate: null,
      updateAfterMove: null,
      updateSources: null,
      notifiedUpdate: null,
      askedClients: [],
    }
    const read = await readJsonFile(path)
    let state = empty
    if (read.kind === 'ok') state = parseAppState(read.value) ?? empty
    if (read.kind === 'unreadable' || (read.kind === 'ok' && state === empty)) {
      log.warn(`app-state.json is invalid${read.kind === 'unreadable' ? `: ${read.reason}` : ''}`)
      try {
        log.warn(`Moved the invalid file to ${await quarantineFile(path)}`)
      } catch (error) {
        log.error('Could not move the invalid app-state.json aside', error)
      }
    }
    return new AppStateStore(state, new JsonFileWriter(path, log))
  }

  get(): AppState {
    return this.state
  }

  update(changes: Partial<AppState>): void {
    const next = { ...this.state, ...changes }
    if (
      next.lastRunVersion === this.state.lastRunVersion &&
      next.dismissedUpdate === this.state.dismissedUpdate &&
      next.updateAfterMove === this.state.updateAfterMove &&
      next.updateSources === this.state.updateSources &&
      next.notifiedUpdate === this.state.notifiedUpdate &&
      next.askedClients === this.state.askedClients
    ) {
      return
    }
    this.state = { ...next, askedClients: next.askedClients.slice(-MAX_ASKED) }
    const file: AppStateFile = { version: 1, ...this.state }
    this.writer.schedule(file)
  }

  flush(): Promise<void> {
    return this.writer.flush()
  }
}
