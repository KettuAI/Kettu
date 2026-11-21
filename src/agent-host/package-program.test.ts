// Which copy of an npm package harness runs: the program picked in Settings, the user's own install
// of its command when Kettu runs that version, and only then the copy Kettu installs.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import type { InstalledAdapter } from './adapter-install'
import { CLAUDE_CODE } from './agents/claude-code'
import { DEEPAGENTS } from './agents/deepagents'
import { DEEPSEEK } from './agents/deepseek'
import { KIMI } from './agents/kimi'
import { detectAgent, type AgentDefinition, type DetectContext } from './catalog'
import type { Env } from './find-command'
import type { HarnessRule } from './harness-manifest'
import type { VersionChoice } from './harness-versions'
import type { CliFiles } from './installed-cli'
import type { NodeProbe } from './shell-env'

const KETTU = '/home/me/.kettu/harnesses'
const NODE: NodeProbe = {
  nodePath: '/usr/bin/node',
  nodeVersion: '24.11.0',
  npmPath: '/usr/bin/npm',
}
const NO_NODE: NodeProbe = { nodePath: null, nodeVersion: null, npmPath: null }

function kettuCopy(def: AgentDefinition, version: string): InstalledAdapter {
  const launch = def.launch as { package: string }
  const dir = `${KETTU}/${def.id}/${version}`
  return { version, dir, entry: `${dir}/node_modules/${launch.package}/bin.js`, installedAt: 1 }
}

const rule = (broken: string[]): HarnessRule => ({ kettu: '*', broken, sha256: {} })

interface Options {
  /** Each program on the machine and the version it answers, or why it cannot say. */
  programs?: Record<string, string | { error: string }>
  installs?: InstalledAdapter[]
  node?: NodeProbe
  chosen?: string
  manifest?: HarnessRule
  platform?: Platform
  env?: Env
  files?: Partial<CliFiles>
  versions?: VersionChoice
}

/** A detection context over `programs`; `asked` notes every `--version` run, as its words. */
function context(
  def: AgentDefinition,
  options: Options = {},
): DetectContext & { asked: string[][] } {
  const programs = options.programs ?? {}
  const asked: string[][] = []
  const files: CliFiles = {
    isFile: async (file) => file in programs,
    realpath: async (file) => file,
    readText: async () => '',
    ...options.files,
  }
  return {
    asked,
    platform: options.platform ?? 'linux',
    env: options.env ?? { PATH: '/usr/local/bin:/usr/bin', HOME: '/home/me' },
    nodeRuntime: { command: '/kettu/electron', env: {} },
    binaryOverride: options.chosen ?? null,
    node: options.node ?? NODE,
    adaptersDir: KETTU,
    versions: options.versions ?? { wanted: '0.2.2-rc.2', floor: true },
    manifestRule: options.manifest ?? null,
    isExecutable: async (file) => file in programs,
    installed: async (agentId) =>
      agentId === def.id ? (options.installs ?? []) : Promise.resolve([]),
    probeCli: async (program, _env, words = []) => {
      asked.push([program, ...words])
      const answer = programs[words.at(-1) ?? program]
      if (answer === undefined) return { error: `${program} was not found.` }
      return typeof answer === 'string' ? { version: answer } : answer
    },
    cliFiles: files,
  }
}

describe('a package harness whose own program is on PATH', () => {
  it('runs the user dsh, which needs no Node.js', async () => {
    const found = await detectAgent(
      DEEPSEEK,
      context(DEEPSEEK, { programs: { '/usr/local/bin/dsh': '0.2.2-rc.3' }, node: NO_NODE }),
    )
    expect(found).toMatchObject({
      state: 'available',
      spec: { command: '/usr/local/bin/dsh', args: [], shell: false },
      adapter: null,
      cli: { path: '/usr/local/bin/dsh', version: '0.2.2-rc.3', problem: null },
    })
    expect(found).not.toHaveProperty('unused')
  })

  it('runs an ACP harness program with its launch words, at any version', async () => {
    const found = await detectAgent(
      KIMI,
      context(KIMI, { programs: { '/usr/local/bin/kimi': '9.0.0' }, node: NO_NODE }),
    )
    expect(found).toMatchObject({
      state: 'available',
      spec: { command: '/usr/local/bin/kimi', args: ['acp'] },
      cli: { version: '9.0.0' },
    })
  })

  it('looks where the vendor installer puts it when PATH has none', async () => {
    const found = await detectAgent(
      KIMI,
      context(KIMI, { programs: { '/home/me/.kimi-code/bin/kimi': '2.7.2' }, node: NO_NODE }),
    )
    expect(found).toMatchObject({
      state: 'available',
      spec: { command: '/home/me/.kimi-code/bin/kimi', args: ['acp'] },
    })
  })
})

