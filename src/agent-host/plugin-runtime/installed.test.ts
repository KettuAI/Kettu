import { describe, expect, it } from 'vitest'
import type { PluginScript } from '@shared/plugin-host'
import { InstalledScripts, type InstalledScript } from './installed'

function registry() {
  const calls: string[] = []
  const known = new Map<string, PluginScript>()
  return {
    calls,
    known,
    register(plugin: PluginScript, permissions: readonly string[]) {
      calls.push(`register ${plugin.id} ${permissions.join(',')}`.trim())
      known.set(plugin.id, plugin)
    },
    async unregister(pluginId: string) {
      calls.push(`unregister ${pluginId}`)
      known.delete(pluginId)
    },
  }
}

const script = (id: string, revision = '1', permissions: string[] = []): InstalledScript => ({
  id,
  scriptPath: `/plugins/${id}/main.js`,
  activation: [],
  revision,
  permissions,
})

/** Waits for the queued syncs to apply. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('InstalledScripts', () => {
  it('unregisters a plugin that is turned off or removed', async () => {
    const client = registry()
    const scripts = new InstalledScripts(client, () => {})
    scripts.sync([script('a'), script('b')])
    scripts.sync([script('b')])
    await settle()
    expect([...client.known.keys()]).toEqual(['b'])
    expect(client.calls).toEqual(['register a', 'register b', 'unregister a'])
  })

  it('unloads the old version before registering a replaced package', async () => {
    const client = registry()
    const scripts = new InstalledScripts(client, () => {})
    scripts.sync([script('a', '1')])
    scripts.sync([script('a', '1')])
    scripts.sync([script('a', '2')])
    await settle()
    expect(client.calls).toEqual(['register a', 'unregister a', 'register a'])
  })

  it('forgets a plugin whose unload failed, so it registers again', async () => {
    const client = registry()
    const failed: string[] = []
    client.unregister = async (pluginId: string) => {
      client.calls.push(`unregister ${pluginId}`)
      throw new Error('gone')
    }
    const scripts = new InstalledScripts(client, (pluginId) => failed.push(pluginId))
    scripts.sync([script('a', '1')])
    scripts.sync([script('a', '2')])
    await settle()
    expect(failed).toEqual(['a'])
    expect(client.calls).toEqual(['register a', 'unregister a', 'register a'])
  })

  it('hands the client the permissions of the version in place, and the new ones with a new package', async () => {
    const client = registry()
    const scripts = new InstalledScripts(client, () => {})
    scripts.sync([script('a', '1', ['tools'])])
    scripts.sync([script('a', '2', ['tools', 'sessions.start'])])
    await settle()
    expect(client.calls).toEqual([
      'register a tools',
      'unregister a',
      'register a tools,sessions.start',
    ])
  })
})
