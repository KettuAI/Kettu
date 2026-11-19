// Claude Code names the commands that work only in its own terminal in the init a turn starts with,
// never when a session opens. What a turn named is kept for that Claude Code version, so a session,
// New session's prepared one included, lists without them before its own first turn too.

import path from 'node:path'
import { JsonFile, type LogFn } from '../storage'

export interface TerminalCommandsFile {
  version: 1
  /** The Claude Code version whose turn named them; null before any turn. */
  claude: string | null
  names: string[]
}

const empty = (): TerminalCommandsFile => ({ version: 1, claude: null, names: [] })

export function parseTerminalCommands(
  data: Record<string, unknown>,
): TerminalCommandsFile | string {
  const { claude, names } = data
  if (claude !== null && typeof claude !== 'string') return 'claude is not a string or null'
  if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) {
    return 'names is not a list of strings'
  }
  return { version: 1, claude, names: names as string[] }
}

export class TerminalCommands {
  private known = empty()
  private readonly file: JsonFile<TerminalCommandsFile> | null

  /** Kept in `dir` when there is one, else for this run only. */
  constructor(
    dir: string | undefined,
    private readonly log: LogFn,
  ) {
    this.file = dir
      ? new JsonFile({
          file: path.join(dir, 'terminal-commands.json'),
          version: 1,
          migrations: {},
          parse: parseTerminalCommands,
          empty,
          log,
        })
      : null
  }

  /** Reads what an earlier run kept; never rejects. */
  async load(): Promise<void> {
    if (!this.file) return
    try {
      const data = await this.file.load()
      // A turn that named them while the file was read knows better.
      if (this.known.claude === null) this.known = data
    } catch (error) {
      this.log('warn', `Could not read Claude Code's terminal-only commands: ${String(error)}`)
    }
  }

  /** What a turn of Claude Code `version` named; null when none of that version has run. */
  namesFor(version: string | undefined): ReadonlySet<string> | null {
    return version !== undefined && this.known.claude === version ? new Set(this.known.names) : null
  }

  /** Keeps what a turn of Claude Code `version` named, writing only a change. */
  remember(version: string, names: Iterable<string>): void {
    const sorted = [...new Set(names)].sort()
    const { claude, names: before } = this.known
    if (
      claude === version &&
      before.length === sorted.length &&
      before.every((n, i) => n === sorted[i])
    ) {
      return
    }
    this.known = { version: 1, claude: version, names: sorted }
    this.file?.save(this.known)
  }

  flush(): Promise<void> {
    return this.file?.flush() ?? Promise.resolve()
  }
}
