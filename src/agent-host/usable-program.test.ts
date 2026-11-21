// Which of the user's programs of a name a harness runs when several are found: the first on PATH,
// then in the vendor installer's folder, that Kettu can run, and the first found only when none can.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Platform } from '@shared/platform'
import type { InstalledAdapter } from './adapter-install'
import { CLAUDE_CODE } from './agents/claude-code'
import { CODEX } from './agents/codex'
import { DEEPSEEK } from './agents/deepseek'
import { OPENCODE } from './agents/opencode'
import { detectAgent, type AgentDefinition, type DetectContext } from './catalog'
import type { Env } from './find-command'
import type { VersionChoice } from './harness-versions'

interface Options {
  /** Each program on the machine and the version it answers, or why it cannot say. */
  programs: Record<string, string | { error: string }>
  platform?: Platform
  env?: Env
  installs?: InstalledAdapter[]
  /** What each file holds, such as an SDK's `package.json`. */
  texts?: Record<string, string>
  versions?: VersionChoice
}

/** A detection context over `programs`; `asked` notes every program asked its version. */
function context(def: AgentDefinition, options: Options): DetectContext & { asked: string[] } {
  const { programs } = options
  const asked: string[] = []
  return {
    asked,
    platform: options.platform ?? 'linux',
    env: options.env ?? { PATH: '/usr/local/bin:/usr/bin', HOME: '/home/me' },
    nodeRuntime: { command: '/kettu/electron', env: {} },
    binaryOverride: null,
    node: { nodePath: '/usr/bin/node', nodeVersion: '24.11.0', npmPath: '/usr/bin/npm' },
    adaptersDir: '/home/me/.kettu/harnesses',
    versions: options.versions ?? { wanted: '0.2.2-rc.2', floor: true },
    isExecutable: async (file) => file in programs,
    isFile: async (file) => file in programs || file in (options.texts ?? {}),
    installed: async (agentId) => (agentId === def.id ? (options.installs ?? []) : []),
    probeCli: async (program, _env, words = []) => {
      const file = words.at(-1) ?? program
      asked.push(file)
      const answer = programs[file]
      if (answer === undefined) return { error: `${file} was not found.` }
      return typeof answer === 'string' ? { version: answer } : answer
    },
    cliFiles: {
      isFile: async (file) => file in programs,
      realpath: async (file) => file,
      readText: async (file) => {
        const text = options.texts?.[file]
        if (text === undefined) throw new Error(`${file} was not found`)
        return text
      },
    },
  }
}

