// Tests workflow step harness eligibility: Claude Code, Codex, and Pi pass strict enforcement;
// OpenCode and Cline remain excluded.

import { describe, expect, it } from 'vitest'
import type { AgentId, HarnessId } from '@shared/thread'
import type { WorkflowStep } from '@shared/workflow'
import type { TaskRecord } from './model'
import { blockedFor, checkPick, factsFor, STEP_HARNESSES, type WorkflowAgent } from './picks'

const STEP: WorkflowStep = {
  id: 'build',
  name: 'Build',
  by: 'agent',
  handIn: 'note',
  prompt: 'Build the change',
  hint: null,
  tools: { mcp: [], skills: [] },
  youReview: false,
  reviewOf: [],
  outcomes: [{ name: 'done', end: 'done', to: [], limit: null }],
}

const TASK = {
  id: 'task-1',
  workflowId: 'wf-1',
  text: 'Ship feature',
  pace: 'balanced',
  paceReason: null,
  workflow: { steps: [STEP] },
  rounds: [],
} as unknown as TaskRecord

function makeAgent(
  id: AgentId,
  harness: HarnessId,
  overrides: Partial<WorkflowAgent> = {},
): WorkflowAgent {
  return {
    id,
    name: id,
    harness,
    disabled: false,
    missing: false,
    account: null,
    apiKey: false,
    kettu: true,
    models: [{ value: 'default', name: 'Default', note: null, efforts: null }],
    efforts: null,
    limits: () => [],
    skills: new Set(),
    mcp: new Set(),
    ...overrides,
  }
}

describe('STEP_HARNESSES and workflow pick checks', () => {
  it('allows Claude Code, Codex, and Pi while rejecting OpenCode and Cline', () => {
    expect([...STEP_HARNESSES].sort()).toEqual(['claude-code', 'codex', 'pi'])

    const agents = [
      makeAgent('claude-code', 'claude-code'),
      makeAgent('codex', 'codex'),
      makeAgent('pi', 'pi'),
      makeAgent('pi~old', 'pi', { kettu: false }),
      makeAgent('opencode', 'opencode'),
      makeAgent('cline', 'cline'),
    ]

    expect(
      blockedFor(agents[2], { agentId: 'pi', model: 'default', effort: null }, STEP, 0),
    ).toBeNull()
    expect(
      blockedFor(agents[3], { agentId: 'pi~old', model: 'default', effort: null }, STEP, 0),
    ).toEqual({ kind: 'unusable', agentId: 'pi~old', why: 'no_kettu' })
    expect(
      blockedFor(agents[4], { agentId: 'opencode', model: 'default', effort: null }, STEP, 0),
    ).toEqual({ kind: 'unusable', agentId: 'opencode', why: 'harness' })
    expect(
      blockedFor(agents[5], { agentId: 'cline', model: 'default', effort: null }, STEP, 0),
    ).toEqual({ kind: 'unusable', agentId: 'cline', why: 'harness' })

    const piPick = checkPick(
      { step: 'build', agent: 'pi', model: 'default', effort: null, reason: 'good fit' },
      STEP,
      TASK,
      agents,
      () => true,
      0,
    )
    expect(piPick.lines.every((l) => l.ok)).toBe(true)

    for (const excluded of ['opencode', 'cline']) {
      const result = checkPick(
        { step: 'build', agent: excluded, model: 'default', effort: null, reason: 'try' },
        STEP,
        TASK,
        agents,
        () => true,
        0,
      )
      expect(result.lines).toEqual([
        {
          check: 'agent',
          ok: false,
          detail: `${excluded} cannot do workflow steps; only Claude Code, Codex and Pi agents can.`,
        },
      ])
    }

    const facts = factsFor(
      TASK,
      [STEP],
      agents,
      () => true,
      () => [],
    )
    expect(facts.agents.map((a) => a.id)).toEqual(['claude-code', 'codex', 'pi', 'pi~old'])
  })
})
