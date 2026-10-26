// The host with an adapter that keeps one live session per process: behind the router, a third
// session and a load leave the running turns alone; on one process they end them unanswered.

import { describe, expect, it } from 'vitest'
import type { ThreadEntry } from '@shared/thread'
import { processLauncher } from '../agents'
import { startTestHost } from '../testing/harness'

function permissionTool(entries: ThreadEntry[]): Extract<ThreadEntry, { kind: 'tool' }> | null {
  for (const entry of entries) {
    if (entry.kind === 'tool' && entry.permission) return entry
  }
  return null
}

/** A Pi-replacement host whose agent keeps one live session per process, behind the router. */
async function start(options: { router: boolean }) {
  const t = await startTestHost({
    launcher: processLauncher(process.platform),
    agentEnv: { FAKE_AGENT_DELAY_SCALE: '0' },
    fakeThroughRouter: { agentIds: ['pi'], oneSession: true, router: options.router },
  })
  const port = t.connect()
  const create = async (): Promise<string> => {
    const summary = await port.request('sessions.create', {
      agentId: 'pi',
      projectPath: t.project,
    })
    await port.open(summary.id)
    return summary.id
  }
  /** Prompts a session with a command that asks for permission, and waits for the request. */
  const askPermission = async (sessionId: string): Promise<void> => {
    void port
      .request('sessions.prompt', {
        sessionId,
        content: [{ type: 'text', text: '/permission' }],
      })
      .catch(() => {})
    await port.untilEntry(sessionId, (entry) => entry.kind === 'tool' && !!entry.permission)
  }
  return { t, port, create, askPermission }
}

describe('the host behind the session router', () => {
  it('leaves two running turns alone while a third session starts and an old one loads', async () => {
    const { t, port, create, askPermission } = await start({ router: true })
    try {
      const first = await create()
      const second = await create()
      await askPermission(first)
      await askPermission(second)
      // A third session and an imported one each get a process of their own.
      await create()
      const listed = await port.request('agents.listSessions', {
        agentId: 'pi',
        projectPath: t.project,
      })
      const old = listed.sessions.find((session) => !session.imported)!
      const imported = await port.request('sessions.import', {
        agentId: 'pi',
        projectPath: t.project,
        acpSessionId: old.acpSessionId,
      })
      await port.open(imported.id)

      // Both earlier turns still wait for their answer, and end as asked.
      for (const sessionId of [first, second]) {
        const tool = permissionTool(port.entries(sessionId))!
        await port.request('permissions.respond', {
          sessionId,
          requestId: tool.permission!.requestId,
          optionId: tool.permission!.options[0]!.id,
        })
      }
      for (const sessionId of [first, second]) {
        await port.untilEntry(sessionId, (entry) => entry.kind === 'turn_end')
        expect(port.entries(sessionId).find((entry) => entry.kind === 'turn_end')).toMatchObject({
          stopReason: 'end_turn',
        })
      }
    } finally {
      await t.stop()
    }
  }, 60_000)

  it('leaves the turn unanswered on one process for every session, which is what the router is for', async () => {
    const { t, port, create, askPermission } = await start({ router: false })
    try {
      // One live session at a time here: each `session/new` ends the one before it.
      const first = await create()
      await askPermission(first)
      const second = await create()
      await askPermission(second)
      // The third session's `session/new`, and an old session's load, end the second session too.
      await create()
      const listed = await port.request('agents.listSessions', {
        agentId: 'pi',
        projectPath: t.project,
      })
      const old = listed.sessions.find((session) => !session.imported)!
      const imported = await port.request('sessions.import', {
        agentId: 'pi',
        projectPath: t.project,
        acpSessionId: old.acpSessionId,
      })
      await port.open(imported.id)
      // Answered, the earlier turns never answer: their process is gone.
      for (const sessionId of [first, second]) {
        const tool = permissionTool(port.entries(sessionId))
        if (!tool?.permission) continue
        await port.request('permissions.respond', {
          sessionId,
          requestId: tool.permission.requestId,
          optionId: tool.permission.options[0]!.id,
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
      for (const sessionId of [first, second]) {
        expect(port.entries(sessionId).some((entry) => entry.kind === 'turn_end')).toBe(false)
      }
    } finally {
      await t.stop()
    }
  }, 60_000)
})
