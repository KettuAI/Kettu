import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentId } from '@shared/agents'
import type { Caller } from '../artifacts/tools'
import { MemoryService } from './service'
import {
  FORGET_MEMORY_TOOL,
  LIST_MEMORIES_TOOL,
  MEMORY_TOOL_NAMES,
  MEMORY_TOOLS,
  MemoryTools,
  READ_MEMORY_TOOL,
  REMEMBER_TOOL,
  UPDATE_MEMORY_TOOL,
  type MemoryToolsDeps,
} from './tools'

let dir: string
let service: MemoryService
let projectOf: Map<string, string | null>
let written: { sessionId: string; write: Parameters<MemoryToolsDeps['written']>[1] }[]
let proposed: { sessionId: string; proposal: Parameters<MemoryToolsDeps['proposed']>[1] }[]
let tools: MemoryTools

const A = '/work/a'
const B = '/work/b'
const inA = { sessionId: 'sa', project: A } as Caller
const inB = { sessionId: 'sb', project: B } as Caller
const loose = { sessionId: 'sx', project: '/scratch' } as Caller

function text(result: Awaited<ReturnType<MemoryTools['call']>>): string {
  return result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
}

const FACT = { title: 'Run tests', description: 'pnpm test', body: 'Run `pnpm test`.' }

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kettu-memory-tools-'))
  service = new MemoryService({
    root: path.join(dir, 'memory'),
    log: () => {},
    projects: () => [
      { path: A, name: 'A' },
      { path: B, name: 'B' },
    ],
    claudeAgents: () => [],
  })
  projectOf = new Map([
    ['sa', A],
    ['sb', B],
    ['sx', null],
  ])
  written = []
  proposed = []
  tools = new MemoryTools({
    service,
    projectOf: (caller) => projectOf.get(caller.sessionId) ?? null,
    written: (sessionId, write) => written.push({ sessionId, write }),
    proposed: (sessionId, proposal) => {
      proposed.push({ sessionId, proposal })
      return sessionId === 'closed' ? 'closed' : sessionId === 'busy' ? 'full' : 'added'
    },
    agentOf: () => 'codex' as AgentId,
  })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('MemoryTools', () => {
  it('lists every tool it serves', () => {
    expect(MEMORY_TOOLS.map((tool) => tool.name)).toEqual([...MEMORY_TOOL_NAMES])
  })

  it("writes a project entry into the caller's own project and reports it", async () => {
    const result = await tools.call(inA, REMEMBER_TOOL, FACT)
    expect(result.isError).toBeUndefined()
    const [entry] = await service.list({ layer: 'project', project: A })
    expect(entry).toMatchObject({ id: 'run-tests', source: { agentId: 'codex', sessionId: 'sa' } })
    expect(await service.list({ layer: 'project', project: B })).toEqual([])
    expect(written).toEqual([
      {
        sessionId: 'sa',
        write: {
          layer: 'project',
          action: 'remember',
          memoryId: 'run-tests',
          title: 'Run tests',
          undo: expect.any(String),
        },
      },
    ])
    expect(await service.undo(written[0]!.write.undo)).toBe('undone')
  })

  it("reaches no other project's memory", async () => {
    await tools.call(inA, REMEMBER_TOOL, FACT)
    const read = await tools.call(inB, READ_MEMORY_TOOL, { layer: 'project', id: 'run-tests' })
    expect(read.isError).toBe(true)
    const forget = await tools.call(inB, FORGET_MEMORY_TOOL, { layer: 'project', id: 'run-tests' })
    expect(forget.isError).toBe(true)
    expect(await service.list({ layer: 'project', project: A })).toHaveLength(1)
    const list = await tools.call(inB, LIST_MEMORIES_TOOL, {})
    expect(text(list)).not.toContain('run-tests')
  })

  it('updates and forgets project entries with a row each', async () => {
    await tools.call(inA, REMEMBER_TOOL, FACT)
    await tools.call(inA, UPDATE_MEMORY_TOOL, { layer: 'project', id: 'run-tests', body: 'New.' })
    expect((await service.get({ layer: 'project', project: A }, 'run-tests'))!.body).toBe('New.')
    await tools.call(inA, FORGET_MEMORY_TOOL, { layer: 'project', id: 'run-tests' })
    expect(await service.list({ layer: 'project', project: A })).toEqual([])
    expect(written.map((row) => row.write.action)).toEqual(['remember', 'update', 'forget'])
  })

  it('only proposes global writes, and writes nothing', async () => {
    await service.save(
      { layer: 'global' },
      null,
      { title: 'Tone', description: 'Short', body: 'Keep it short.' },
      { agentId: null, sessionId: null },
    )
    const remember = await tools.call(inA, REMEMBER_TOOL, { ...FACT, layer: 'global' })
    expect(remember.isError).toBeUndefined()
    expect(text(remember)).toContain('They decide in the thread')
    await tools.call(inA, UPDATE_MEMORY_TOOL, { layer: 'global', id: 'tone', body: 'Longer.' })
    await tools.call(inA, FORGET_MEMORY_TOOL, { layer: 'global', id: 'tone' })
    expect(proposed.map((call) => call.proposal)).toEqual([
      { action: 'remember', memoryId: null, title: 'Run tests', draft: FACT },
      {
        action: 'update',
        memoryId: 'tone',
        title: 'Tone',
        draft: { title: 'Tone', description: 'Short', body: 'Longer.' },
      },
      { action: 'forget', memoryId: 'tone', title: 'Tone', draft: null },
    ])
    expect(written).toEqual([])
    expect(await service.list({ layer: 'global' })).toMatchObject([
      { id: 'tone', body: 'Keep it short.' },
    ])
  })

  it('refuses a global proposal that would be refused when written', async () => {
    const secret = await tools.call(inA, REMEMBER_TOOL, {
      layer: 'global',
      title: 'Key',
      description: 'Key',
      body: 'AKIAIOSFODNN7EXAMPLE',
    })
    expect(secret.isError).toBe(true)
    expect(secret.structuredContent).toMatchObject({ code: 'secret' })
    expect(proposed).toEqual([])
  })

  it('refuses a global proposal while enough wait for the user', async () => {
    const busy = { sessionId: 'busy', project: A } as Caller
    const result = await tools.call(busy, REMEMBER_TOOL, { ...FACT, layer: 'global' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'full' })
    expect(text(result)).toContain('only after they answer')
  })

  it('gives a session without a project global memory only', async () => {
    const result = await tools.call(loose, REMEMBER_TOOL, FACT)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('only for things about the user')
    const global = await tools.call(loose, REMEMBER_TOOL, { ...FACT, layer: 'global' })
    expect(global.isError).toBeUndefined()
    expect(proposed).toHaveLength(1)
  })

  it('refuses every call while memory is off, and bad input', async () => {
    const bad = await tools.call(inA, REMEMBER_TOOL, { ...FACT, sessionId: 'sb' })
    expect(bad.isError).toBe(true)
    const badId = await tools.call(inA, READ_MEMORY_TOOL, { layer: 'project', id: '../x' })
    expect(badId.isError).toBe(true)
    await service.setEnabled(false)
    for (const name of MEMORY_TOOL_NAMES) {
      const result = await tools.call(inA, name, { layer: 'project', id: 'x', ...FACT })
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toMatchObject({ code: 'off' })
    }
    expect(await readdir(path.join(dir, 'memory'))).toEqual(['settings.json'])
  })
})
