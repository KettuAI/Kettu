// Claude Code: a new Claude Agent SDK, installed without the CLI it brings as the app installs
// it, runs the Claude Code CLI it names through `initialize`, which needs no sign-in; then
// Kettu's own SDK types are checked against its declarations.

import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { lackingFields } from './claude-fields.mjs'
import { brief, CheckFailure, expect, harnessEnv, npmVersions } from './common.mjs'
import { rangeOf } from './kettu.mjs'

const INITIALIZE_MS = 120_000

/** The oldest version in the range, whose field check every new one is compared with. */
let baseline = null

export const claudeCode = {
  id: 'claude-code',
  subject: () => 'Claude Agent SDK',

  async versions(def) {
    const versions = await npmVersions(def.launch.package, rangeOf(def))
    const known = new Set(versions.map((entry) => entry.version))
    return { versions, inRange: (version) => known.has(version) }
  },

  async check(def, version, ctx) {
    ctx.step = 'install'
    const sdk = await ctx.installPackage(def.launch.package, version, { withoutCli: true })
    const manifest = JSON.parse(
      await readFile(
        path.join(sdk.dir, 'node_modules', def.launch.package, 'package.json'),
        'utf8',
      ),
    )
    const cliVersion = manifest.claudeCodeVersion
    expect(
      typeof cliVersion === 'string' && /^\d+\.\d+\.\d+$/.test(cliVersion),
      `The SDK names no Claude Code version (claudeCodeVersion: ${brief(cliVersion)})`,
    )
    ctx.log.add(`The SDK runs Claude Code ${cliVersion}`)

    ctx.step = 'cli'
    const cli = await ctx.installPackage(def.installs.npm, cliVersion)
    const program = await nativeProgram(cli.dir)
    ctx.log.add(`Claude Code: ${program}`)

    ctx.step = 'initialize'
    const env = await harnessEnv(ctx.home, {
      CLAUDE_CONFIG_DIR: path.join(ctx.home, '.claude'),
      DISABLE_AUTOUPDATER: '1',
    })
    const answer = (await initialize(sdk.entry, program, ctx.work, env, ctx.log)) ?? {}
    ctx.log.add(
      `initialize: Claude Code ${answer.claude_code_version}, ${answer.models?.length ?? 0} models, ` +
        `${answer.commands?.length ?? 0} commands`,
    )
    expect(
      answer.claude_code_version === cliVersion,
      `initialize reported Claude Code ${brief(answer.claude_code_version)}, not ${cliVersion}`,
    )
    expect(
      Array.isArray(answer.models) && answer.models.length > 0 && answer.models.every(isModel),
      `initialize listed no models Kettu can read: ${brief(answer.models)}`,
    )
    expect(
      Array.isArray(answer.commands) && answer.commands.length > 0,
      `initialize listed no commands: ${brief(answer.commands)}`,
    )

    ctx.step = 'types'
    baseline ??= baselineFields(def, ctx).catch((error) => {
      baseline = null
      throw error
    })
    const known = await baseline
    const lacking = await lackingFields(sdk.dir)
    const lost = lacking.filter((field) => !known.lacking.includes(field))
    ctx.log.add(
      `Kettu's SDK types: ${lacking.length} fields undeclared, ${known.lacking.length} of them ` +
        `already in ${known.version}`,
    )
    if (lost.length > 0) {
      throw new CheckFailure(`The SDK's types no longer declare: ${lost.join(', ')}`)
    }
  },
}

async function baselineFields(def, ctx) {
  const versions = await npmVersions(def.launch.package, rangeOf(def))
  const [oldest] = versions.map((entry) => entry.version).sort(ctx.kettu.compareVersions)
  if (!oldest) throw new Error(`No version of ${def.launch.package} is in ${rangeOf(def)}`)
  ctx.log.add(`The field check's baseline is the oldest SDK in the range, ${oldest}`)
  const install = await ctx.installPackage(def.launch.package, oldest, { withoutCli: true })
  return { version: oldest, lacking: await lackingFields(install.dir) }
}

/** The platform's own Claude Code program, which npm puts in a package of its own. */
async function nativeProgram(dir) {
  const scope = path.join(dir, 'node_modules', '@anthropic-ai')
  const names = (await readdir(scope)).filter((name) => name.startsWith('claude-code-'))
  for (const name of names) {
    for (const file of ['claude', 'claude.exe']) {
      const candidate = path.join(scope, name, file)
      const found = await stat(candidate).catch(() => null)
      if (found?.isFile()) return candidate
    }
  }
  throw new CheckFailure(
    `npm installed no Claude Code program for ${process.platform}-${process.arch}`,
  )
}

function isModel(model) {
  return typeof model?.value === 'string' && typeof model.displayName === 'string'
}

/** The SDK's `initialize` answer, through the SDK loaded as the agent host loads it. */
async function initialize(entry, program, cwd, env, log) {
  const sdk = await import(pathToFileURL(entry).href)
  // A prompt that never sends a message: initialize needs none, and a turn would need a sign-in.
  const prompt = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise(() => {}),
      return: async () => ({ done: true, value: undefined }),
    }),
  }
  const query = sdk.query({
    prompt,
    options: {
      cwd,
      env,
      pathToClaudeCodeExecutable: program,
      settingSources: [],
      persistSession: false,
      stderr: (text) => log.add(text),
    },
  })
  let timer
  try {
    return await Promise.race([
      query.initializationResult(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new CheckFailure(`initialize had no answer within ${INITIALIZE_MS / 1000} s`)),
          INITIALIZE_MS,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
    query.close()
  }
}
