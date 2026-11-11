import { describe, expect, it, vi } from 'vitest'
import type { StageSubmission, SubmitAnswer } from './api'
import {
  FIELD_TEXT_CHARS,
  MAX_FIELDS,
  parseSubmission,
  SUBMIT_CALLS_PER_MINUTE,
  SUBMIT_TOOL,
  SUMMARY_CHARS,
  SubmitTools,
} from './submit-tool'

const stage = { taskId: 't-0123456789ab', runId: 'sr-0123456789ab', stageId: 'build' }
const good = { verdict: 'pass', summary: 'Done.', fields: { tests: ['pnpm test'], risk: false } }

function tools(answer: SubmitAnswer = { ok: true, next: 'Accepted.' }) {
  let now = 1_000_000
  const submit = vi.fn<(sessionId: string, submission: StageSubmission) => Promise<SubmitAnswer>>(
    async () => answer,
  )
  const t = new SubmitTools({
    stageOf: (sessionId) => (sessionId === 'stage' ? stage : null),
    submit,
    now: () => now,
  })
  return { t, submit, tick: (ms: number) => (now += ms) }
}

const caller = { sessionId: 'stage', project: '/repo', folder: '/wt' }

describe('parseSubmission', () => {
  it('takes the schema and nothing more', () => {
    expect(parseSubmission({ ...good, escalate: true })).toEqual({ ...good, escalate: true })
    expect(parseSubmission(good)).toEqual(good)
  })

  it('refuses what the schema does not allow', () => {
    const bad = (input: unknown) => expect(() => parseSubmission(input)).toThrow()
    bad(null)
    bad([])
    bad({ ...good, extra: 1 })
    bad({ ...good, verdict: 'done' })
    bad({ ...good, summary: '' })
    bad({ ...good, summary: '   ' })
    bad({ ...good, summary: 'x'.repeat(SUMMARY_CHARS + 1) })
    bad({ ...good, fields: [] })
    bad({ ...good, fields: { n: 3 } })
    bad({ ...good, fields: { n: null } })
    bad({ ...good, fields: { n: [1] } })
    bad({ ...good, fields: { n: 'x'.repeat(FIELD_TEXT_CHARS + 1) } })
    bad({ ...good, fields: { 'bad name': 'x' } })
    bad({ ...good, fields: { __proto__x: 'x' } })
    bad({
      ...good,
      fields: Object.fromEntries(Array.from({ length: MAX_FIELDS + 1 }, (_, i) => [`f${i}`, 'x'])),
    })
    bad({ ...good, escalate: 'yes' })
  })
})

describe('SubmitTools', () => {
  it("forwards a current stage's submission and answers with the engine's word", async () => {
    const { t, submit } = tools()
    const result = await t.call(caller, SUBMIT_TOOL, good)
    expect(result.isError).toBeUndefined()
    expect(result.content).toEqual([{ type: 'text', text: 'Accepted.' }])
    expect(submit).toHaveBeenCalledWith('stage', good)
  })

  it("returns the engine's refusal as an error the agent can act on", async () => {
    const { t } = tools({ ok: false, error: 'tests is required.' })
    const result = await t.call(caller, SUBMIT_TOOL, good)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'tests is required.' }])
  })

  it('refuses sessions that are not a current stage, and subagents', async () => {
    const { t, submit } = tools()
    expect((await t.call({ ...caller, sessionId: 'other' }, SUBMIT_TOOL, good)).isError).toBe(true)
    expect((await t.call({ ...caller, subagent: true }, SUBMIT_TOOL, good)).isError).toBe(true)
    expect((await t.call(caller, SUBMIT_TOOL, { ...good, verdict: 'x' })).isError).toBe(true)
    expect(submit).not.toHaveBeenCalled()
  })

  it('limits submissions per minute', async () => {
    const { t, submit, tick } = tools()
    for (let i = 0; i < SUBMIT_CALLS_PER_MINUTE; i++) await t.call(caller, SUBMIT_TOOL, good)
    const limited = await t.call(caller, SUBMIT_TOOL, good)
    expect(limited.isError).toBe(true)
    expect(submit).toHaveBeenCalledTimes(SUBMIT_CALLS_PER_MINUTE)
    tick(60_001)
    expect((await t.call(caller, SUBMIT_TOOL, good)).isError).toBeUndefined()
  })
})
