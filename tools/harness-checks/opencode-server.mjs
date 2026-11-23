// OpenCode's own server, its preferred interface: Kettu runs the user's own `opencode`, so the
// check installs a version from npm as a user may, and Kettu's own connection starts
// `opencode serve --stdio` on it, reads a folder's models and agents, and makes and deletes a
// session, none of which needs a sign-in; a prompt, and any model, would need one.

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { brief, expect, harnessEnv, npmVersions, runProgram } from './common.mjs'
import { candidateRange, choicesOf, hostedContext, step } from './hosted.mjs'

// The names of OpenCode's platform packages, whose binary its postinstall copies into place.
const PLATFORMS = { darwin: 'darwin', linux: 'linux', win32: 'windows' }

export const opencodeServer = {
  id: 'opencode',
  protocol: 'opencode-server',
  subject: (def) => `${def.name} server`,

  async versions(def) {
    const versions = await npmVersions(def.installs.npm, candidateRange(def))
    const known = new Set(versions.map((entry) => entry.version))
    return { versions, inRange: (version) => known.has(version) }
  },

  async check(def, version, ctx) {
    ctx.step = 'install'
    const program = await install(def, version, ctx)
    const env = await harnessEnv(ctx.home)
    const running = hostedContext(def, ctx, {
      spec: { command: program, args: def.launch.args ?? [] },
      env,
    })
    const connection = new ctx.kettu.OpenCodeConnection(running.context)
    try {
      const init = await step(ctx, 'initialize', () => connection.initialize('harness-check'))
      ctx.log.add(`initialize: ${brief({ name: init.name, version: init.version })}`)
      expect(init.version === version, `The server named its version ${brief(init.version)}`)

      const listed = await step(ctx, 'options', () =>
        connection.newSession(ctx.work, { hidden: 'options' }),
      )
      // Without a sign-in no provider has models, so only the agents must be there.
      const models = listed.config.find((entry) => entry.category === 'model')?.choices ?? []
      const agents = choicesOf(listed.config, 'mode')
      ctx.log.add(`${models.length} models; agents ${agents.join(', ')}`)
      expect(agents.includes('build'), `The folder has no build agent: ${agents.join(', ')}`)

      const made = await step(ctx, 'session', () => connection.newSession(ctx.work))
      ctx.log.add(`made session ${made.sessionId}`)
      await step(ctx, 'session', () => connection.deleteSession(made.sessionId))
      ctx.log.add('deleted it; stops here: a prompt needs a sign-in')
    } finally {
      connection.close()
      await running.stop()
    }
  },
}

/**
 * Installs the package without its install script, as every check does, and takes the binary
 * from the platform package that script would copy, checking it is the same version.
 */
async function install(def, version, ctx) {
  const npm = await ctx.kettu.findCommand('npm', {
    platform: process.platform,
    env: process.env,
    isExecutable: (file) => ctx.kettu.isExecutableFile(file, process.platform),
  })
  expect(npm, 'npm is not on PATH')
  const dir = path.join(ctx.dir, 'install')
  await mkdir(dir, { recursive: true })
  await runProgram(
    npm,
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      dir,
      `${def.installs.npm}@${version}`,
    ],
    { cwd: dir, env: process.env, log: ctx.log, timeoutMs: 15 * 60_000 },
  )
  const name = `${def.installs.npm}-${PLATFORMS[process.platform] ?? process.platform}-${process.arch}`
  const packageDir = path.join(dir, 'node_modules', ...name.split('/'))
  const manifest = JSON.parse(
    await readFile(path.join(packageDir, 'package.json'), 'utf8').catch(() => 'null'),
  )
  expect(manifest, `npm installed no ${name}`)
  expect(manifest.version === version, `${name} is ${manifest.version}, not ${version}`)
  const program = path.join(
    packageDir,
    'bin',
    process.platform === 'win32' ? 'opencode.exe' : 'opencode',
  )
  ctx.log.add(`installed ${name}`)
  return program
}
