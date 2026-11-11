import { describe, expect, it } from 'vitest'
import type { AgentStage } from '@shared/tasks'
import type { StageEvidence, StageSubmission } from './api'
import { checkSubmission, commandRan } from './checks'

function stage(extra: Partial<AgentStage> = {}): AgentStage {
  return {
    kind: 'agent',
    id: 'build',
    name: 'Build',
    next: null,
    prompt: 'Build it.',
    tier: 'standard',
    scope: { level: 'commands', web: false },
    session: 'new',
    contract: [
      { name: 'commands', type: 'list', required: true, description: 'run' },
      { name: 'notes', type: 'text', required: false, description: 'anything' },
      { name: 'size', type: 'size', required: true, description: 'S, M or L' },
      { name: 'risk', type: 'risk', required: true, description: 'risky' },
    ],
    evidence: ['reported-commands-ran', 'changed-files'],
    gate: 'contract',
    ...extra,
  }
}

const evidence = (commands: string[], changedFiles: string[]): StageEvidence => ({
  commands,
  changedFiles,
  turns: 1,
})

const submission = (
  fields: StageSubmission['fields'],
  verdict: StageSubmission['verdict'] = 'pass',
): StageSubmission => ({ verdict, summary: 'Done.', fields })

const good = { commands: ['pnpm test'], size: 'M', risk: false }

describe('stage checks', () => {
  it('matches a reported command inside a ran one, whatever the spacing', () => {
    expect(commandRan('pnpm  test', ['cd app &&  pnpm test --run'])).toBe(true)
    expect(commandRan('pnpm test', ['pnpm lint'])).toBe(false)
    expect(commandRan('   ', ['pnpm test'])).toBe(false)
  })

  it('accepts a result that meets the contract and the evidence', () => {
    const result = checkSubmission(
      stage(),
      submission({ ...good, extra: 'dropped' }),
      evidence(['pnpm test'], ['a.ts']),
    )
    expect(result).toEqual({ ok: true, fields: good })
  })

  it('refuses missing and mistyped fields', () => {
    const ran = evidence(['pnpm test'], ['a.ts'])
    expect(checkSubmission(stage(), submission({ ...good, size: 'XL' }), ran).ok).toBe(false)
    expect(checkSubmission(stage(), submission({ ...good, risk: 'no' }), ran).ok).toBe(false)
    expect(checkSubmission(stage(), submission({ ...good, commands: 'pnpm test' }), ran).ok).toBe(
      false,
    )
    expect(checkSubmission(stage(), submission({ ...good, commands: [] }), ran).ok).toBe(false)
    expect(checkSubmission(stage(), submission({ ...good, notes: 3 as never }), ran).ok).toBe(false)
    const withoutSize: StageSubmission['fields'] = { ...good }
    delete withoutSize.size
    const missing = checkSubmission(stage(), submission(withoutSize), ran)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.error).toContain('"size" is missing')
    expect(checkSubmission(stage(), { ...submission(good), summary: '  ' }, ran)).toMatchObject({
      ok: false,
    })
  })

  it('refuses a result the session did not back', () => {
    expect(
      checkSubmission(stage(), submission(good), evidence(['pnpm lint'], ['a.ts'])),
    ).toMatchObject({ ok: false })
    expect(checkSubmission(stage(), submission(good), evidence(['pnpm test'], []))).toMatchObject({
      ok: false,
    })
    const anyCommand = stage({ evidence: ['ran-command'] })
    expect(checkSubmission(anyCommand, submission(good), evidence([], []))).toMatchObject({
      ok: false,
    })
    const readOnly = stage({ evidence: ['no-file-changes'] })
    expect(checkSubmission(readOnly, submission(good), evidence([], ['a.ts']))).toMatchObject({
      ok: false,
    })
    expect(checkSubmission(readOnly, submission(good), evidence([], []))).toMatchObject({
      ok: true,
    })
  })

  it('refuses changes from a stage without a rework edge', () => {
    const ran = evidence(['pnpm test'], ['a.ts'])
    expect(checkSubmission(stage(), submission(good, 'changes'), ran)).toMatchObject({ ok: false })
    const review = stage({ rework: { to: 'build', rounds: 2 } })
    expect(checkSubmission(review, submission(good, 'changes'), ran)).toMatchObject({ ok: true })
  })

  it('takes a blocked result with only a summary', () => {
    const result = checkSubmission(stage(), submission({ size: 'XL' }, 'blocked'), evidence([], []))
    expect(result).toEqual({ ok: true, fields: {} })
  })
})
