import { describe, expect, it } from 'vitest'
import type { SopEntry } from '@shared/sop'
import type { ReportResult } from './engine'
import { SopTools } from './tools'

const ENTRY = {
  id: 'feature-development',
  source: 'official',
  name: 'Feature development',
  sop: { description: 'Build a feature', steps: [] },
  problems: [],
  approval: 'official',
  hash: 'h',
  origin: null,
  file: null,
  addedAt: null,
  pins: {},
} as unknown as SopEntry

function tools(options: { suggest?: boolean } = {}) {
  const reports: string[] = []
  const deps = {
    library: {
      suggest: options.suggest ?? true,
      list: async () => [ENTRY],
      create: async () => ({ problems: [{ at: 'steps', message: 'must list at least one step' }] }),
    },
    report: async (sessionId: string): Promise<ReportResult> => {
      reports.push(sessionId)
      return { accepted: true, checks: [], next: { kind: 'review' }, facts: null }
    },
    pick: async () => ({ accepted: true, checks: [], next: { kind: 'start' as const, steps: [] } }),
    isStep: (sessionId: string) => sessionId === 'step',
    agentOf: () => 'claude-code' as const,
  }
  return { tools: new SopTools(deps), reports }
}

const caller = (sessionId: string, subagent = false) => ({
  sessionId,
  project: '/repo',
  ...(subagent ? { subagent } : {}),
})

describe('the SOP tools', () => {
  it("refuse the step's tools to a session that does not work on a step", async () => {
    const { tools: t, reports } = tools()
    const result = await t.call(caller('plain'), 'sop_report', { outcome: 'Done' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'not_allowed' })
    const pick = await t.call(caller('plain'), 'sop_pick', {
      picks: [{ step: 'a', agent: 'codex', reason: 'x' }],
    })
    expect(pick.isError).toBe(true)
    expect(reports).toEqual([])
  })

  it('refuse a subagent, and a step session anything but its own two tools', async () => {
    const { tools: t, reports } = tools()
    const sub = await t.call(caller('step', true), 'sop_report', {})
    expect(sub.structuredContent).toMatchObject({ code: 'not_allowed' })
    const suggest = await t.call(caller('step'), 'start_sop', {
      sop_id: 'feature-development',
      task: 'x',
      pace: 'quick',
    })
    expect(suggest.structuredContent).toMatchObject({ code: 'not_allowed' })
    const own = await t.call(caller('step'), 'sop_report', { outcome: 'Done' })
    expect(own.isError).toBeUndefined()
    expect(reports).toEqual(['step'])
  })

  it('list a step session only its own tools, and the others only what suggestions allow', () => {
    expect(
      tools()
        .tools.listed('step')
        .map((tool) => tool.name),
    ).toEqual(['sop_report', 'sop_pick'])
    expect(
      tools()
        .tools.listed('plain')
        .map((tool) => tool.name),
    ).toEqual(['list_sops', 'start_sop', 'create_sop'])
    expect(
      tools({ suggest: false })
        .tools.listed('plain')
        .map((tool) => tool.name),
    ).toEqual(['create_sop'])
  })

  it('suggest only an SOP that can be started, and refuse while suggestions are off', async () => {
    const on = tools().tools
    const result = await on.call(caller('plain'), 'start_sop', {
      sop_id: 'feature-development',
      task: 'Add export',
      pace: 'thorough',
      pace_reason: 'It must hold',
    })
    expect(result.structuredContent).toMatchObject({
      suggestion: { sop_id: 'feature-development', pace: 'thorough' },
    })
    const unknown = await on.call(caller('plain'), 'start_sop', {
      sop_id: 'nope',
      task: 'x',
      pace: 'quick',
    })
    expect(unknown.structuredContent).toMatchObject({ code: 'not_found' })
    const off = await tools({ suggest: false }).tools.call(caller('plain'), 'list_sops', {})
    expect(off.structuredContent).toMatchObject({ code: 'not_allowed' })
  })

  it('hand an SOP with problems back to its agent with each problem', async () => {
    const result = await tools().tools.call(caller('plain'), 'create_sop', { yaml: 'format: 1' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ saved: false })
    expect((result.content[0] as { text: string }).text).toContain(
      'steps: must list at least one step',
    )
  })
})
