import { describe, expect, it } from 'vitest'
import { parseStatusReport, parseStatusReset } from './codex-reports'

// 2026-10-22 10:00 local time, a Thursday.
const NOW = new Date(2026, 9, 22, 10, 0).getTime()

/** `/status` as codex-acp 2.2.2 formats it (`buildStatusMessage`), lines joined by two spaces. */
function status(...limits: string[]): string {
  return [
    '**Model:** gpt-5.5-codex',
    '**Directory:** /tmp/reports',
    '**Approval:** on-request',
    '**Sandbox:** workspace-write',
    '**Account:** ChatGPT free (me@example.com)',
    '**Session:** `019a`',
    '',
    '**Token usage:** data not available yet',
    '**Context window:** data not available yet',
    ...limits,
  ].join('  \n')
}

describe('parseStatusReport', () => {
  it('reads the default pool as the 5-hour and weekly windows', () => {
    expect(
      parseStatusReport(
        status(
          '**codex 5h limit:** 58% left (resets 14:30)',
          '**codex Weekly limit:** 91% left (resets 09:12 on 27 Oct)',
        ),
        NOW,
      ),
    ).toEqual([
      {
        window: 'five_hour',
        label: '5-hour',
        usedPercent: 42,
        resetsAt: new Date(2026, 9, 22, 14, 30).getTime(),
        state: 'ok',
        observedAt: NOW,
      },
      {
        window: 'seven_day',
        label: 'Weekly',
        usedPercent: 9,
        resetsAt: new Date(2026, 9, 27, 9, 12).getTime(),
        state: 'ok',
        observedAt: NOW,
      },
    ])
  })

  it('keeps a pool of its own apart, and marks a spent window as reached', () => {
    const limits = parseStatusReport(
      status(
        '**codex 5h limit:** 100% left',
        '**GPT-5.3-Codex-Spark 5h limit:** 0% left (resets 11:00)',
        '**GPT-5.3-Codex-Spark Weekly limit:** 40% left',
      ),
      NOW,
    )
    expect(limits?.map((l) => [l.window, l.label, l.usedPercent, l.state])).toEqual([
      ['five_hour', '5-hour', 0, 'ok'],
      ['gpt_5_3_codex_spark_five_hour', '5-hour · GPT-5.3-Codex-Spark', 100, 'reached'],
      ['gpt_5_3_codex_spark_seven_day', 'Weekly · GPT-5.3-Codex-Spark', 60, 'ok'],
    ])
  })

  it('tells a monthly window from a weekly one by its reset, since both say "Weekly limit"', () => {
    // A Free plan's 30-day window, as codex-acp 2.2.2 printed it on 2026-10-21.
    const limits = parseStatusReport(
      status(
        '**codex Weekly limit:** 95% left (resets 22:14 on Nov 18)',
        '**Pro Weekly limit:** 99% left (resets 00:00 on Jan 1)',
      ),
      NOW,
    )
    expect(limits).toEqual([
      {
        window: 'monthly',
        label: 'Monthly',
        usedPercent: 5,
        resetsAt: new Date(2026, 10, 18, 22, 14).getTime(),
        state: 'ok',
        observedAt: NOW,
      },
      expect.objectContaining({ window: 'pro_annual', label: 'Annual · Pro', usedPercent: 1 }),
    ])
  })

  it('names other window lengths by their length, and skips credits and spend limits', () => {
    const limits = parseStatusReport(
      status(
        '**codex 2d limit:** 75% left',
        '**codex Credits:** 120',
        '**codex individual spend limit:** 40% left (12 of 20 credits used; resets Oct 24)',
      ),
      NOW,
    )
    expect(limits?.map((l) => [l.window, l.label])).toEqual([['2_day', '2-day']])
  })

  it('gives an empty list before Codex has limits, and null for text that is not /status', () => {
    expect(parseStatusReport(status('**Limits:** data not available yet'), NOW)).toEqual([])
    expect(parseStatusReport('Command "/status" is not available.', NOW)).toBeNull()
  })
})

describe('parseStatusReset', () => {
  it('takes a time alone as today', () => {
    expect(parseStatusReset('14:30', NOW)).toBe(new Date(2026, 9, 22, 14, 30).getTime())
  })

  it('finds the day of a later reset in any language the adapter formats it in', () => {
    const on27 = new Date(2026, 9, 27, 9, 12).getTime()
    for (const date of ['27 Oct', 'Oct 27', '27. Okt.', '10月27日', '10월 27일']) {
      expect(parseStatusReset(`09:12 on ${date}`, NOW)).toBe(on27)
    }
  })

  it('carries a reset early next month over the month end', () => {
    const late = new Date(2026, 9, 30, 12, 0).getTime()
    expect(parseStatusReset('08:00 on 2 Nov', late)).toBe(new Date(2026, 10, 2, 8, 0).getTime())
  })

  it('finds the day within a month when the month is not readable', () => {
    expect(parseStatusReset('09:00 on 18. Nov.', NOW)).toBe(new Date(2026, 10, 18, 9, 0).getTime())
    // Today's day, at a time already past: the same day next month.
    expect(parseStatusReset('09:00 on 22. Okt.', NOW)).toBe(new Date(2026, 10, 22, 9, 0).getTime())
  })

  it('takes a named month past the year end', () => {
    expect(parseStatusReset('08:00 on Jan 5', NOW)).toBe(new Date(2027, 0, 5, 8, 0).getTime())
    expect(parseStatusReset('08:00 on 2月5日', NOW)).toBe(new Date(2027, 1, 5, 8, 0).getTime())
  })

  it('gives null for what it cannot read', () => {
    expect(parseStatusReset('soon', NOW)).toBeNull()
    expect(parseStatusReset('09:12 on sometime', NOW)).toBeNull()
    expect(parseStatusReset('09:12 on Feb 30', NOW)).toBeNull()
  })
})