describe('a user program Kettu does not run', () => {
  it('runs the copy Kettu installed when the version is outside the range, and says why', async () => {
    const copy = kettuCopy(DEEPSEEK, '0.2.2-rc.2')
    const found = await detectAgent(
      DEEPSEEK,
      context(DEEPSEEK, { programs: { '/usr/local/bin/dsh': '0.3.0' }, installs: [copy] }),
    )
    expect(found).toMatchObject({
      state: 'available',
      spec: { command: '/usr/bin/node', args: [copy.entry], version: '0.2.2-rc.2' },
      unused: {
        installed: { path: '/usr/local/bin/dsh', version: '0.3.0' },
        why: { kind: 'range', range: '~0.2.2-rc.2' },
      },
    })
    expect(found).not.toHaveProperty('cli')
  })

  it('offers to install Kettu copy when the manifest says the user version does not work', async () => {
    const found = await detectAgent(
      KIMI,
      context(KIMI, {
        programs: { '/usr/local/bin/kimi': '2.7.2' },
        manifest: rule(['2.7.2']),
        versions: { wanted: '2.7.1' },
      }),
    )
    expect(found).toMatchObject({
      state: 'available',
      spec: null,
      adapter: { installed: false },
      unused: { installed: { version: '2.7.2' }, why: { kind: 'manifest' } },
    })
  })

  it('still needs Node.js for Kettu copy, and says why the user program is not used', async () => {
    const found = await detectAgent(
      DEEPSEEK,
      context(DEEPSEEK, { programs: { '/usr/local/bin/dsh': '0.1.9' }, node: NO_NODE }),
    )
    expect(found).toMatchObject({
      state: 'node-missing',
      unused: { why: { kind: 'range', range: '~0.2.2-rc.2' } },
    })
  })

  it('does not run one that cannot say its version', async () => {
    const found = await detectAgent(
      DEEPSEEK,
      context(DEEPSEEK, {
        programs: { '/usr/local/bin/dsh': { error: 'dsh exited with code 1' } },
      }),
    )
    expect(found).toMatchObject({
      state: 'available',
      spec: null,
      unused: { installed: { path: '/usr/local/bin/dsh' }, why: { kind: 'unusable' } },
    })
  })
})

describe('without a program of the user', () => {
  it('runs Kettu copy, as before', async () => {
    const copy = kettuCopy(DEEPSEEK, '0.2.2-rc.2')
    const found = await detectAgent(DEEPSEEK, context(DEEPSEEK, { installs: [copy] }))
    expect(found).toMatchObject({
      state: 'available',
      spec: { command: '/usr/bin/node', args: [copy.entry] },
    })
    expect(found).not.toHaveProperty('cli')
    expect(found).not.toHaveProperty('unused')
  })

  it('needs Node.js for Kettu copy, as before', async () => {
    const found = await detectAgent(DEEPSEEK, context(DEEPSEEK, { node: NO_NODE }))
    expect(found).toMatchObject({ state: 'node-missing' })
  })

  it('never looks on PATH for an ACP adapter package', async () => {
    const copy = kettuCopy(DEEPAGENTS, '0.1.7')
    const found = await detectAgent(
      DEEPAGENTS,
      context(DEEPAGENTS, {
        programs: { '/usr/local/bin/deepagents-acp': '0.1.44' },
        installs: [copy],
        versions: { wanted: '0.1.7' },
      }),
    )
    expect(found).toMatchObject({ spec: { args: [copy.entry] } })
    expect(found).not.toHaveProperty('cli')
  })
})

