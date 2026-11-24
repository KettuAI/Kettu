import { describe, expect, it } from 'vitest'
import { WORKFLOW_DESCRIPTION_CHARS, outcomeName, stepName, workflowText } from '@shared/workflow'
import { parseWorkflow, workflowHash, toolProblems } from './format'

const STEPS = `
steps:
  - id: build
    name: Build
    prompt: Build it.
    outcomes:
      - name: Done
        to: review
  - id: review
    name: Review
    prompt: Review it.
    hand_in: outcome
    review_of: [build]
    outcomes:
      - name: Approved
        end: done
      - name: Changes needed
        to: build
`

const workflow = (body: string, head = 'format: 1\nname: Test\n') => head + body

function problemsOf(text: string): string[] {
  const read = parseWorkflow(text)
  return read.problems.map((p) => `${p.at}: ${p.message}`)
}

describe('Workflow files', () => {
  it('reads when to use a workflow, with a per-language override and a fallback', () => {
    const read = parseWorkflow(
      workflow(`when: Use for a feature with a separate review.
locales:
  en-GB:
    name: Feature and review
  zh-CN:
    when: 功能需要单独审查时使用。
${STEPS}`),
    )
    expect(read.problems).toEqual([])
    expect(workflowText(read.workflow!, 'zh-CN')).toMatchObject({
      when: '功能需要单独审查时使用。',
    })
    expect(workflowText(read.workflow!, 'en-GB')).toMatchObject({
      name: 'Feature and review',
      when: 'Use for a feature with a separate review.',
    })
    expect(parseWorkflow(workflow(STEPS)).workflow).not.toHaveProperty('when')
  })

  it('refuses non-text, multiline and overlong when fields', () => {
    expect(
      problemsOf(
        workflow(`when: false
locales:
  en-GB:
    when: |-
      First line
      Second line
  fr:
    when: ${'x'.repeat(WORKFLOW_DESCRIPTION_CHARS + 1)}
${STEPS}`),
      ),
    ).toEqual([
      'when: must be text',
      'locales.en-GB.when: must be one line',
      `locales.fr.when: is longer than ${WORKFLOW_DESCRIPTION_CHARS} characters`,
    ])
  })

  it('reads outcome names per language, for display only', () => {
    const read = parseWorkflow(
      workflow(`locales:
  zh-CN:
    steps:
      review: 审查
    outcomes:
      review:
        Approved: 通过
        Changes needed: 需要修改
  en-GB:
    outcomes:
      build:
        Done: Finished
${STEPS}`),
    )
    expect(read.problems).toEqual([])
    const flow = read.workflow!
    expect(outcomeName(flow, 'review', 'Changes needed', 'zh-CN')).toBe('需要修改')
    expect(outcomeName(flow, 'build', 'Done', 'en-GB')).toBe('Finished')
    // Reports and what is stored keep the file's own names.
    expect(flow.steps[1]!.outcomes.map((o) => o.name)).toEqual(['Approved', 'Changes needed'])
  })

  it('falls back to the name in the file where a language has none', () => {
    const flow = parseWorkflow(
      workflow(`locales:
  zh-CN:
    outcomes:
      review:
        Approved: 通过
${STEPS}`),
    ).workflow!
    expect(outcomeName(flow, 'review', 'Changes needed', 'zh-CN')).toBe('Changes needed')
    expect(outcomeName(flow, 'build', 'Done', 'zh-CN')).toBe('Done')
    expect(outcomeName(flow, 'review', 'Approved', 'fr')).toBe('Approved')
    expect(outcomeName(flow, 'review', 'Approved')).toBe('Approved')
    expect(outcomeName(flow, 'review', 'constructor', 'zh-CN')).toBe('constructor')
  })

  it('reads only names a language gives, never what every object has', () => {
    const flow = parseWorkflow(
      workflow(`locales:
  zh-CN:
    name: 测试
    steps:
      build: 构建
    outcomes:
      build:
        Done: 完成
steps:
  - id: build
    name: Build
    prompt: Build it.
    outcomes:
      - name: Done
        to: constructor
  - id: constructor
    name: Construct
    prompt: Construct it.
    outcomes:
      - name: toString
        end: done
`),
    ).workflow!
    expect(stepName(flow, 'constructor', 'zh-CN')).toBe('Construct')
    expect(stepName(flow, 'build', 'zh-CN')).toBe('构建')
    expect(outcomeName(flow, 'constructor', 'toString', 'zh-CN')).toBe('toString')
    expect(workflowText(flow, 'constructor').name).toBe('Test')
    expect(workflowText(flow, 'toString').description).toBe('')
  })

  it('refuses outcome names for an unknown step or outcome, or not as text', () => {
    expect(
      problemsOf(
        workflow(`locales:
  zh-CN:
    outcomes:
      ship:
        Done: 完成
      review:
        Rejected: 拒绝
        Approved: 3
  fr:
    outcomes: [Approved]
  de:
    outcomes:
      review: Genehmigt
${STEPS}`),
      ),
    ).toEqual([
      'locales.zh-CN.outcomes.review.Approved: must be text',
      'locales.fr.outcomes: must map step ids to their outcomes',
      'locales.de.outcomes.review: must map outcome names to names',
      'locales.zh-CN.outcomes.ship: no step "ship"',
      'locales.zh-CN.outcomes.review.Rejected: "review" has no outcome "Rejected"',
    ])
  })

  it('reads a step’s role, and refuses one on a person’s step or that is no name', () => {
    const withRole = (line: string) =>
      workflow(STEPS.replace('prompt: Build it.', `prompt: Build it.\n    ${line}`))
    const read = parseWorkflow(withRole('role: reviewer'))
    expect(read.problems).toEqual([])
    expect(read.workflow!.steps[0]!.role).toBe('reviewer')
    expect(read.workflow!.steps[1]!.role).toBeUndefined()
    expect(parseWorkflow(withRole('role: kit:reviewer')).workflow!.steps[0]!.role).toBe(
      'kit:reviewer',
    )
    expect(problemsOf(withRole('role: "bad name"'))).toEqual(['steps[0].role: must be a name'])
    expect(problemsOf(withRole('by: you\n    hand_in: outcome\n    role: reviewer'))).toContain(
      "steps[0].role: a person's step has no agent to give a role to",
    )
  })

  it('reads steps, arrows back, reviews and defaults', () => {
    const read = parseWorkflow(workflow(STEPS))
    expect(read.problems).toEqual([])
    const [build, review] = read.workflow!.steps
    expect(build).toMatchObject({ by: 'agent', handIn: 'note', youReview: false, reviewOf: [] })
    expect(review).toMatchObject({ handIn: 'outcome', reviewOf: ['build'] })
    expect(review!.outcomes[1]).toEqual({
      name: 'Changes needed',
      to: ['build'],
      end: null,
      limit: null,
    })
    expect(read.workflow!.sendBackLimit).toBe(3)
  })

  it('reads an arrow to several steps as parallel work', () => {
    const read = parseWorkflow(
      workflow(`
steps:
  - id: split
    name: Split
    prompt: Split.
    outcomes:
      - name: Done
        to: [a, b]
  - id: a
    name: A
    prompt: A.
    outcomes:
      - name: Done
        to: join
  - id: b
    name: B
    prompt: B.
    outcomes:
      - name: Done
        to: join
  - id: join
    name: Join
    prompt: Join.
    outcomes:
      - name: Done
        end: done
`),
    )
    expect(read.problems).toEqual([])
    expect(read.workflow!.steps[0]!.outcomes[0]!.to).toEqual(['a', 'b'])
  })

  it('names where each problem is', () => {
    expect(problemsOf(workflow(STEPS.replace('to: review', 'to: nowhere')))).toContain(
      'steps[0].outcomes[0].to: no step "nowhere"',
    )
    expect(problemsOf(workflow(STEPS.replace('id: review', 'id: build')))).toEqual(
      expect.arrayContaining(['steps[1].id: another step is "build"']),
    )
    expect(
      problemsOf(workflow(STEPS.replace('review_of: [build]', 'review_of: [review]'))),
    ).toContain('steps[1].review_of: a step cannot review itself')
    expect(problemsOf(workflow(STEPS, 'format: 2\nname: Test\n'))).toContain('format: must be 1')
    expect(problemsOf(workflow(STEPS, 'format: 1\nname: Test\nharness: codex\n'))).toContain(
      'harness: unknown field',
    )
  })

  it('refuses a step that is never reached and a loop that never ends', () => {
    const unreachable = workflow(`
steps:
  - id: a
    name: A
    prompt: A.
    outcomes:
      - name: Done
        end: done
  - id: b
    name: B
    prompt: B.
    outcomes:
      - name: Done
        end: done
`)
    expect(problemsOf(unreachable)).toContain('steps[1]: "b" is never reached from the first step')
    const endless = workflow(`
steps:
  - id: a
    name: A
    prompt: A.
    outcomes:
      - name: Done
        to: b
      - name: Stop
        end: dropped
  - id: b
    name: B
    prompt: B.
    outcomes:
      - name: Again
        to: b
`)
    expect(problemsOf(endless)).toContain('steps[1]: no path from "b" ever ends the task')
  })

  it('asks a conclusion step for two outcomes and a person step for no agent fields', () => {
    expect(
      problemsOf(workflow(STEPS.replace('      - name: Changes needed\n        to: build\n', ''))),
    ).toContain('steps[1].outcomes: a step that hands in an outcome needs at least two outcomes')
    const person = workflow(`
steps:
  - id: ok
    name: Approve
    by: you
    prompt: Approve it?
    hint: fast
    outcomes:
      - name: Yes
        end: done
      - name: No
        end: dropped
`)
    expect(problemsOf(person)).toContain("steps[0].hint: a person's step has no agent to pick")
  })

  it('refuses YAML aliases and files that are not mappings', () => {
    const alias = workflow(`
x: &p Build it.
steps:
  - id: a
    name: A
    prompt: *p
    outcomes:
      - name: Done
        end: done
`)
    expect(problemsOf(alias)).toEqual([': YAML aliases are not allowed'])
    expect(problemsOf('- a\n- b\n')).toEqual([': the file must be a mapping'])
  })

  it('lists the tools a host does not have', () => {
    const read = parseWorkflow(
      workflow(
        STEPS.replace(
          '    prompt: Build it.\n',
          '    prompt: Build it.\n    tools:\n      mcp: [figma]\n      skills: [pdf]\n',
        ),
      ),
    )
    expect(read.problems).toEqual([])
    const problems = toolProblems(read.workflow!, { mcp: new Set(['figma']), skills: new Set() })
    expect(problems).toEqual([
      { at: 'steps[0].tools.skills[0]', message: 'no Skill "pdf" is installed in Kettu' },
    ])
  })

  it('hashes the file as it is, so any change needs approval again', () => {
    expect(workflowHash(STEPS)).toMatch(/^[0-9a-f]{64}$/)
    expect(workflowHash(STEPS)).not.toBe(workflowHash(`${STEPS} `))
  })
})
