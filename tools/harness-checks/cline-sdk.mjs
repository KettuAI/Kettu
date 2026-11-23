// Cline's SDK, its preferred interface: installed from npm as the app installs `cline`, whose
// package brings the SDK, then Kettu's own connection loads it in Kettu's own process for it,
// lists the providers and asks for a session, which the SDK refuses as needing a sign-in.

import path from 'node:path'
import { brief, expect, harnessEnv, npmVersions } from './common.mjs'
import { candidateRange, choicesOf, hostedContext, step } from './hosted.mjs'
import { bundle } from './kettu.mjs'

export const clineSdk = {
  id: 'cline',
  protocol: 'cline-sdk',
  subject: (def) => `${def.name} SDK`,

  async versions(def) {
    const versions = await npmVersions(def.launch.package, candidateRange(def))
    const known = new Set(versions.map((entry) => entry.version))
    return { versions, inRange: (version) => known.has(version) }
  },

  async check(def, version, ctx) {
    ctx.step = 'install'
    const install = await ctx.installPackage(def.launch.package, version)
    ctx.requireNode(def)
    const host = await bundle('src/agent-host/cline/cline-host.ts', path.join(ctx.dir, 'host'))
    const env = await harnessEnv(ctx.home)
    const running = hostedContext(def, ctx, {
      spec: { command: process.execPath, args: [install.entry, ...def.launch.args] },
      env,
      nodeRuntime: { command: process.execPath, env: {} },
      clineHostPath: host,
    })
    const connection = new ctx.kettu.ClineConnection(running.context)
    try {
      const init = await step(ctx, 'initialize', () => connection.initialize())
      ctx.log.add(`initialize: ${brief({ version: init.version, core: init.raw?.core })}`)
      expect(init.version === version, `The SDK's package is ${brief(init.version)}`)
      ctx.log.add(`sign-ins: ${init.authMethods.map((method) => method.id).join(', ') || 'none'}`)

      // With no provider signed in or holding a key, the SDK refuses a session as needing one.
      const made = await step(ctx, 'session', () =>
        connection.newSession(ctx.work).catch((error) => {
          if (error?.kind === 'auth_required') return null
          throw error
        }),
      )
      if (!made) {
        ctx.log.add('the session answered that a sign-in is needed; stops here')
        return
      }
      const models = choicesOf(made.config, 'model')
      ctx.log.add(`opened session ${made.sessionId} with ${models.length} models`)
      await step(ctx, 'session', () => connection.closeSession(made.sessionId))
      ctx.log.add('closed it; stops here: a prompt needs a sign-in')
    } finally {
      connection.close()
      await running.stop()
    }
  },
}
