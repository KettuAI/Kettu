// End-to-end version check coverage across harnesses: standalone/script official endpoints
// (Antigravity, Grok, OMP, Claude Code, OpenCode), npm/brew harnesses, registry-backed harnesses
// replaced by user binaries, and uncheckable harnesses that must never fabricate an up-to-date badge.

import { chmod, mkdir, realpath, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type HostSettings } from '@shared/settings'
import type { LatestOptions, ProgramLatestOptions } from './agent-updates'
import { AgentManager } from './agents'
import { ANTIGRAVITY } from './agents/antigravity'
import { CLAUDE_CODE } from './agents/claude-code'
import { CODEX } from './agents/codex'
import { COPILOT } from './agents/copilot'
import { CURSOR } from './agents/cursor'
import { GROK } from './agents/grok'
import { HERMES } from './agents/hermes'
import { KILO } from './agents/kilo'
import { OMP } from './agents/omp'
import { OPENCODE } from './agents/opencode'
import { PI } from './agents/pi'
import type { AgentDefinition } from './catalog'
import { Diagnostics } from './diagnostics'
import { parseRegistry } from './registry'
import { EnvironmentService } from './shell-env'
import { tempFolder } from './testing/temp'

const PLATFORM = process.platform === 'win32' ? 'win32' : process.platform

interface HarnessSetup {
  def: AgentDefinition
  /** Relative folder under the temporary home directory where the binary lives. */
  relDir: string
  command: string
  installedVersion: string
  /** Latest version returned by HTTP official version check (throws when null). */
  httpLatest?: string | null
  /** Latest version returned by npm view (throws when null). */
  npmLatest?: string | null
  /** Whether npm is present on the machine. */
  hasNpm?: boolean
  /** Whether the ACP Registry listing succeeds during checkUpdates. */
  registryVersion?: string | null
  /** Pre-create an installed package adapter version under adaptersDir (for SDK harnesses like Claude Code). */
  installedAdapterVersion?: string
}

