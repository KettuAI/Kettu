import { describe, expect, it, vi } from 'vitest'
import { DOCUMENT_CHARS, NOTE_CHARS, SOP_FILE_CHARS } from '@shared/tasks'
import { HostError, invalidParams } from '../errors'
import type { NodeReport, ReportAnswer } from './api'
import {
  CREATE_SOP_CALLS_PER_MINUTE,
  CREATE_SOP_TOOL,
  OUTCOME_CHARS,
  parseReport,
  parseSopFile,
  REPORT_CALLS_PER_MINUTE,
  REPORT_TOOL,
  TASK_TOOLS,
  TaskTools,
} from './report-tool'

const node = { taskId: 't-0123456789ab', runId: 'nr-0123456789ab', nodeId: 'build' }
const good = { outcome: 'built', note: 'Done.' }
const yaml = 'format: 1\nid: my-flow\n'

function tools(answer: ReportAnswer = { ok: true, next: 'Taken.' }) {
  let now = 1_000_000
  const report = vi.fn<(sessionId: string, report: NodeReport) => Promise<ReportAnswer>>(
    async () => answer,
  )
  const createSop = vi.fn<(text: string) => Promise<{ id: string; name: string }>>(async () => ({
    id: 'my-flow',
    name: 'My flow',
  }))
  const t = new TaskTools({
    nodeOf: (sessionId) => (sessionId === 'node' ? node : null),
    report,
    createSop,
    now: () => now,
  })
  return { t, report, createSop, tick: (ms: number) => (now += ms) }
}

const caller = { sessionId: 'node', project: '/repo', folder: '/wt' }
const other = { sessionId: 'other', project: '/repo' }

describe('the schemas', () => {
  it('take no argument they do not name', () => {
    for (const tool of TASK_TOOLS) expect(tool.inputSchema.additionalProperties).toBe(false)
  })
})

describe('parseReport', () => {
  it('takes the schema and nothing more', () => {
    expect(parseReport(good)).toEqual(good)
    expect(parseReport({ ...good, document: '# Design' })).toEqual({
      ...good,
      document: '# Design',
    })
    expect(parseReport({ ...good, document: '  \n' })).toEqual(good)
  })

  it('refuses what the schema does not allow', () => {
    const bad = (input: unknown) => expect(() => parseReport(input)).toThrow()
    bad(null)
    bad([])
    bad('built')
    bad({ ...good, extra: 1 })
    bad(JSON.parse('{"outcome":"built","note":"Done.","__proto__":{}}'))
    bad({ note: 'Done.' })
    bad({ ...good, outcome: '' })
    bad({ ...good, outcome: 3 })
    bad({ ...good, outcome: 'x'.repeat(OUTCOME_CHARS + 1) })
    bad({ outcome: 'built' })
    bad({ ...good, note: '' })
    bad({ ...good, note: '   ' })
    bad({ ...good, note: 'x'.repeat(NOTE_CHARS + 1) })
    bad({ ...good, document: 3 })
    bad({ ...good, document: null })
    bad({ ...good, document: 'x'.repeat(DOCUMENT_CHARS + 1) })
  })
})

describe('parseSopFile', () => {
  it('takes one text and nothing more', () => {
    expect(parseSopFile({ yaml })).toBe(yaml)
    const bad = (input: unknown) => expect(() => parseSopFile(input)).toThrow()
    bad(null)
    bad(yaml)
    bad({})
    bad({ yaml: '' })
    bad({ yaml: ' \n' })
    bad({ yaml: 3 })
    bad({ yaml, by: 'user' })
    bad({ yaml: 'x'.repeat(SOP_FILE_CHARS + 1) })
  })
})

describe('report_sop_node', () => {
  it("forwards an open node's report and answers with the engine's word", async () => {
    const { t, report } = tools()
    const result = await t.call(caller, REPORT_TOOL, good)
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: 'Taken.' }])
    expect(report).toHaveBeenCalledWith('node', good)
  })

  it("returns the engine's refusal as an error the agent can act on", async () => {
    const { t } = tools({ ok: false, error: 'Commit your changes first.' })
    const result = await t.call(caller, REPORT_TOOL, good)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Commit your changes first.' }])
  })

  it('refuses sessions that work on no node, subagents and calls off the schema', async () => {
    const { t, report } = tools()
    expect((await t.call(other, REPORT_TOOL, good)).isError).toBe(true)
    expect((await t.call({ ...caller, subagent: true }, REPORT_TOOL, good)).isError).toBe(true)
    expect((await t.call(caller, REPORT_TOOL, { ...good, verdict: 'pass' })).isError).toBe(true)
    expect(report).not.toHaveBeenCalled()
  })

  it('limits reports per minute', async () => {
    const { t, report, tick } = tools()
    for (let i = 0; i < REPORT_CALLS_PER_MINUTE; i++) await t.call(caller, REPORT_TOOL, good)
    expect((await t.call(caller, REPORT_TOOL, good)).isError).toBe(true)
    expect(report).toHaveBeenCalledTimes(REPORT_CALLS_PER_MINUTE)
    tick(60_001)
    expect((await t.call(caller, REPORT_TOOL, good)).isError).toBeUndefined()
  })
})

describe('create_sop', () => {
  it('saves from any session and says the SOP waits for approval', async () => {
    const { t, createSop } = tools()
    const result = await t.call(other, CREATE_SOP_TOOL, { yaml })
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toEqual({ id: 'my-flow', name: 'My flow', status: 'pending' })
    expect(JSON.stringify(result.content)).toContain('approval')
    expect(createSop).toHaveBeenCalledWith(yaml)
  })

  it("returns the library's refusal as an error and lets other failures through", async () => {
    const { t, createSop } = tools()
    createSop.mockRejectedValueOnce(invalidParams('The SOP is not valid: nodes: must be a list'))
    const refused = await t.call(other, CREATE_SOP_TOOL, { yaml })
    expect(refused.isError).toBe(true)
    expect(refused.content).toEqual([
      { type: 'text', text: 'The SOP is not valid: nodes: must be a list' },
    ])
    createSop.mockRejectedValueOnce(new HostError('internal', 'disk full'))
    await expect(t.call(other, CREATE_SOP_TOOL, { yaml })).rejects.toThrow('disk full')
  })

  it('refuses calls off the schema before the library sees them', async () => {
    const { t, createSop } = tools()
    expect((await t.call(other, CREATE_SOP_TOOL, { yaml, approve: true })).isError).toBe(true)
    expect((await t.call(other, CREATE_SOP_TOOL, {})).isError).toBe(true)
    expect(createSop).not.toHaveBeenCalled()
  })

  it('limits calls per minute, apart from reports', async () => {
    const { t, createSop, tick } = tools()
    for (let i = 0; i < CREATE_SOP_CALLS_PER_MINUTE; i++) {
      await t.call(caller, CREATE_SOP_TOOL, { yaml })
    }
    expect((await t.call(caller, CREATE_SOP_TOOL, { yaml })).isError).toBe(true)
    expect(createSop).toHaveBeenCalledTimes(CREATE_SOP_CALLS_PER_MINUTE)
    expect((await t.call(caller, REPORT_TOOL, good)).isError).toBeUndefined()
    expect((await t.call(other, CREATE_SOP_TOOL, { yaml })).isError).toBeUndefined()
    tick(60_001)
    expect((await t.call(caller, CREATE_SOP_TOOL, { yaml })).isError).toBeUndefined()
  })

  it('rejects a name it does not serve', async () => {
    const { t } = tools()
    await expect(t.call(caller, 'no_such_tool', good)).rejects.toThrow('Unknown tool')
  })
})
