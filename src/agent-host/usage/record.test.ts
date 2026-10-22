import { describe, expect, it } from 'vitest'
import { recordRows, type RecordedTurn } from './record'

const tokens = (input: number, output: number, thought: number | null = null) => ({
  total: input + output,
  input,
  output,
  thought,
  cacheRead: 100,
  cacheWrite: null,
})

const turn = (changes: Partial<RecordedTurn>): RecordedTurn => ({
  sessionId: 'ob1',
  acpSessionId: 'acp1',
  agentId: 'claude-code',
  project: '/p',
  turnEntryId: 'e:9',
  at: 1_000,
  tokens: tokens(1, 2),
  models: [],
  model: null,
  ...changes,
})

describe('recordRows', () => {
  it('prefers the counts per model, which hold the subagents', () => {
    const rows = recordRows(
      turn({
        models: [
          { model: 'claude-opus-5-5[1m]', tokens: tokens(8, 421) },
          { model: 'claude-haiku-5-5', tokens: tokens(3, 4) },
        ],
      }),
    )
    expect(rows.map((r) => [r.key, r.model, r.input, r.output, r.reasoning, r.cacheRead])).toEqual([
      ['ob:ob1:e:9:claude-opus-5-5', 'claude-opus-5-5', 8, 421, null, 100],
      ['ob:ob1:e:9:claude-haiku-5-5', 'claude-haiku-5-5', 3, 4, null, 100],
    ])
    expect(rows[0]).toMatchObject({
      source: 'overbench',
      sessionId: 'acp1',
      project: '/p',
      at: 1_000,
    })
  })

  it('falls back to the turn usage with the session model, keeping OpenCode reasoning apart', () => {
    expect(
      recordRows(
        turn({ agentId: 'opencode', tokens: tokens(5, 6, 7), model: 'opencode-go/GLM-5.3' }),
      ).map((r) => [r.model, r.reasoning]),
    ).toEqual([['glm-5.3', 7]])
    expect(recordRows(turn({ agentId: 'codex', tokens: tokens(5, 6, 7) }))[0]?.reasoning).toBeNull()
  })

  it('records nothing for a turn without usage', () => {
    expect(recordRows(turn({ tokens: null }))).toEqual([])
    expect(
      recordRows(
        turn({
          tokens: { total: 0, input: 0, output: 0, thought: null, cacheRead: 0, cacheWrite: 0 },
        }),
      ),
    ).toEqual([])
  })
})
