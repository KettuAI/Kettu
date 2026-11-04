import { describe, expect, it, vi } from 'vitest'
import { MAX_STEPS, PlanTools, PLAN_CALLS_PER_MINUTE, parseSteps, STEP_CHARS } from './plan-tool'

const caller = { sessionId: 's1', project: '/p' }
const step = (content: string, status = 'pending') => ({ content, status })

describe('the plan tool arguments', () => {
  it('takes steps of one line each, with a status', () => {
    expect(
      parseSteps({ steps: [step('Read\n  the  code', 'completed'), step('Fix', 'in_progress')] }),
    ).toEqual([
      { content: 'Read the code', priority: 'medium', status: 'completed' },
      { content: 'Fix', priority: 'medium', status: 'in_progress' },
    ])
  })

  it.each([
    ['no arguments', undefined],
    ['an array', []],
    ['an unknown argument', { steps: [step('a')], extra: 1 }],
    ['no steps', { steps: [] }],
    ['too many steps', { steps: Array.from({ length: MAX_STEPS + 1 }, () => step('a')) }],
    ['a step that is no object', { steps: ['a'] }],
    ['a step with an unknown field', { steps: [{ ...step('a'), id: 1 }] }],
    ['a blank step', { steps: [step('  \n ')] }],
    ['a step that is too long', { steps: [step('a'.repeat(STEP_CHARS + 1))] }],
    ['an unknown status', { steps: [step('a', 'done')] }],
  ])('refuses %s', (_, input) => {
    expect(() => parseSteps(input)).toThrow()
  })
})

describe('the plan tool', () => {
  function tools(now = () => 0) {
    const set = vi.fn(() => true)
    return { set, tools: new PlanTools({ set, now }) }
  }

  it('writes the plan and says how far it is and what comes next', () => {
    const { set, tools: plan } = tools()
    const result = plan.call(caller, 'set_plan', {
      steps: [step('Read', 'completed'), step('Fix', 'in_progress'), step('Test')],
    })
    expect(set).toHaveBeenCalledWith('s1', [
      { content: 'Read', priority: 'medium', status: 'completed' },
      { content: 'Fix', priority: 'medium', status: 'in_progress' },
      { content: 'Test', priority: 'medium', status: 'pending' },
    ])
    expect(result.structuredContent).toEqual({ done: 1, total: 3, next: 'Fix' })
    expect(result.isError).toBeUndefined()
  })

  it('says so when every step is done', () => {
    const result = tools().tools.call(caller, 'set_plan', { steps: [step('Read', 'completed')] })
    expect(result.structuredContent).toEqual({ done: 1, total: 1, next: null })
  })

  it('refuses an invalid list with text, and writes nothing', () => {
    const { set, tools: plan } = tools()
    const result = plan.call(caller, 'set_plan', { steps: [] })
    expect(result.isError).toBe(true)
    expect(set).not.toHaveBeenCalled()
  })

  it('refuses a subagent that is no session of its own', () => {
    const { set, tools: plan } = tools()
    const result = plan.call({ ...caller, subagent: true }, 'set_plan', { steps: [step('a')] })
    expect(result.isError).toBe(true)
    expect(set).not.toHaveBeenCalled()
  })

  it('refuses a session Kettu holds no thread for', () => {
    const plan = new PlanTools({ set: () => false })
    expect(plan.call(caller, 'set_plan', { steps: [step('a')] }).isError).toBe(true)
  })

  it('limits the calls of a session in a minute, and counts them again after it', () => {
    let at = 0
    const { tools: plan } = tools(() => at)
    const call = () => plan.call(caller, 'set_plan', { steps: [step('a')] })
    for (let i = 0; i < PLAN_CALLS_PER_MINUTE; i++) expect(call().isError).toBeUndefined()
    expect(call().isError).toBe(true)
    at = 60_001
    expect(call().isError).toBeUndefined()
  })
})
