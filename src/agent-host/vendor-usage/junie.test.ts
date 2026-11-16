import { describe, expect, it } from 'vitest'
import { parseJunieUsage } from './junie'

// As build 3893.5 renders the report: each line ends in two spaces, sections are parted by a blank
// line, and the end is trimmed.
const report = (...tail: string[]): string =>
  [
    'Session usage  \n',
    'Here is a breakdown of the usage for the current session:  \n',
    '\n',
    '**Total usage**  \n',
    'Total cost:        0.00 credits  \n',
    'Total tokens used: 0  \n',
    '\n',
    ...tail.map((line) => `${line}  \n`),
  ]
    .join('')
    .trimEnd()

describe('Junie usage report', () => {
  it('reads the balance of a JetBrains account in credits', () => {
    const result = parseJunieUsage(
      report('License: JetBrains AI Pro', 'Balance left: 12.5 credits'),
      10,
    )
    expect(result).toEqual({
      limits: [],
      balances: [{ label: 'Balance', amount: 12.5, currency: 'credits' }],
    })
  })

  it('reads a balance of one credit and one in dollars', () => {
    expect(parseJunieUsage(report('Balance left: 1 credit'), 10)?.balances).toEqual([
      { label: 'Balance', amount: 1, currency: 'credits' },
    ])
    expect(
      parseJunieUsage(report('Balance left: $3.25', 'Top-up: https://jb.gg/junie_top_up'), 10)
        ?.balances,
    ).toEqual([{ label: 'Balance', amount: 3.25, currency: 'USD' }])
  })

  it('reads the quota of a connected IDE as an amount', () => {
    const result = parseJunieUsage(
      report('License: JetBrains AI Ultimate', 'Quota: 120 / 300 credits remaining'),
      10,
    )
    expect(result?.balances).toEqual([])
    expect(result?.limits).toEqual([
      {
        window: 'monthly',
        label: 'Monthly',
        usedPercent: 60,
        resetsAt: null,
        state: 'ok',
        observedAt: 10,
        amount: { used: 180, total: 300, unit: 'credits' },
      },
    ])
  })

  it('gives empty lists for a report without credits', () => {
    expect(parseJunieUsage(report('License: No active license found'), 10)).toEqual({
      limits: [],
      balances: [],
    })
  })

  it('gives null for text that is not the report', () => {
    expect(parseJunieUsage("Command 'usage' does not accept arguments.", 10)).toBeNull()
  })
})
