// What the Claude Code mapper makes of the SDK's messages, against the same thread model ACP fills.

import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { applyPatches, threadEntries, threadFromSnapshot, type ThreadState } from '@shared/thread'
import { newTurnScope, type MapperContext } from '../session-updates'
import { ClaudeMapper } from './mapper'
import type { SdkMessage } from './sdk'

function run(messages: Record<string, unknown>[]) {
  let thread: ThreadState = threadFromSnapshot({
    session: {
      id: 's',
      agentId: 'claude-code',
      projectPath: os.tmpdir(),
      acpSessionId: 'claude-1',
      status: 'running',
      title: null,
      config: [],
      commands: [],
      usage: null,
      error: null,
      turnStartedAt: null,
      turnStartUsed: null,
      createdAt: 0,
      updatedAt: 0,
      parentId: null,
      origin: 'user',
      subagent: null,
      routine: null,
      queue: [],
      queuePaused: false,
    },
    entries: [],
    seq: 0,
  })
  const mapper = new ClaudeMapper('claude-1', os.tmpdir())
  const scope = newTurnScope()
  let n = 0
  const patches: unknown[] = []
  for (const message of messages) {
    for (const delivery of mapper.live(message as unknown as SdkMessage) ?? []) {
      const ctx: MapperContext = {
        thread,
        replaying: false,
        cancelling: false,
        scope,
        now: 1_000,
        nextId: () => `e:${++n}`,
        sessionIdFor: () => null,
      }
      const out = delivery.map(ctx)
      patches.push(...out.patches)
      thread = applyPatches(thread, out.patches)
    }
  }
  return { entries: threadEntries(thread), patches }
}

const status = (uuid: string, extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'status',
  uuid,
  status: null,
  ...extra,
})
const compacting = (uuid: string) => status(uuid, { status: 'compacting' })
const settled = (uuid: string, result: 'success' | 'failed' = 'success', error?: string) =>
  status(uuid, { compact_result: result, ...(error ? { compact_error: error } : {}) })
const boundary = (uuid: string) => ({
  type: 'system',
  subtype: 'compact_boundary',
  uuid,
  compact_metadata: { trigger: 'manual', pre_tokens: 1_000 },
})

describe('a compaction', () => {
  it('is one entry when the result comes before the boundary', () => {
    const { entries } = run([compacting('a'), settled('b'), boundary('c')])
    expect(entries).toMatchObject([{ kind: 'compaction', id: 'c:a', status: 'completed' }])
  })

  it('is one entry when the boundary comes before the result', () => {
    const { entries } = run([compacting('a'), boundary('c'), settled('b')])
    expect(entries).toMatchObject([{ kind: 'compaction', id: 'c:a', status: 'completed' }])
  })

  it('is one entry from a boundary alone, as older Claude Code sends it', () => {
    const { entries } = run([boundary('c')])
    expect(entries).toMatchObject([{ kind: 'compaction', id: 'c:c', status: 'completed' }])
  })

  it('stays one entry when the status repeats', () => {
    const { entries } = run([compacting('a'), compacting('a2'), settled('b'), boundary('c')])
    expect(entries).toHaveLength(1)
  })

  it('completes once, so a count of completed compactions is not raised twice', () => {
    const { patches } = run([compacting('a'), settled('b'), boundary('c')])
    expect(patches.filter((patch) => JSON.stringify(patch).includes('completed'))).toHaveLength(1)
  })

  it('keeps each of two in a row as its own entry', () => {
    const { entries } = run([
      compacting('a'),
      settled('b'),
      boundary('c'),
      compacting('d'),
      settled('e'),
      boundary('f'),
    ])
    expect(entries).toMatchObject([
      { kind: 'compaction', id: 'c:a', status: 'completed' },
      { kind: 'compaction', id: 'c:d', status: 'completed' },
    ])
  })

  it('does not let a boundary alone after one that ended join it', () => {
    const { entries } = run([compacting('a'), settled('b'), boundary('c'), boundary('d')])
    expect(entries).toMatchObject([
      { kind: 'compaction', id: 'c:a', status: 'completed' },
      { kind: 'compaction', id: 'c:d', status: 'completed' },
    ])
  })

  it('ends as failed, with the error, and adds nothing else', () => {
    const { entries } = run([compacting('a'), settled('b', 'failed', 'too long')])
    expect(entries).toMatchObject([
      { kind: 'compaction', id: 'c:a', status: 'failed', summary: 'too long' },
    ])
  })
})
