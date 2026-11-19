import { describe, expect, it } from 'vitest'
import en from '@shared/locales/en/report.json'
import { REPORT_ORIGINS } from '@shared/report'
import { briefError, reportPrefill, type PrefillText } from './report-prefill'

const prefill = en.prefill as Record<string, string>
const t: PrefillText = (key, values = {}) => {
  const text = prefill[key.replace(/^prefill\./, '')]
  if (text === undefined) throw new Error(`No text for ${key}`)
  return text.replace(/\{\{(\w+)\}\}/g, (_, name: string) => values[name] ?? '')
}

describe('reportPrefill', () => {
  it('states a failed turn with its agent and the error shown', () => {
    expect(
      reportPrefill({ origin: 'turn', agent: 'Claude Code', error: 'Weekly limit reached' }, t),
    ).toBe('A turn failed in a Claude Code session.\n\nThe error shown:\nWeekly limit reached')
  })

  it('names no agent it does not know', () => {
    expect(reportPrefill({ origin: 'turn', agent: null, error: null }, t)).toBe(
      'A turn failed in a session.',
    )
  })

  it('has a sentence for every place a report opens from', () => {
    for (const origin of REPORT_ORIGINS) {
      expect(reportPrefill({ origin, agent: null, error: null }, t)).not.toBe('')
    }
  })

  it('is empty when the place knows nothing', () => {
    expect(reportPrefill({ origin: null, agent: null, error: null }, t)).toBe('')
    expect(reportPrefill({ origin: null, agent: 'Codex', error: null }, t)).toBe('')
  })

  it('says only that an error was shown when that is all it knows', () => {
    expect(reportPrefill({ origin: null, agent: null, error: 'boom' }, t)).toBe(
      'Kettu showed an error.\n\nThe error shown:\nboom',
    )
  })
})

describe('briefError', () => {
  it('keeps the first lines and cuts a long one', () => {
    expect(briefError('a\n\n b \nc\nd')).toBe('a\nb\nc')
    expect(Array.from(briefError('x'.repeat(2_000))).length).toBe(401)
  })
})
