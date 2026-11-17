// Codex: Kettu runs the user's own `codex`, so the check installs a new version from npm as a
// user would, compares the protocol schema it writes with the cut the mapping is written against,
// and starts `codex app-server`, which answers `initialize`, `model/list` and an ephemeral
// `thread/start` without a sign-in; a turn would need one.

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import {
  brief,
  CheckFailure,
  expect,
  harnessEnv,
  npmVersions,
  resultOf,
  runProgram,
  startRpc,
} from './common.mjs'
import { compareBundle, generateArgs, readBundle, readCut } from './codex-schema.mjs'
import { rangeOf } from './kettu.mjs'

export const codex = {
  id: 'codex',
  subject: (def) => def.name,

  async versions(def) {
    const versions = await npmVersions(def.installs.npm, rangeOf(def))
    const known = new Set(versions.map((entry) => entry.version))
    return { versions, inRange: (version) => known.has(version) }
  },

  async check(def, version, ctx) {
    ctx.step = 'install'
    const install = await ctx.installPackage(def.installs.npm, version)
    const env = await harnessEnv(ctx.home, { CODEX_HOME: path.join(ctx.home, '.codex') })
    await mkdir(env.CODEX_HOME, { recursive: true })
    const run = (args) =>
      runProgram(process.execPath, [install.entry, ...args], { cwd: ctx.work, env, log: ctx.log })
    const reported = (await run(['--version'])).trim()
    expect(reported === `codex-cli ${version}`, `codex --version printed ${brief(reported)}`)

    ctx.step = 'schema'
    const out = path.join(ctx.dir, 'schema')
    await run(generateArgs(out))
    const missing = compareBundle(await readCut(), await readBundle(out))
    if (missing.length > 0) {
      throw new CheckFailure(
        `The protocol no longer has what the mapping reads: ${missing.join(', ')}`,
      )
    }
    ctx.log.add('The protocol has every method, field and value the mapping reads')

    ctx.step = 'initialize'
    const rpc = startRpc(process.execPath, [install.entry, 'app-server'], {
      cwd: ctx.work,
      env,
      log: ctx.log,
    })
    try {
      const init = resultOf(
        'initialize',
        await rpc.request('initialize', {
          clientInfo: { name: 'Kettu', title: 'Kettu', version: '0.0.0' },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }),
      )
      ctx.log.add(`initialize: ${brief(init?.userAgent)}`)
      const served = /^[^/\s]+\/(\S+)/.exec(init?.userAgent ?? '')?.[1]
      expect(served === version, `initialize reported Codex ${brief(served)}, not ${version}`)
      expect(typeof init.codexHome === 'string', `initialize gave no codexHome: ${brief(init)}`)

      ctx.step = 'models'
      const models = resultOf('model/list', await rpc.request('model/list', {}))
      const listed = Array.isArray(models?.data) ? models.data : []
      ctx.log.add(`model/list: ${listed.map((model) => model.id).join(', ')}`)
      expect(
        listed.length > 0 && listed.every((model) => typeof model.id === 'string'),
        `model/list listed no models: ${brief(models)}`,
      )

      ctx.step = 'thread'
      const started = resultOf(
        'thread/start',
        await rpc.request('thread/start', { cwd: ctx.work, ephemeral: true }),
      )
      expect(
        typeof started?.thread?.id === 'string',
        `thread/start gave no thread: ${brief(started)}`,
      )
      ctx.log.add(`thread/start: ${started.thread.id}, stops here: a turn needs a sign-in`)
    } finally {
      await rpc.close()
    }
  },
}
