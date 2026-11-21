// The reason detection gives when a harness cannot run, which every surface says the same way.

import { describe, expect, it } from 'vitest'
import type { InstalledAdapter } from './adapter-install'
import { CODEX } from './agents/codex'
import { FAST_AGENT } from './agents/fast-agent'
import { KIMI } from './agents/kimi'
import { QWEN } from './agents/qwen'
import { detectAgent, type AgentDefinition, type DetectContext } from './catalog'
import type { VersionChoice } from './harness-versions'
import { satisfiesNode, type NodeProbe } from './shell-env'

const KETTU = '/home/me/.kettu/harnesses'
const NODE: NodeProbe = {
  nodePath: '/usr/bin/node',
  nodeVersion: 'v24.11.0',
  npmPath: '/usr/bin/npm',
}

interface Options {
  /** Each program on the machine and the version it answers, or why it cannot say. */
  programs?: Record<string, string | { error: string }>
  installs?: InstalledAdapter[]
  node?: NodeProbe
  chosen?: string
  versions?: VersionChoice | null
}

function context(def: AgentDefinition, options: Options = {}): DetectContext {
  const programs = options.programs ?? {}
  return {
    platform: 'linux',
    env: { PATH: '/usr/local/bin:/usr/bin', HOME: '/home/me' },
    nodeRuntime: { command: '/kettu/electron', env: {} },
    binaryOverride: options.chosen ?? null,
    node: options.node ?? NODE,
    adaptersDir: KETTU,
    versions: options.versions === undefined ? { wanted: '1.0.0', floor: true } : options.versions,
    manifestRule: null,
    sessionRouterPath: '/kettu/router.js',
    isExecutable: async (file) => file in programs,
    installed: async (agentId) => (agentId === def.id ? (options.installs ?? []) : []),
    installedArchives: async () => [],
    uvxVersion: async () => null,
    probeCli: async (program, _env, words = []) => {
      const answer = programs[words.at(-1) ?? program]
      if (answer === undefined) return { error: `${program} was not found.` }
      return typeof answer === 'string' ? { version: answer } : answer
    },
    cliFiles: {
      isFile: async (file) => file in programs,
      realpath: async (file) => file,
      readText: async () => '',
    },
  }
}

function kettuCopy(def: AgentDefinition, version: string): InstalledAdapter {
  const launch = def.launch as { package: string }
  const dir = `${KETTU}/${def.id}/${version}`
  return { version, dir, entry: `${dir}/node_modules/${launch.package}/bin.js`, installedAt: 1 }
}

