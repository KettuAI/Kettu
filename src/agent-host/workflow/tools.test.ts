import { describe, expect, it } from 'vitest'
import type { WorkflowEntry } from '@shared/workflow'
import type { ReportResult } from './engine'
import { WorkflowTools } from './tools'

const ENTRY = {
  id: 'feature-development',
  source: 'community',
  name: 'Feature development',
  workflow: { description: 'Build a feature', steps: [] },
  problems: [],
  approval: 'approved',
  hash: 'h',
  origin: null,
  file: '/w/feature-development.yaml',
  addedAt: 1,
  pins: {},
} as unknown as WorkflowEntry

function tools(options: { suggest?: boolean } = {}) {
  const reports: string[] = []
  const deps = {
    library: {
      suggest: options.suggest ?? true,
      list: async () => [ENTRY],
      create: async () => ({ problems: [{ at: 'steps', message: 'must list at least one step' }] }),
    },
    marketplace: {
      publicWorkflows: async () => ({ status: 'signed_out' as const, items: [] }),
    },
    report: async (sessionId: string): Promise<ReportResult> => {
      reports.push(sessionId)
      return { accepted: true, checks: [], next: { kind: 'review' }, facts: null }
    },
    pick: async () => ({ accepted: true, checks: [], next: { kind: 'start' as const, steps: [] } }),
    isStep: (sessionId: string) => sessionId === 'step',
    agentOf: () => 'claude-code' as const,
  }
  return { tools: new WorkflowTools(deps), reports }
}

const caller = (sessionId: string, subagent = false) => ({
  sessionId,
  project: '/repo',
  ...(subagent ? { subagent } : {}),
})

describe('the workflow tools', () => {
  it("refuse the step's tools to a session that does not work on a step", async () => {
    const { tools: t, reports } = tools()
    const result = await t.call(caller('plain'), 'report_step', { outcome: 'Done' })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ code: 'not_allowed' })
    const pick = await t.call(caller('plain'), 'pick_step_agents', {
      picks: [{ step: 'a', agent: 'codex', reason: 'x' }],
    })
    expect(pick.isError).toBe(true)
    expect(reports).toEqual([])
  })

  it('refuse a subagent, and a step session anything but its own two tools', async () => {
    const { tools: t, reports } = tools()
    const sub = await t.call(caller('step', true), 'report_step', {})
    expect(sub.structuredContent).toMatchObject({ code: 'not_allowed' })
    const suggest = await t.call(caller('step'), 'suggest_workflow', {
      workflow_id: 'feature-development',
      task: 'x',
      pace: 'quick',
    })
    expect(suggest.structuredContent).toMatchObject({ code: 'not_allowed' })
    const own = await t.call(caller('step'), 'report_step', { outcome: 'Done' })
    expect(own.isError).toBeUndefined()
    expect(reports).toEqual(['step'])
  })

  it('list a step session only its own tools, and the others only what suggestions allow', () => {
    expect(
      tools()
        .tools.listed('step')
        .map((tool) => tool.name),
    ).toEqual(['report_step', 'pick_step_agents'])
    expect(
      tools()
        .tools.listed('plain')
        .map((tool) => tool.name),
    ).toEqual(['list_workflows', 'suggest_workflow', 'create_workflow'])
    expect(
      tools({ suggest: false })
        .tools.listed('plain')
        .map((tool) => tool.name),
    ).toEqual(['create_workflow'])
  })

  it('suggest only a workflow that can be started, and refuse while suggestions are off', async () => {
    const on = tools().tools
    const result = await on.call(caller('plain'), 'suggest_workflow', {
      workflow_id: 'feature-development',
      task: 'Add export',
      pace: 'thorough',
      pace_reason: 'It must hold',
    })
    expect(result.structuredContent).toMatchObject({
      suggestion: { workflow_id: 'feature-development', pace: 'thorough' },
    })
    const unknown = await on.call(caller('plain'), 'suggest_workflow', {
      workflow_id: 'nope',
      task: 'x',
      pace: 'quick',
    })
    expect(unknown.structuredContent).toMatchObject({ code: 'not_found' })
    const off = await tools({ suggest: false }).tools.call(caller('plain'), 'list_workflows', {})
    expect(off.structuredContent).toMatchObject({ code: 'not_allowed' })
  })

  it('hand a workflow with problems back to its agent with each problem', async () => {
    const result = await tools().tools.call(caller('plain'), 'create_workflow', {
      yaml: 'format: 1',
    })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toMatchObject({ saved: false })
    expect((result.content[0] as { text: string }).text).toContain(
      'steps: must list at least one step',
    )
  })
})
