// DeepSeek Harness: installed from npm as the app installs it, then Kettu's own listing reads the
// models dsh offers, `dsh --profile sdk` answers `initialize` on one of them and runs a local
// command in a session without a sign-in; a prompt would need one.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { brief, expect, harnessEnv, npmVersions, resultOf, startRpc } from './common.mjs'
import { rangeOf } from './kettu.mjs'

/** DeepSeek's own route, started on when the listing has it. */
const OFFICIAL = 'deepseek-official'

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

    const env = await harnessEnv(ctx.home, {
      DSH_HOME: path.join(ctx.home, '.dsh'),
      DSH_PERMISSION_MODE: 'workspace-write',
    })

    ctx.step = 'models'
    const models = await listModels(def, install, env, ctx)
    ctx.log.add(`${models.length} models listed`)
    const model =
      models.find((entry) => entry.provider === OFFICIAL) ??
      models[0] ??
      (await ownStart(def, install, env, ctx))
    ctx.log.add(`starting on ${model.provider} ${model.model}`)

    ctx.step = 'initialize'
    const args = [install.entry, ...(def.launch.args ?? []), '--profile', 'sdk']
    const rpc = startRpc(process.execPath, args, { cwd: ctx.work, env, log: ctx.log })
    try {
      const init = resultOf(
        'initialize',
        await rpc.request('initialize', {
          cwd: ctx.work,
          approvalRequests: true,
          provider: model.provider,
          model: model.model,
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

/**
 * The models dsh offers in a fresh home, read as the app reads them: dsh's ACP mode in a process of
 * its own whose session and storage go to a folder of the check's.
 */
async function listModels(def, install, env, ctx) {
  const own = path.join(ctx.dir, 'listing')
  await mkdir(own, { recursive: true })
  const patch = path.join(own, 'kettu.patch.yml')
  await writeFile(patch, ctx.kettu.listingRows(own))
  const args = [install.entry, ...(def.launch.args ?? []), '--profile', 'acp', '--patch', patch]
  ctx.log.add(`$ dsh ${args.slice(1).join(' ')}`)
  let stderr = ''
  const listing = await ctx.kettu.readListing({
    cwd: own,
    timeoutMs: 120_000,
    spawn: (stop) => {
      const child = spawn(process.execPath, args, {
        cwd: own,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        signal: stop,
      })
      child.on('error', () => {})
      child.stderr.setEncoding('utf8').on('data', (text) => (stderr += text))
      return child
    },
  })
  await listing.exited
  if (stderr.trim()) ctx.log.add(stderr.trim().split('\n').slice(-20).join('\n'))
  expect(listing.models, 'dsh gave no model list')
  return listing.models
}

/**
 * The model dsh starts a session on by itself. Without a sign-in its routes list no models, so the
 * app would ask for one; the check starts on dsh's own choice instead.
 */
async function ownStart(def, install, env, ctx) {
  const args = [install.entry, ...(def.launch.args ?? []), '--profile', 'acp']
  const rpc = startRpc(process.execPath, args, { cwd: ctx.work, env, log: ctx.log })
  try {
    resultOf(
      'initialize',
      await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {} }),
    )
    const opened = resultOf(
      'session/new',
      await rpc.request('session/new', { cwd: ctx.work, mcpServers: [] }),
    )
    const value = opened?.configOptions?.find((option) => option.id === 'model')?.currentValue
    const pair = typeof value === 'string' ? JSON.parse(value) : null
    expect(
      Array.isArray(pair) && pair.length === 2 && pair.every((part) => typeof part === 'string'),
      `dsh started its session on no model: ${brief(opened)}`,
    )
    return { provider: pair[0], model: pair[1] }
  } finally {
    await rpc.close()
  }
}
