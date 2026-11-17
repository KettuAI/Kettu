// DeepSeek Harness: installed from npm as the app installs it, then `dsh --profile sdk` answers
// `initialize` and runs a local command in a session without a sign-in; a prompt would need one.

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { brief, expect, harnessEnv, npmVersions, resultOf, startRpc } from './common.mjs'
import { rangeOf } from './kettu.mjs'

export const deepseek = {
  id: 'deepseek',
  subject: (def) => def.name,

  async versions(def) {
    const versions = await npmVersions(def.launch.package, rangeOf(def))
    const known = new Set(versions.map((entry) => entry.version))
    return { versions, inRange: (version) => known.has(version) }
  },

  async check(def, version, ctx) {
    ctx.step = 'install'
    const install = await ctx.installPackage(def.launch.package, version)
    ctx.requireNode(def)

    ctx.step = 'initialize'
    const env = await harnessEnv(ctx.home, {
      DSH_HOME: path.join(ctx.home, '.dsh'),
      DSH_PERMISSION_MODE: 'workspace-write',
    })
    const args = [install.entry, ...(def.launch.args ?? []), '--profile', 'sdk']
    const rpc = startRpc(process.execPath, args, { cwd: ctx.work, env, log: ctx.log })
    try {
      const init = resultOf(
        'initialize',
        await rpc.request('initialize', {
          cwd: ctx.work,
          approvalRequests: true,
          provider: 'deepseek-official',
          model: ctx.kettu.DEFAULT_MODEL,
          reasoningEffort: ctx.kettu.DEFAULT_EFFORT,
          capabilities: { userQuestions: true },
        }),
      )
      ctx.log.add(`initialize: ${brief(init)}`)
      expect(
        typeof init?.serverInfo?.name === 'string',
        `initialize gave no serverInfo: ${brief(init)}`,
      )

      ctx.step = 'session'
      const sessionId = randomUUID()
      const query = resultOf(
        'session/query',
        await rpc.request('session/query', {
          sessionId,
          contentBlocks: [{ type: 'text', text: '/plan' }],
        }),
      )
      ctx.log.add(`session/query /plan: ${brief(query)}`)
      expect(query?.kind === 'command', `/plan did not run as a command: ${brief(query)}`)
      const events = rpc.notifications.filter((message) => message.params?.sessionId === sessionId)
      expect(events.length > 0, 'The session sent no events')
      ctx.log.add(`${events.length} session events; stops here: a prompt needs a sign-in`)
      await rpc.request('shutdown', null, 10_000).catch(() => {})
    } finally {
      await rpc.close()
    }
  },
}