describe('a program picked in Settings', () => {
  it('runs in place of the one on PATH, whatever its version', async () => {
    const chosen = '/opt/dsh/bin/dsh'
    const found = await detectAgent(
      DEEPSEEK,
      context(DEEPSEEK, {
        programs: { [chosen]: '0.9.0', '/usr/local/bin/dsh': '0.2.2-rc.3' },
        chosen,
        node: NO_NODE,
      }),
    )
    expect(found).toMatchObject({
      state: 'available',
      spec: { command: chosen, args: [] },
      adapter: null,
      cli: { path: chosen, version: '0.9.0' },
    })
  })

  it('runs a wrapper the user picked on Windows through the shell', async () => {
    const chosen = 'E:\\Softw\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd'
    const found = await detectAgent(
      DEEPSEEK,
      context(DEEPSEEK, {
        programs: { [chosen]: '0.2.2-rc.3' },
        chosen,
        platform: 'win32',
        env: { Path: 'C:\\Windows' },
      }),
    )
    expect(found).toMatchObject({ spec: { command: chosen, shell: true }, cli: { path: chosen } })
  })

  it('runs an adapter package that Kettu never looks for on PATH', async () => {
    const chosen = '/opt/deepagents/bin/deepagents-acp'
    const found = await detectAgent(
      DEEPAGENTS,
      context(DEEPAGENTS, { programs: { [chosen]: '0.1.44' }, chosen, node: NO_NODE }),
    )
    expect(found).toMatchObject({ state: 'available', spec: { command: chosen, args: [] } })
  })

  it('says when the picked program is gone', async () => {
    const found = await detectAgent(DEEPSEEK, context(DEEPSEEK, { chosen: '/opt/gone/dsh' }))
    expect(found).toMatchObject({ state: 'not-installed' })
  })

  it('is the CLI Claude Code runs', async () => {
    const chosen = '/opt/claude/claude'
    const found = await detectAgent(
      CLAUDE_CODE,
      context(CLAUDE_CODE, {
        programs: { [chosen]: '2.1.400' },
        chosen,
        versions: { wanted: '0.3.400', floor: true },
      }),
    )
    expect(found).toMatchObject({ state: 'available', cli: { path: chosen, version: '2.1.400' } })
  })
})

describe('the user program on Windows', () => {
  const npm = 'C:\\Users\\me\\AppData\\Roaming\\npm'
  const shim = path.win32.join(npm, 'dsh.cmd')
  const script = path.win32.join(npm, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const SHIM = [
    '@ECHO off',
    'SET dp0=%~dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    `"%_prog%"  "%dp0%\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js" %*`,
  ].join('\r\n')
  const windows: Options = {
    platform: 'win32',
    env: { Path: npm, PATHEXT: '.COM;.EXE;.BAT;.CMD' },
    node: { nodePath: 'C:\\node\\node.exe', nodeVersion: '24.11.0', npmPath: 'C:\\node\\npm.cmd' },
  }

  it('runs the script an npm shim starts on the user Node.js', async () => {
    const ctx = context(DEEPSEEK, {
      ...windows,
      programs: { [shim]: '0.2.2-rc.3', [script]: '0.2.2-rc.3' },
      files: { readText: async (file) => (file === shim ? SHIM : '') },
    })
    const found = await detectAgent(DEEPSEEK, ctx)
    expect(found).toMatchObject({
      state: 'available',
      spec: { command: 'C:\\node\\node.exe', args: [script], shell: false },
      cli: { path: script, version: '0.2.2-rc.3' },
    })
    expect(ctx.asked).toContainEqual(['C:\\node\\node.exe', script])
  })

  it('does not run another wrapper on PATH, which can be picked in Settings instead', async () => {
    const wrapper = 'E:\\Softw\\dsh\\resources\\runtime\\cli\\bin\\dsh.cmd'
    const found = await detectAgent(
      DEEPSEEK,
      context(DEEPSEEK, {
        ...windows,
        env: { Path: path.win32.dirname(wrapper) },
        programs: { [wrapper]: '0.2.2-rc.3' },
        files: { readText: async () => '@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n' },
      }),
    )
    expect(found).toMatchObject({
      state: 'available',
      spec: null,
      unused: { installed: { path: wrapper }, why: { kind: 'unusable' } },
    })
  })
})
