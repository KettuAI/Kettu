// Keeps the plugin host's client in step with the installed plugins: a plugin that is on and has
// a script is registered, and one turned off, removed or replaced by another version is
// unregistered first, which unloads its script.

import type { PluginScript } from '@shared/plugin-host'

export interface InstalledScript extends PluginScript {
  /** Changes whenever the package in place does, also when it is read again from one folder. */
  revision: string
  /** What the version in place declares: all the plugin may do, held updates not counted. */
  permissions: string[]
}

interface ScriptRegistry {
  register(plugin: PluginScript, permissions: readonly string[]): void
  unregister(pluginId: string): Promise<void>
}

export class InstalledScripts {
  private readonly registered = new Map<string, string>()
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly client: ScriptRegistry,
    private readonly failed: (pluginId: string, error: unknown) => void,
  ) {}

  /** Takes the scripts of the plugins that are on now; one sync runs at a time, in order. */
  sync(scripts: InstalledScript[]): void {
    this.queue = this.queue.then(() => this.apply(scripts))
  }

  private async apply(scripts: InstalledScript[]): Promise<void> {
    const wanted = new Map(scripts.map((script) => [script.id, script]))
    for (const [id, revision] of [...this.registered]) {
      if (wanted.get(id)?.revision === revision) continue
      this.registered.delete(id)
      await this.client.unregister(id).catch((error: unknown) => this.failed(id, error))
    }
    for (const { revision, permissions, ...script } of wanted.values()) {
      if (this.registered.has(script.id)) continue
      this.client.register(script, permissions)
      this.registered.set(script.id, revision)
    }
  }
}
