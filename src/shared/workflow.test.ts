import { describe, expect, it } from 'vitest'
import { usableWorkflow, type WireWorkflowEntry, type Workflow } from './workflow'

const entry = (approval: WireWorkflowEntry['approval']) => ({
  workflow: { name: 'Fix a bug', steps: [] } as unknown as Workflow,
  problems: [],
  approval,
})

describe('usableWorkflow', () => {
  it('takes an approved workflow and one an older host shipped with, and nothing else', () => {
    expect(usableWorkflow(entry('approved'))).toBe(true)
    expect(usableWorkflow(entry('official'))).toBe(true)
    expect(usableWorkflow(entry('pending'))).toBe(false)
    expect(usableWorkflow(entry('changed'))).toBe(false)
    expect(usableWorkflow({ ...entry('official'), workflow: null })).toBe(false)
    expect(
      usableWorkflow({ ...entry('official'), problems: [{ at: 'name', message: 'is empty' }] }),
    ).toBe(false)
  })
})
