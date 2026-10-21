import { join } from 'node:path'
import { JsonFileWriter, quarantineFile, readJsonFile } from './json-file'
import { createLogger } from './log'

const log = createLogger('app-state')

export interface AppState {
  lastRunVersion: string | null // the version that ran last, to tell a launch after an update
  dismissedUpdate: string | null // the version whose update notice was dismissed
}

interface AppStateFile extends AppState {
  version: 1
}

function parseAppState(raw: unknown): AppState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { version, lastRunVersion, dismissedUpdate } = raw as Record<string, unknown>
  const optionalString = (value: unknown): value is string | null =>
    value === null || (typeof value === 'string' && value.length <= 256)
  if (version !== 1 || !optionalString(lastRunVersion) || !optionalString(dismissedUpdate)) {
    return null
  }
  return { lastRunVersion, dismissedUpdate }
}

/** Owns app-state.json: small facts main remembers between launches. */
export class AppStateStore {
  private constructor(
    private state: AppState,
    private readonly writer: JsonFileWriter,
  ) {}

  static async load(userDataPath: string): Promise<AppStateStore> {
    const path = join(userDataPath, 'app-state.json')
    const empty: AppState = { lastRunVersion: null, dismissedUpdate: null }
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
      next.dismissedUpdate === this.state.dismissedUpdate
    ) {
      return
    }
    this.state = next
    const file: AppStateFile = { version: 1, ...next }
    this.writer.schedule(file)
  }

  flush(): Promise<void> {
    return this.writer.flush()
  }
}
