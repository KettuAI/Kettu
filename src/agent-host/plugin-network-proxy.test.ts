import { mkdir, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import { startTestHost, type TestHost } from './testing/harness'
import { tempFolder } from './testing/temp'

vi.setConfig({ testTimeout: 60_000 })

const SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
const TARGET_HOST = 'api.proxy-only.invalid'

const SCRIPT = `
kettu.on('action.run', async ({ action }) => {
  const urls = {
    allowed: 'https://${TARGET_HOST}/v1/ping',
    undeclared: 'https://evil.example.net/v1/ping',
    loopback: 'https://127.0.0.1/admin',
    internal: 'https://metadata.google.internal/computeMetadata/v1/',
  }
  try {
    const res = await kettu.call('network.fetch', urls[action])
    return { notice: 'status ' + res.status }
  } catch (error) {
    return { error: error && error.message ? error.message : String(error) }
  }
})
`

async function writePlugin(dir: string): Promise<string> {
  const folder = path.join(dir, 'proxy-probe')
  await mkdir(path.join(folder, 'sh.kettu'), { recursive: true })
  await writeFile(
    path.join(folder, 'plugin.json'),
    JSON.stringify({
      $schema: SCHEMA,
      name: 'proxy-probe',
      version: '1.0.0',
      extensions: {
        'sh.kettu': {
          format: 1,
          script: './sh.kettu/main.js',
          api: 1,
          permissions: [`network:${TARGET_HOST}`, 'network:metadata.google.internal'],
          actions: [
            { id: 'allowed', title: { en: 'Allowed' } },
            { id: 'undeclared', title: { en: 'Undeclared' } },
            { id: 'loopback', title: { en: 'Loopback' } },
            { id: 'internal', title: { en: 'Internal' } },
          ],
        },
      },
    }),
  )
  await writeFile(path.join(folder, 'sh.kettu', 'main.js'), SCRIPT)
  return folder
}

function baseHostSettings(): HostSettings {
  return {
    locale: 'en',
    agents: { 'fake-agent': { enabled: true } },
    addedAgents: DEFAULT_SETTINGS.addedAgents,
    disabledAgents: DEFAULT_SETTINGS.disabledAgents,
    proxy: DEFAULT_SETTINGS.proxy,
    git: DEFAULT_SETTINGS.git,
    mcp: DEFAULT_SETTINGS.mcp,
    marketplace: DEFAULT_SETTINGS.marketplace,
    startModes: DEFAULT_SETTINGS.startModes,
    idleSessions: DEFAULT_SETTINGS.idleSessions,
    workflow: DEFAULT_SETTINGS.workflow,
    startedSessions: DEFAULT_SETTINGS.startedSessions,
    usage: { fromComputer: false },
    sessionTitles: true,
    promptSuggestions: true,
    continueAfterLimit: true,
    agentPasswords: false,
    lightModel: { mode: 'small' },
    initialSetupDone: true,
    defaultAgent: null,
    computerUse: DEFAULT_SETTINGS.computerUse,
    downloadService: false,
  }
}

describe('plugin network.fetch proxy wiring in AgentHost', () => {
  const hosts: TestHost[] = []
  const servers: Server[] = []
  const sockets = new Set<Duplex>()

  afterEach(async () => {
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    await Promise.all(
      servers
        .splice(0)
        .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    )
    for (const host of hosts.splice(0)) await host.stop()
  })

  async function startRefusingProxy(): Promise<{ url: string; tunnels: string[] }> {
    const tunnels: string[] = []
    const server = createServer((_req, res) => {
      res.writeHead(405)
      res.end()
    })
    server.on('connect', (req: IncomingMessage, socket: Duplex) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      tunnels.push(req.url ?? '')
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    return { url: `http://127.0.0.1:${port}`, tunnels }
  }

  it('uses the environment proxy, applies live Settings › Advanced updates, honors NO_PROXY, and guards hosts', async () => {
    const envProxy = await startRefusingProxy()
    const customProxy = await startRefusingProxy()
    const settings = baseHostSettings()
    const testHost = await startTestHost({
      pluginHost: true,
      settings,
      agentEnv: { HTTPS_PROXY: envProxy.url, https_proxy: envProxy.url },
    })
    hosts.push(testHost)

    const window = testHost.connect()
    const folder = await writePlugin(await tempFolder('kettu-plugin-proxy-'))
    const plan = await window.request('plugins.inspect', {
      source: { kind: 'local', path: folder },
    })
    const { id: pluginId } = await window.request('plugins.install', { token: plan.token })

    const runError = async (actionId: string): Promise<string> => {
      const answer = await window.request('plugins.actionRun', { pluginId, actionId })
      expect(answer.ok, actionId).toBe(false)
      return answer.ok ? '' : (answer.error.detail ?? answer.error.code)
    }

    // 1. Uses the environment proxy initially.
    expect(await runError('allowed')).toMatch(/tunnel|403/i)
    expect(envProxy.tunnels).toEqual([`${TARGET_HOST}:443`])
    expect(customProxy.tunnels).toEqual([])

    // 2. Live Settings › Advanced proxy update takes effect immediately for the next call.
    await testHost.host.updateSettings({
      ...settings,
      proxy: { mode: 'custom', url: customProxy.url, noProxy: '' },
    })
    expect(await runError('allowed')).toMatch(/tunnel|403/i)
    expect(envProxy.tunnels).toEqual([`${TARGET_HOST}:443`])
    expect(customProxy.tunnels).toEqual([`${TARGET_HOST}:443`])

    // 3. Undeclared domains, loopback IPs, and internal hosts never reach the proxy.
    for (const actionId of ['undeclared', 'loopback', 'internal']) {
      expect(await runError(actionId), actionId).toBeTruthy()
    }
    expect(customProxy.tunnels).toEqual([`${TARGET_HOST}:443`])

    // 4. Adding the target host to NO_PROXY bypasses the proxy completely.
    await testHost.host.updateSettings({
      ...settings,
      proxy: { mode: 'custom', url: customProxy.url, noProxy: TARGET_HOST },
    })
    const bypassed = await runError('allowed')
    expect(bypassed).toBeTruthy()
    expect(bypassed).not.toMatch(/tunnel/i)
    expect(customProxy.tunnels).toEqual([`${TARGET_HOST}:443`])
  })
})
