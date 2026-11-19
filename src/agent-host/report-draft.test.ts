import { describe, expect, it } from 'vitest'
import { createRedactor } from '@shared/log/redact'
import { REPORT_DRAFT_MAX } from '@shared/report'
import {
  cleanReportDraft,
  draftRecords,
  LISTED_RECORDS,
  RECORD_WINDOW_MS,
  reportDraftPrompt,
  type ReportDraftFacts,
} from './report-draft'

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0)
const KEY = 'sk-abcdefghijklmnopqrstuvwx'
const redact = createRedactor({
  home: '/Users/ann',
  platform: 'darwin',
  secrets: () => ['held-pairing-code'],
})

function facts(over: Partial<ReportDraftFacts> = {}): ReportDraftFacts {
  return {
    origin: 'turn',
    language: 'zh-CN',
    agent: 'Claude Code',
    error: null,
    log: [],
    events: [],
    now: NOW,
    ...over,
  }
}

describe('reportDraftPrompt', () => {
  it('masks secrets and the home folder in the error before it reaches the model', () => {
    const prompt = reportDraftPrompt(
      facts({ error: `401 for ${KEY} reading /Users/ann/work/.env with held-pairing-code` }),
      redact,
    )
    expect(prompt).not.toContain(KEY)
    expect(prompt).not.toContain('/Users/ann')
    expect(prompt).not.toContain('held-pairing-code')
    expect(prompt).toContain('401 for <redacted> reading ~/work/.env with <redacted>')
  })

  it('masks the recent records too', () => {
    const prompt = reportDraftPrompt(
      facts({
        log: [{ at: NOW - 1_000, level: 'warn', message: `token=${KEY} refused` }],
        events: [{ at: NOW - 500, event: 'exited', detail: 'cwd /Users/ann/secret-project' }],
      }),
      redact,
    )
    expect(prompt).not.toContain(KEY)
    expect(prompt).not.toContain('/Users/ann')
    expect(prompt).toContain('warn: token=<redacted> refused')
    expect(prompt).toContain('agent exited: cwd ~/secret-project')
  })

  it('names where the report opened, the agent and the language', () => {
    const prompt = reportDraftPrompt(facts({ error: 'Weekly limit reached' }), redact)
    expect(prompt).toContain("a failed turn's error card")
    expect(prompt).toContain('<agent>\nClaude Code\n</agent>')
    expect(prompt).toContain('BCP 47 tag zh-CN')
    expect(prompt).toContain('<error>\nWeekly limit reached\n</error>')
  })

  it('gives no prompt without an error or a recent record', () => {
    const quiet = facts({
      origin: null,
      agent: null,
      log: [{ at: NOW - 1_000, level: 'info', message: 'started' }],
      events: [{ at: NOW - 1_000, event: 'ignored', detail: 'thinking' }],
    })
    expect(reportDraftPrompt(quiet, redact)).toBeNull()
    expect(reportDraftPrompt({ ...quiet, origin: 'crash' }, redact)).toBeNull()
    expect(reportDraftPrompt({ ...quiet, error: 'boom' }, redact)).not.toBeNull()
  })
})

describe('draftRecords', () => {
  it('keeps only recent warnings, errors and agent events, the latest ones', () => {
    const log = Array.from({ length: 12 }, (_, i) => ({
      at: NOW - (12 - i) * 1_000,
      level: 'error' as const,
      message: `failure ${i}`,
    }))
    const lines = draftRecords(
      facts({
        log: [
          { at: NOW - RECORD_WINDOW_MS - 1, level: 'error', message: 'old failure' },
          { at: NOW - 100, level: 'info', message: 'routine line' },
          ...log,
        ],
      }),
      redact,
    )
    expect(lines).toHaveLength(LISTED_RECORDS)
    expect(lines.join('\n')).not.toContain('old failure')
    expect(lines.join('\n')).not.toContain('routine line')
    expect(lines.at(-1)).toContain('failure 11')
  })

  it('cuts a long record', () => {
    const [line] = draftRecords(
      facts({ log: [{ at: NOW - 1, level: 'error', message: 'x'.repeat(5_000) }] }),
      redact,
    )
    expect(line!.length).toBeLessThan(500)
  })
})

describe('cleanReportDraft', () => {
  it('takes the fenced block, and all of an unfenced reply', () => {
    expect(cleanReportDraft('Here it is:\n```text\nA turn failed.\n```\n')).toBe('A turn failed.')
    expect(cleanReportDraft('  A turn failed.  ')).toBe('A turn failed.')
  })

  it('is null for an empty block, which says there is nothing to describe', () => {
    expect(cleanReportDraft('```text\n```')).toBeNull()
    expect(cleanReportDraft('```text\n\n```')).toBeNull()
  })

  it('cuts a reply that runs on', () => {
    expect(Array.from(cleanReportDraft('a'.repeat(REPORT_DRAFT_MAX * 2))!).length).toBe(
      REPORT_DRAFT_MAX,
    )
  })
})