describe('the reason a harness cannot run', () => {
  it('is not installed when its program is nowhere', async () => {
    expect(await detectAgent(CODEX, context(CODEX))).toMatchObject({
      state: 'not-installed',
      reason: { kind: 'not-installed' },
    })
  })

  it('needs Node.js at the harness own minimum when none is found', async () => {
    const found = await detectAgent(
      KIMI,
      context(KIMI, { node: { nodePath: null, nodeVersion: null, npmPath: null } }),
    )
    expect(found).toMatchObject({
      state: 'node-missing',
      reason: { kind: 'needs-node', minimum: '22.19.0', installed: null },
    })
    expect(found).not.toHaveProperty('reason.unreadable')
  })

  it('needs Node.js at the harness own minimum when the one found is older', async () => {
    const node = { ...NODE, nodeVersion: 'v22.18.0' }
    expect(await detectAgent(KIMI, context(KIMI, { node }))).toMatchObject({
      state: 'node-outdated',
      reason: { kind: 'needs-node', minimum: '22.19.0', installed: 'v22.18.0' },
    })
    expect(await detectAgent(QWEN, context(QWEN, { node }))).toMatchObject({
      state: 'available',
    })
  })

  it('says a node that did not answer its version is not a missing one', async () => {
    const node = { ...NODE, nodeVersion: null, nodeError: 'spawn EACCES' }
    const found = await detectAgent(QWEN, context(QWEN, { node }))
    expect(found).toMatchObject({
      state: 'node-missing',
      reason: { kind: 'needs-node', minimum: '22', installed: null, unreadable: true },
    })
    expect(found).toHaveProperty('detail', expect.stringContaining('/usr/bin/node'))
    expect(found).toHaveProperty('detail', expect.stringContaining('spawn EACCES'))
  })

  it('needs npm to install a package harness, but not to run one installed', async () => {
    const node = { ...NODE, npmPath: null }
    expect(await detectAgent(QWEN, context(QWEN, { node }))).toMatchObject({
      state: 'not-installed',
      reason: { kind: 'needs-npm' },
    })
    const installs = [kettuCopy(QWEN, '1.0.0')]
    expect(await detectAgent(QWEN, context(QWEN, { node, installs }))).toMatchObject({
      state: 'available',
    })
  })

  it('needs uv when uvx is missing, and a newer uv than one too old', async () => {
    expect(await detectAgent(FAST_AGENT, context(FAST_AGENT))).toMatchObject({
      state: 'not-installed',
      reason: { kind: 'needs-uv', minimum: '0.12.0', installed: null },
    })
    const programs = { '/usr/bin/uvx': '0.8.3' }
    expect(await detectAgent(FAST_AGENT, context(FAST_AGENT, { programs }))).toMatchObject({
      state: 'not-installed',
      reason: { kind: 'needs-uv', minimum: '0.12.0', installed: '0.8.3' },
    })
  })

  it('is too old with the version the user program must reach', async () => {
    const programs = { '/usr/local/bin/codex': '0.150.0' }
    expect(await detectAgent(CODEX, context(CODEX, { programs }))).toMatchObject({
      state: 'not-installed',
      reason: { kind: 'too-old', minimum: '0.166.0', installed: '0.150.0' },
      cli: { path: '/usr/local/bin/codex' },
    })
  })

  it('cannot run a program that does not say its version, with why', async () => {
    const programs = { '/usr/local/bin/codex': { error: 'exited with code 1' } }
    const found = await detectAgent(CODEX, context(CODEX, { programs }))
    expect(found).toMatchObject({ state: 'not-installed', reason: { kind: 'cannot-run' } })
    expect(found).toHaveProperty('reason.why', expect.stringContaining('exited with code 1'))
  })

  it('cannot run a chosen program that is not there', async () => {
    const found = await detectAgent(QWEN, context(QWEN, { chosen: '/opt/qwen/bin/qwen' }))
    expect(found).toMatchObject({ state: 'not-installed', reason: { kind: 'cannot-run' } })
    expect(found).toHaveProperty('reason.why', expect.stringContaining('/opt/qwen/bin/qwen'))
  })

  it('has no version when none fits this computer', async () => {
    expect(await detectAgent(QWEN, context(QWEN, { versions: null }))).toMatchObject({
      state: 'not-installed',
      reason: { kind: 'no-version' },
    })
    const programs = { '/usr/bin/uvx': '0.12.0' }
    expect(
      await detectAgent(FAST_AGENT, context(FAST_AGENT, { programs, versions: null })),
    ).toMatchObject({ state: 'not-installed', reason: { kind: 'no-version' } })
  })
})

describe('a Node.js requirement', () => {
  it('compares the patch too', () => {
    expect(satisfiesNode('v22.19.0', '>=22.19.0')).toBe(true)
    expect(satisfiesNode('v22.18.9', '>=22.19.0')).toBe(false)
    expect(satisfiesNode('24.9.0', '>=24.9.1')).toBe(false)
    expect(satisfiesNode('v24.10.0', '>=24.9.1')).toBe(true)
    expect(satisfiesNode('v23.0.0', '>=22')).toBe(true)
    expect(satisfiesNode('v20.19.0', '>=22')).toBe(false)
  })
})