describe('several programs of the name on PATH', () => {
  it('runs a newer OpenCode later on PATH, past an OpenCode 1 before it', async () => {
    const ctx = context(OPENCODE, {
      programs: { '/usr/local/bin/opencode': '1.4.0', '/usr/bin/opencode': '2.0.40' },
    })
    const found = await detectAgent(OPENCODE, ctx)
    expect(found).toMatchObject({
      state: 'available',
      spec: { command: '/usr/bin/opencode' },
      cli: { path: '/usr/bin/opencode', version: '2.0.40', problem: null },
    })
  })

  it('runs one later on PATH when the first cannot say its version', async () => {
    const found = await detectAgent(
      CODEX,
      context(CODEX, {
        programs: {
          '/usr/local/bin/codex': { error: 'codex exited with code 1' },
          '/usr/bin/codex': '0.170.0',
        },
      }),
    )
    expect(found).toMatchObject({
      state: 'available',
      cli: { path: '/usr/bin/codex', version: '0.170.0' },
    })
  })

  it('asks no program after the first that runs', async () => {
    const ctx = context(CODEX, {
      programs: { '/usr/local/bin/codex': '0.170.0', '/usr/bin/codex': '0.100.0' },
    })
    await detectAgent(CODEX, ctx)
    expect(ctx.asked).toEqual(['/usr/local/bin/codex'])
  })

  it('says what is wrong with the first when none runs', async () => {
    const found = await detectAgent(
      CODEX,
      context(CODEX, {
        programs: { '/usr/local/bin/codex': '0.100.0', '/usr/bin/codex': '0.120.0' },
      }),
    )
    expect(found).toMatchObject({
      state: 'not-installed',
      cli: {
        path: '/usr/local/bin/codex',
        version: '0.100.0',
        problem: { kind: 'too-old', minimum: '0.166.0' },
      },
    })
  })

  it('passes the SDK a newer claude later on PATH, past one older than the SDK runs', async () => {
    const dir = '/home/me/.kettu/harnesses/claude-code/0.3.400'
    const sdk = path.posix.join(dir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk')
    const install = { version: '0.3.400', dir, entry: `${sdk}/sdk.mjs`, installedAt: 1 }
    const found = await detectAgent(
      CLAUDE_CODE,
      context(CLAUDE_CODE, {
        programs: { '/usr/local/bin/claude': '2.1.300', '/usr/bin/claude': '2.1.400' },
        installs: [install],
        texts: { [`${sdk}/package.json`]: JSON.stringify({ claudeCodeVersion: '2.1.400' }) },
        versions: { wanted: '0.3.400', floor: true },
      }),
    )
    expect(found).toMatchObject({
      state: 'available',
      spec: { cli: '/usr/bin/claude', version: '0.3.400' },
      cli: { path: '/usr/bin/claude', version: '2.1.400', problem: null },
    })
  })

  it('runs the user dsh later on PATH that is in the range, past one that is not', async () => {
    const found = await detectAgent(
      DEEPSEEK,
      context(DEEPSEEK, {
        programs: { '/usr/local/bin/dsh': '0.3.0', '/usr/bin/dsh': '0.2.2-rc.3' },
      }),
    )
    expect(found).toMatchObject({
      state: 'available',
      spec: { command: '/usr/bin/dsh' },
      cli: { path: '/usr/bin/dsh', version: '0.2.2-rc.3' },
    })
    expect(found).not.toHaveProperty('unused')
  })
})

describe('the folder the vendor installer puts the program in', () => {
  it('holds Claude Code and Codex when PATH has neither', async () => {
    const claude = await detectAgent(
      CLAUDE_CODE,
      context(CLAUDE_CODE, {
        programs: { '/home/me/.local/bin/claude': '2.1.400' },
        versions: { wanted: '0.3.400', floor: true },
      }),
    )
    expect(claude).toMatchObject({ cli: { path: '/home/me/.local/bin/claude' } })
    const codex = await detectAgent(
      CODEX,
      context(CODEX, { programs: { '/home/me/.local/bin/codex': '0.170.0' } }),
    )
    expect(codex).toMatchObject({
      state: 'available',
      cli: { path: '/home/me/.local/bin/codex', version: '0.170.0' },
    })
  })

  it('is looked in after PATH, whose program is too old', async () => {
    const found = await detectAgent(
      CODEX,
      context(CODEX, {
        programs: { '/usr/bin/codex': '0.100.0', '/home/me/.local/bin/codex': '0.170.0' },
      }),
    )
    expect(found).toMatchObject({
      state: 'available',
      cli: { path: '/home/me/.local/bin/codex' },
    })
  })

  it('is the one each vendor documents on Windows', async () => {
    const windows = {
      platform: 'win32' as const,
      env: {
        Path: 'C:\\Windows\\system32',
        PATHEXT: '.COM;.EXE;.BAT;.CMD',
        USERPROFILE: 'C:\\Users\\me',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      },
    }
    const claudeFile = 'C:\\Users\\me\\.local\\bin\\claude.exe'
    const claude = await detectAgent(
      CLAUDE_CODE,
      context(CLAUDE_CODE, {
        ...windows,
        programs: { [claudeFile]: '2.1.400' },
        versions: { wanted: '0.3.400', floor: true },
      }),
    )
    expect(claude).toMatchObject({ cli: { path: claudeFile } })
    const codexFile = 'C:\\Users\\me\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe'
    const codex = await detectAgent(
      CODEX,
      context(CODEX, { ...windows, programs: { [codexFile]: '0.170.0' } }),
    )
    expect(codex).toMatchObject({ state: 'available', cli: { path: codexFile } })
  })
})
