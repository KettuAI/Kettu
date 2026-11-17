// A session's model scope, for an agent that runs Kettu's extension (Pi): pi-acp lists every model
// of every signed-in provider, while Pi's own menu shows only the models scoped with
// `/scoped-models`. The extension writes Pi's resolved scope into a file the host names for the
// session, and the session's model menu keeps only those models.

import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ConfigOption } from '@shared/thread'

// The agent writes the file, so what it holds is bounded and can only narrow the menu.
const MAX_BYTES = 1024 * 1024
const MAX_MODELS = 10_000

/** A connection's scope files, in a temporary folder of its own that only its user reads. */
export class ScopeFiles {
  private folder: Promise<string> | null = null

  /** A new file for a session's scope. */
  async next(): Promise<string> {
    this.folder ??= mkdtemp(path.join(os.tmpdir(), 'kettu-model-scope-'))
    let dir: string
    try {
      dir = await this.folder
    } catch (error) {
      this.folder = null
      throw error
    }
    // The system may have cleared the temporary folder since.
    await mkdir(dir, { recursive: true, mode: 0o700 })
    return path.join(dir, `${randomUUID()}.json`)
  }

  /** Removes the folder, with any file a session that never answered left in it. */
  close(): void {
    const folder = this.folder
    this.folder = null
    void folder?.then((dir) => rm(dir, { recursive: true, force: true })).catch(() => {})
  }
}

/** Removes a scope file the host no longer reads. */
export async function dropScopeFile(file: string): Promise<void> {
  await rm(file, { force: true }).catch(() => {})
}

/**
 * The model values the scope `file` holds, which it removes; null when it holds none, as when the
 * agent has no scope or wrote nothing.
 */
export async function takeScope(file: string): Promise<ReadonlySet<string> | null> {
  try {
    if ((await stat(file)).size > MAX_BYTES) return null
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    const models =
      typeof parsed === 'object' && parsed !== null ? (parsed as { models?: unknown }).models : null
    if (!Array.isArray(models)) return null
    const scope = new Set(
      models.filter((model): model is string => typeof model === 'string').slice(0, MAX_MODELS),
    )
    return scope.size > 0 ? scope : null
  } catch {
    return null
  } finally {
    await dropScopeFile(file)
  }
}

/** `config` with the model option's choices narrowed to `scope`, its current model kept. */
export function withinScope(
  config: ConfigOption[],
  scope: ReadonlySet<string> | undefined,
): ConfigOption[] {
  if (!scope) return config
  return config.map((option) => {
    if (option.category !== 'model' || option.type !== 'select' || !option.choices) return option
    const choices = option.choices.filter(
      (choice) => scope.has(choice.value) || choice.value === option.value,
    )
    return choices.length === option.choices.length ? option : { ...option, choices }
  })
}
