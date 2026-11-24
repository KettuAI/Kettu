// The index of the themes the plugins that are on bring. Main, or the daemon, reads it with the
// theme files it names, so the themes show from the first frame and follow the plugins.

import { readFile } from 'node:fs/promises'
import {
  PLUGIN_THEMES_VERSION,
  pluginThemeEntries,
  type PluginThemeEntry,
} from '@shared/plugin-themes'
import type { PluginResource } from '@shared/plugins'
import { writeFileAtomic, type LogFn } from '../storage'

export interface PluginThemeIndexDeps {
  /** `plugin-themes.json` in the data folder. */
  file: string
  /** The themes of the plugins that are on. */
  resources(): Promise<PluginResource[]>
  /** The file changed, so whoever reads it should read it again. */
  changed(): void
  log: LogFn
}

export class PluginThemeIndex {
  // What the file holds as this run left it; null until read.
  private written: string | null = null
  // Writes run one at a time, so a late one never lands before an earlier one.
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly deps: PluginThemeIndexDeps) {}

  /** Writes the index as the plugins stand now, and says so only when the file changed. */
  sync(): Promise<void> {
    this.queue = this.queue
      .then(() => this.write())
      .catch((error: unknown) => {
        this.deps.log(
          'warn',
          `Could not write the index of plugin themes: ${(error as Error).message}`,
        )
      })
    return this.queue
  }

  private async write(): Promise<void> {
    const themes: PluginThemeEntry[] = pluginThemeEntries(await this.deps.resources())
    const text = `${JSON.stringify({ version: PLUGIN_THEMES_VERSION, themes }, null, 2)}\n`
    this.written ??= await readFile(this.deps.file, 'utf8').catch(() => '')
    if (text === this.written) return
    await writeFileAtomic(this.deps.file, text)
    this.written = text
    this.deps.changed()
  }
}
