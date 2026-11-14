import { describe, expect, it, vi } from 'vitest'
import type { Caller } from './artifacts/tools'
import {
  SessionTools,
  type SessionToolsDeps,
  type ToolDelivery,
  type ToolSession,
} from './session-tools'

const caller: Caller = { sessionId: 'starter', project: '/repo' }

function session(id: string, startedBy: string | null): ToolSession {
  return {
    id,
    title: id,
    agentId: 'codex',
    status: 'running',
    updatedAt: 0,
    createdAt: 0,
    parentId: startedBy,
    startedBy,
    archived: false,
    projectPath: '/repo',
  }
}

function tools(delivery: ToolDelivery = { delivered: 'queued' }) {
  const sessions = [session('starter', null), session('started', 'starter'), session('other', null)]
  const send = vi.fn<SessionToolsDeps['send']>(async () => delivery)
  const deps = {
    info: (id: string) => sessions.find((item) => item.id === id) ?? null,
    name: () => 'Starter',
    send,
  } as unknown as SessionToolsDeps
  return { tools: new SessionTools(deps), send }
}

describe('send_message now', () => {
  it('queues by default', async () => {
    const { tools: t, send } = tools()
    const out = await t.call(caller, 'send_message', { id: 'started', text: 'hi' })
    expect(out.isError).toBeUndefined()
    expect(send).toHaveBeenCalledWith('started', 'hi', expect.anything(), false)
  })

  it('passes now to the host and reports how it went in', async () => {
    const { tools: t, send } = tools({ delivered: 'steered' })
    const out = await t.call(caller, 'send_message', { id: 'started', text: 'stop', now: true })
    expect(send).toHaveBeenCalledWith('started', 'stop', expect.anything(), true)
    expect(out.structuredContent).toEqual({ id: 'started', delivered: 'steered' })
  })

  it('says why a message asked to go now was queued', async () => {
    const { tools: t } = tools({ delivered: 'queued', reason: 'its turn was ending' })
    const out = await t.call(caller, 'send_message', { id: 'started', text: 'x', now: true })
    expect(out.structuredContent).toEqual({
      id: 'started',
      delivered: 'queued',
      reason: 'its turn was ending',
    })
  })

  it('rejects a now that is not a boolean', async () => {
    const { tools: t, send } = tools()
    const out = await t.call(caller, 'send_message', { id: 'started', text: 'x', now: 'yes' })
    expect(out.isError).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('never sends now to a session the caller did not start', async () => {
    const { tools: t, send } = tools()
    const out = await t.call(caller, 'send_message', { id: 'other', text: 'x', now: true })
    expect(out.isError).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })
})
