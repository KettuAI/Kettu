import { describe, expect, it } from 'vitest'
import { parseGitHubStarFile } from './github-star'

describe('parseGitHubStarFile', () => {
  it('keeps a valid record', () => {
    const record = {
      version: 1,
      days: ['2026-11-12', '2026-11-13', '2026-11-14'],
      turns: 24,
      starred: false,
      opened: false,
      dismissals: 1,
      dismissedAt: 1_700_000_000_000,
      turnsAtDismissal: 21,
      cardDue: true,
    }
    expect(parseGitHubStarFile(record)).toEqual(record)
  })

  it('resets damaged fields so the prompt never shows early or comes back', () => {
    expect(
      parseGitHubStarFile({
        days: ['2026-11-14', '2026-11-14', 'yesterday', 3, '2026-11-15'],
        turns: -4,
        starred: 'yes',
        dismissals: 99,
        dismissedAt: 'never',
        turnsAtDismissal: 1.5,
      }),
    ).toEqual({
      version: 1,
      days: ['2026-11-14', '2026-11-15'],
      turns: 0,
      starred: false,
      opened: false,
      dismissals: 2,
      dismissedAt: null,
      turnsAtDismissal: 0,
      cardDue: false,
    })
  })

  it('keeps only the latest three days', () => {
    const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']
    expect(parseGitHubStarFile({ days })).toMatchObject({ days: days.slice(1) })
  })
})