async function createHarnessManager(setup: HarnessSetup) {
  const home = await realpath(await tempFolder('kettu-harness-ver-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  const binDir = path.join(home, setup.relDir)
  await mkdir(binDir, { recursive: true })
  const program = path.join(binDir, setup.command)
  await writeFile(program, '#!/bin/sh\nexit 0\n')
  await chmod(program, 0o755)
  const adaptersDir = path.join(home, 'harnesses')
  if (setup.installedAdapterVersion && setup.def.launch.kind === 'package') {
    const dir = path.join(adaptersDir, setup.def.id, setup.installedAdapterVersion)
    const pkgDir = path.join(dir, 'node_modules', ...setup.def.launch.package.split('/'))
    await mkdir(pkgDir, { recursive: true })
    await writeFile(path.join(pkgDir, 'package.json'), JSON.stringify({ main: 'index.js' }))
    await writeFile(path.join(pkgDir, 'index.js'), 'export {}')
    await writeFile(
      path.join(dir, 'installed.json'),
      JSON.stringify({
        package: setup.def.launch.package,
        version: setup.installedAdapterVersion,
        node: null,
        npm: null,
        installedAt: Date.now(),
      }),
    )
  }

  let currentVersion = setup.installedVersion
  let httpLatest = setup.httpLatest ?? null
  let npmLatest = setup.npmLatest ?? null
  const httpAsked: ProgramLatestOptions[] = []
  const npmAsked: LatestOptions[] = []
  const nodeRuntime = { command: process.execPath, env: {} }
  const settings: HostSettings = {
    ...DEFAULT_SETTINGS,
    locale: 'en',
    initialSetupDone: true,
    agents: { [setup.def.id]: { enabled: true } },
    addedAgents: [],
    disabledAgents: [],
    usage: { fromComputer: false },
    sessionTitles: true,
    promptSuggestions: true,
    continueAfterLimit: true,
    agentPasswords: false,
    lightModel: { mode: 'small' },
    defaultAgent: null,
    downloadService: false,
  }

  const agents = new AgentManager({
    catalog: [setup.def],
    platform: PLATFORM,
    nodeRuntime,
    appVersion: '0.1.29',
    env: new EnvironmentService({
      platform: PLATFORM,
      nodeRuntime,
      baseEnv: { PATH: binDir, HOME: home },
      resolve: async ({ baseEnv }) => ({
        env: baseEnv,
        source: 'inherited',
        shell: null,
        durationMs: 0,
        warning: null,
      }),
      probe: async () => ({
        nodeVersion: setup.hasNpm === false ? null : '24.11.0',
        npmPath: setup.hasNpm === false ? null : path.join(home, 'npm'),
        nodePath: setup.hasNpm === false ? null : path.join(home, 'node'),
      }),
    }),
    diagnostics: new Diagnostics(),
    launcher: {
      launch: () => {
        throw new Error('test starts nothing')
      },
    },
    settings: () => settings,
    reportsDir: path.join(home, 'reports'),
    adaptersDir,
    probeCli: async () => ({ version: currentVersion }),
    fetchRegistry: async () => {
      if (setup.registryVersion) {
        return parseRegistry({
          agents: [
            {
              id: setup.def.registryId,
              version: setup.registryVersion,
              distribution:
                setup.def.launch.kind === 'package'
                  ? { npx: { package: `${setup.def.launch.package}@${setup.registryVersion}` } }
                  : {},
            },
          ],
        })!
      }
      return parseRegistry({ agents: [] })!
    },
    fetchProgramLatest: async (options) => {
      httpAsked.push(options)
      if (!httpLatest) throw new Error('offline')
      return httpLatest
    },
    fetchLatest: async (options) => {
      npmAsked.push(options)
      if (!npmLatest) throw new Error('offline')
      return { adapterVersion: npmLatest, cliVersion: null }
    },
    status: () => {},
    processes: () => {},
    authCommands: () => {},
  })

  return {
    agents,
    httpAsked,
    npmAsked,
    status: () => agents.status(setup.def.id),
    setInstalledVersion(v: string) {
      currentVersion = v
    },
    setHttpLatest(v: string | null) {
      httpLatest = v
    },
    setNpmLatest(v: string | null) {
      npmLatest = v
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Antigravity version checks', () => {
  it('checks the official release manifest without npm and reports up-to-date vs update available', async () => {
    const m = await createHarnessManager({
      def: ANTIGRAVITY,
      relDir: path.join('.local', 'bin'),
      command: 'agy',
      installedVersion: '1.5.18',
      httpLatest: '1.5.18',
      hasNpm: false,
    })
    await m.agents.list()
    expect(m.status().cli).toMatchObject({
      command: 'agy',
      method: 'script',
      checkable: true,
      update: null,
      newerVersion: null,
    })
    expect(m.status().updateCheckedAt).toBeNull()

    await m.agents.checkUpdates()
    expect(m.httpAsked).toHaveLength(1)
    expect(m.httpAsked[0]?.urls[0]).toContain('antigravity-cli-auto-updater')
    expect(m.status().updateCheckedAt).not.toBeNull()
    expect(m.status().cli?.update).toBeNull()
    expect(m.status().cli?.newerVersion).toBeNull()

    // When a newer version ships, Kettu offers `agy update`.
    m.setHttpLatest('1.5.19')
    await m.agents.checkUpdates()
    await vi.waitFor(() =>
      expect(m.status().cli?.update).toEqual({ version: '1.5.19', command: 'agy update' }),
    )
    expect(m.status().cli?.newerVersion).toBe('1.5.19')

    // Once the user updates externally, re-checking clears the update while staying checked.
    m.setInstalledVersion('1.5.19')
    await m.agents.check('antigravity')
    expect(m.status().cli?.installed?.version).toBe('1.5.19')
    expect(m.status().cli?.update).toBeNull()
    expect(m.status().cli?.newerVersion).toBeNull()
    expect(m.status().updateCheckedAt).not.toBeNull()
  })

  it('keeps updateCheckedAt null when the official release manifest cannot be reached', async () => {
    const m = await createHarnessManager({
      def: ANTIGRAVITY,
      relDir: path.join('.local', 'bin'),
      command: 'agy',
      installedVersion: '1.5.18',
      httpLatest: null,
      hasNpm: false,
    })
    await m.agents.list()
    await m.agents.checkUpdates().catch(() => {})
    expect(m.status().updateCheckedAt).toBeNull()
    expect(m.status().cli?.checkable).toBe(true)
  })

  it('restores a previous Antigravity check across restarts', async () => {
    const m = await createHarnessManager({
      def: ANTIGRAVITY,
      relDir: path.join('.local', 'bin'),
      command: 'agy',
      installedVersion: '1.5.18',
      httpLatest: '1.5.18',
      hasNpm: false,
    })
    m.agents.restoreUpdates({
      version: 1,
      agents: {
        antigravity: { checkedAt: 42_000, attemptedAt: 42_000, latest: null, cli: '1.5.18' },
      },
    })
    await m.agents.list()
    expect(m.status().updateCheckedAt).toBe(42_000)
    expect(m.status().cli?.update).toBeNull()
    expect(m.status().cli?.newerVersion).toBeNull()
  })

  it('reports newerVersion without an update command when agy lives outside scriptHome', async () => {
    const m = await createHarnessManager({
      def: ANTIGRAVITY,
      relDir: 'custom-bin',
      command: 'agy',
      installedVersion: '1.5.17',
      httpLatest: '1.5.18',
      hasNpm: false,
    })
    await m.agents.list()
    await m.agents.checkUpdates()
    expect(m.status().cli?.method).toBeNull()
    expect(m.status().cli?.update).toBeNull()
    expect(m.status().cli?.newerVersion).toBe('1.5.18')
  })
})

describe('other standalone/script harnesses with official version endpoints', () => {
  it('checks script-installed Grok against its official stable endpoint without npm', async () => {
    const m = await createHarnessManager({
      def: GROK,
      relDir: path.join('.grok', 'bin'),
      command: 'grok',
      installedVersion: '1.0.92',
      httpLatest: '1.0.92',
      hasNpm: false,
      registryVersion: '1.0.88',
    })
    await m.agents.list()
    expect(m.status().cli?.method).toBe('script')
    expect(m.status().cli?.checkable).toBe(true)
    expect(m.status().updateCheckedAt).toBeNull()

    await m.agents.checkUpdates()
    expect(m.httpAsked).toHaveLength(1)
    expect(m.status().updateCheckedAt).not.toBeNull()
    expect(m.status().cli?.update).toBeNull()
    expect(m.status().cli?.newerVersion).toBeNull()
  })

  it('checks script-installed OMP and exposes it as a checkable CLI', async () => {
    const m = await createHarnessManager({
      def: OMP,
      relDir: path.join('.local', 'bin'),
      command: 'omp',
      installedVersion: '19.2.1',
      httpLatest: '19.2.1',
      hasNpm: false,
    })
    await m.agents.list()
    await vi.waitFor(() => expect(m.status().cli?.installed?.version).toBe('19.2.1'))
    expect(m.status().cli?.method).toBe('script')
    expect(m.status().cli?.checkable).toBe(true)

    await m.agents.checkUpdates()
    expect(m.httpAsked).toHaveLength(1)
    expect(m.status().updateCheckedAt).not.toBeNull()
    expect(m.status().cli?.update).toBeNull()
    expect(m.status().cli?.newerVersion).toBeNull()
  })

  it('checks script-installed Claude Code and OpenCode via their official endpoints even without npm', async () => {
    const claude = await createHarnessManager({
      def: CLAUDE_CODE,
      relDir: path.join('.local', 'share', 'claude'),
      command: 'claude',
      installedVersion: '2.1.332',
      httpLatest: '2.1.332',
      hasNpm: false,
      installedAdapterVersion: '0.3.314',
    })
    await claude.agents.list()
    expect(claude.status().cli?.method).toBe('script')
    expect(claude.status().cli?.checkable).toBe(true)
    await claude.agents.checkUpdates()
    expect(claude.httpAsked).toHaveLength(1)
    expect(claude.npmAsked).toEqual([])
    expect(claude.status().updateCheckedAt).not.toBeNull()
    expect(claude.status().cli?.newerVersion).toBeNull()

    const opencode = await createHarnessManager({
      def: OPENCODE,
      relDir: path.join('.opencode', 'bin'),
      command: 'opencode',
      installedVersion: '2.4.1',
      httpLatest: '2.4.2',
      hasNpm: false,
    })
    await opencode.agents.list()
    expect(opencode.status().cli?.method).toBe('script')
    expect(opencode.status().cli?.checkable).toBe(true)
    await opencode.agents.checkUpdates()
    expect(opencode.httpAsked).toHaveLength(1)
    expect(opencode.npmAsked).toEqual([])
    expect(opencode.status().cli?.newerVersion).toBe('2.4.2')
    expect(opencode.status().updateCheckedAt).not.toBeNull()
  })
})

describe('harnesses without a remote version check must not fabricate up-to-date state', () => {
  it('does not leak ACP Registry listing timestamps into WinGet-installed Copilot or user-installed Kilo', async () => {
    const copilot = await createHarnessManager({
      def: COPILOT,
      relDir: 'winget',
      command: 'copilot',
      installedVersion: '1.0.112',
      registryVersion: '1.0.112',
      hasNpm: true,
    })
    await copilot.agents.list()
    await copilot.agents.checkUpdates()
    expect(copilot.status().cli?.method).toBe('winget')
    expect(copilot.status().cli?.checkable).toBe(false)
    expect(copilot.status().updateCheckedAt).toBeNull()

    const kilo = await createHarnessManager({
      def: KILO,
      relDir: 'custom-bin',
      command: 'kilo',
      installedVersion: '7.8.27',
      registryVersion: '7.8.27',
      hasNpm: false,
    })
    await kilo.agents.list()
    await kilo.agents.checkUpdates()
    expect(kilo.status().cli?.checkable).toBe(false)
    expect(kilo.status().updateCheckedAt).toBeNull()
  })

  it('leaves Hermes and user-installed Cursor uncheckable with null updateCheckedAt', async () => {
    const hermes = await createHarnessManager({
      def: HERMES,
      relDir: path.join('.hermes', 'hermes-agent'),
      command: 'hermes',
      installedVersion: '1.0.0',
      hasNpm: true,
    })
    await hermes.agents.list()
    await hermes.agents.checkUpdates()
    expect(hermes.status().cli).toBeNull()
    expect(hermes.status().updateCheckedAt).toBeNull()

    const cursor = await createHarnessManager({
      def: CURSOR,
      relDir: 'custom-bin',
      command: 'cursor-agent',
      installedVersion: '2026.11.13',
      registryVersion: '2026.11.13',
      hasNpm: true,
    })
    await cursor.agents.list()
    await cursor.agents.checkUpdates()
    expect(cursor.status().cli).toBeNull()
    expect(cursor.status().release).toBeNull()
    expect(cursor.status().updateCheckedAt).toBeNull()
  })

  it('marks npm-only harnesses uncheckable when npm is missing on the machine', async () => {
    const codex = await createHarnessManager({
      def: CODEX,
      relDir: path.join('.codex', 'packages', 'standalone'),
      command: 'codex',
      installedVersion: '0.172.0',
      hasNpm: false,
    })
    await codex.agents.list()
    await codex.agents.checkUpdates()
    expect(codex.status().cli?.checkable).toBe(false)
    expect(codex.status().updateCheckedAt).toBeNull()

    const pi = await createHarnessManager({
      def: PI,
      relDir: 'custom-bin',
      command: 'pi',
      installedVersion: '0.81.0',
      hasNpm: false,
    })
    await pi.agents.list()
    await pi.agents.checkUpdates()
    expect(pi.status().cli?.checkable).toBe(false)
    expect(pi.status().updateCheckedAt).toBeNull()
  })
})
