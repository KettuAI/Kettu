// An ACP agent's handshake without a sign-in: `initialize`, then `session/new`, which an agent
// that needs a sign-in refuses with ACP's auth_required error. That refusal is where the check
// stops; any other error fails it.

import { brief, CheckFailure, expect, startRpc } from './common.mjs'

/** ACP's error for a request that needs the user to sign in first. */
const AUTH_REQUIRED = -32000

export async function acpHandshake(file, args, { version, ctx, env }) {
  ctx.step = 'initialize'
  const rpc = startRpc(file, args, { cwd: ctx.work, env, log: ctx.log })
  try {
    const init = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'Kettu', title: 'Kettu', version: '0.0.0' },
    })
    if (init.error) throw new CheckFailure(`initialize failed: ${brief(init.error)}`)
    const answer = init.result
    ctx.log.add(`initialize: ${brief(answer, 600)}`)
    expect(
      answer?.protocolVersion === 1,
      `initialize agreed on protocol ${brief(answer?.protocolVersion)}`,
    )
    const reported = answer.agentInfo?.version
    if (typeof reported === 'string') {
      // Muse Code reports its version without the release suffix, as 1.4.23 for 1.4.23-R8977.1.
      expect(
        reported === version || version.startsWith(`${reported}-`),
        `initialize reported version ${reported}, not ${version}`,
      )
    }

    ctx.step = 'session'
    const session = await rpc.request('session/new', { cwd: ctx.work, mcpServers: [] })
    if (session.result) {
      expect(
        typeof session.result.sessionId === 'string',
        `session/new gave no session: ${brief(session.result)}`,
      )
      ctx.log.add(`session/new: ${session.result.sessionId}, opened without a sign-in`)
    } else if (session.error?.code === AUTH_REQUIRED) {
      ctx.log.add(`session/new: ${brief(session.error)}; stops here: a session needs a sign-in`)
    } else {
      throw new CheckFailure(`session/new failed: ${brief(session.error)}`)
    }
  } finally {
    await rpc.close()
  }
}
