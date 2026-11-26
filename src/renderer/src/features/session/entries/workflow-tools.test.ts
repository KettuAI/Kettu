import { describe, expect, it } from 'vitest'
import type { DigestedToolEntry, ThreadState, ToolEntry } from '@shared/thread'
import { signatureOf } from '../thread-items'
import {
  cardIdOf,
  hasDigestedContent,
  needsFullWorkflowEntry,
  pickOf,
  reportOf,
  savedOf,
  suggestionFallbackName,
  workflowCardOf,
  workflowToolOf,
} from './workflow-tools'

function tool(overrides: Partial<ToolEntry> = {}): ToolEntry {
  return {
    kind: 'tool',
    id: 't1',
    title: 'mcp__kettu__suggest_workflow',
    toolKind: 'other',
    status: 'completed',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
    ...overrides,
  }
}

function asTool(entry: DigestedToolEntry): ToolEntry {
  return entry as unknown as ToolEntry
}

describe('workflow-tools remote digest compatibility', () => {
  it('recognizes workflow card tools across harness titles and rejects other servers', () => {
    expect(workflowToolOf(tool({ title: 'mcp__kettu__suggest_workflow' }))).toBe('start')
    expect(workflowToolOf(tool({ title: 'kettu: suggest_workflow' }))).toBe('start')
    expect(workflowToolOf(tool({ title: 'kettu：suggest_workflow' }))).toBe('start')
    expect(workflowToolOf(tool({ title: 'kettu.list_workflows, kettu.suggest_workflow' }))).toBe(
      'start',
    )
    expect(workflowToolOf(tool({ title: 'mcp_kettu_suggest_workflow' }))).toBe('start')
    expect(workflowToolOf(tool({ title: 'mcp__other__suggest_workflow' }))).toBeNull()
  })

  it('parses workflow cards when remote pages keep workflow output intact while digesting large inputs', () => {
    const dSuggest = asTool({
      kind: 'tool',
      id: 't-suggest',
      title: 'kettu: suggest_workflow',
      toolKind: 'other',
      status: 'completed',
      rawInputDigest: { size: 4096, lines: 20 },
      content: [
        {
          type: 'markdown',
          markdown:
            'The user sees your suggestion to run this through "Release Check" in card wfs-abcdefghij23 and decides.\n' +
            'x'.repeat(1500),
        },
      ],
      locations: [],
      permission: null,
      permissionResult: null,
    })
    const dCreate = asTool({
      kind: 'tool',
      id: 't-create',
      title: 'mcp__kettu__create_workflow',
      toolKind: 'other',
      status: 'completed',
      rawInputDigest: { size: 8192, lines: 80 },
      content: [
        {
          type: 'markdown',
          markdown:
            'The user sees card wfs-234567abcdef to save "Deploy" to their library.\n' +
            'z'.repeat(1500),
        },
      ],
      locations: [],
      permission: null,
      permissionResult: null,
    })
    const dReport = tool({
      id: 't-report',
      title: 'mcp__kettu__report_step',
      rawInput: JSON.stringify({ outcome: 'Done', note: 'n'.repeat(3000) }),
      content: [
        {
          type: 'markdown',
          markdown: `Report accepted. Facts:\n${'f'.repeat(1500)}`,
        },
      ],
    })
    const dPick = tool({
      id: 't-pick',
      title: 'kettu：pick_step_agents',
      rawInput: JSON.stringify({
        picks: [
          {
            step: 'review',
            agent: 'claude-code',
            model: 'sonnet',
            effort: 'high',
            reason: 'r'.repeat(3000),
          },
        ],
      }),
      content: [{ type: 'markdown', markdown: 'Picked.' }],
    })

    expect(cardIdOf(dSuggest)).toBe('wfs-abcdefghij23')
    expect(workflowCardOf(dSuggest)).toBe('start')
    expect(needsFullWorkflowEntry(dSuggest)).toBe(false)

    expect(cardIdOf(dCreate)).toBe('wfs-234567abcdef')
    expect(workflowCardOf(dCreate)).toBe('create')
    expect(needsFullWorkflowEntry(dCreate)).toBe(false)

    expect(workflowCardOf(dReport)).toBe('report')
    expect(reportOf(dReport).outcome).toBe('Done')
    expect(reportOf(dReport).answer).toContain('Report accepted.')
    expect(needsFullWorkflowEntry(dReport)).toBe(false)

    expect(workflowCardOf(dPick)).toBe('pick')
    expect(pickOf(dPick).picks).toHaveLength(1)
    expect(pickOf(dPick).picks[0]?.step).toBe('review')
    expect(needsFullWorkflowEntry(dPick)).toBe(false)
  })

  it('keeps digested workflow entries from older hosts as standalone cards until restored', () => {
    const oldHostSuggest = asTool({
      kind: 'tool',
      id: 't-old-suggest',
      title: 'kettu: suggest_workflow',
      toolKind: 'other',
      status: 'completed',
      content: [{ type: 'digest', of: 'markdown', size: 2048, lines: 12 }],
      locations: [],
      permission: null,
      permissionResult: null,
    })
    const oldHostCreateFailed = asTool({
      kind: 'tool',
      id: 't-old-create-fail',
      title: 'mcp__kettu__create_workflow',
      toolKind: 'other',
      status: 'failed',
      content: [{ type: 'digest', of: 'markdown', size: 1800, lines: 20 }],
      locations: [],
      permission: null,
      permissionResult: null,
    })
    const oldHostReport = asTool({
      kind: 'tool',
      id: 't-old-report',
      title: 'mcp__kettu__report_step',
      toolKind: 'other',
      status: 'completed',
      content: [{ type: 'digest', of: 'markdown', size: 3000, lines: 1 }],
      locations: [],
      permission: null,
      permissionResult: null,
      rawInputDigest: { size: 3000, lines: 10 },
    })

    expect(hasDigestedContent(oldHostSuggest)).toBe(true)
    expect(cardIdOf(oldHostSuggest)).toBeNull()
    expect(workflowCardOf(oldHostSuggest)).toBe('start')
    expect(needsFullWorkflowEntry(oldHostSuggest)).toBe(true)

    expect(workflowCardOf(oldHostCreateFailed)).toBe('create')
    expect(savedOf(oldHostCreateFailed)).toEqual({ saved: false, problems: [] })
    expect(needsFullWorkflowEntry(oldHostCreateFailed)).toBe(true)

    expect(workflowCardOf(oldHostReport)).toBe('report')
    expect(needsFullWorkflowEntry(oldHostReport)).toBe(true)

    const thread = {
      session: {} as ThreadState['session'],
      order: ['t-old-suggest'],
      byId: { 't-old-suggest': oldHostSuggest },
    }
    expect(signatureOf(thread)).toBe('o')
  })

  it('extracts a fallback workflow name from structured data, raw input, or tool text', () => {
    expect(
      suggestionFallbackName(
        tool({ structured: { suggestion: { id: 'wfs-abcdefghij23', workflow_name: 'Ship It' } } }),
      ),
    ).toBe('Ship It')
    expect(
      suggestionFallbackName(
        tool({ rawInput: JSON.stringify({ workflow_id: 'w1', title: 'Audit API' }) }),
      ),
    ).toBe('Audit API')
    expect(
      suggestionFallbackName(
        tool({
          content: [
            {
              type: 'markdown',
              markdown:
                'The user sees your suggestion to run this through "Bug Triage" in card wfs-abcdefghij23.',
            },
          ],
        }),
      ),
    ).toBe('Bug Triage')
  })
})
