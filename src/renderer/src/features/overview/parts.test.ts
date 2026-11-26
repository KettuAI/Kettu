import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { rowSubParts, rowTooltip } from './model'

const OVERVIEW_CSS_PATH = fileURLToPath(new URL('./overview.css', import.meta.url))

describe('rowSubParts', () => {
  it('separates project, agent/workflow, extra, and host while building full tooltip text', () => {
    const parts = rowSubParts(
      {
        project: 'enterprise-design-system-workspace',
        by: 'Google Antigravity',
        host: 'Studio Mac',
      },
      { project: true, extra: '2 sub-sessions', separator: ' · ' },
    )

    expect(parts).toEqual({
      project: 'enterprise-design-system-workspace',
      by: 'Google Antigravity',
      extra: '2 sub-sessions',
      host: 'Studio Mac',
      fullText:
        'enterprise-design-system-workspace · Google Antigravity · 2 sub-sessions · Studio Mac',
    })
  })

  it('omits project when grouped by project and omits host in single-host mode', () => {
    expect(
      rowSubParts(
        { project: 'kettu', by: 'Google Antigravity', host: 'dev-box' },
        { project: false, separator: ' · ' },
      ),
    ).toEqual({
      project: null,
      by: 'Google Antigravity',
      extra: null,
      host: 'dev-box',
      fullText: 'Google Antigravity · dev-box',
    })

    expect(
      rowSubParts(
        { project: 'kettu', by: 'Claude Code', host: null },
        { project: true, separator: ' · ' },
      ),
    ).toEqual({
      project: 'kettu',
      by: 'Claude Code',
      extra: null,
      host: null,
      fullText: 'kettu · Claude Code',
    })
  })
})

describe('rowTooltip', () => {
  it('joins title and subtitle with a newline and returns title alone when subtitle is empty', () => {
    expect(rowTooltip('Fix overview layout', 'project · Google Antigravity · Studio Mac')).toBe(
      'Fix overview layout\nproject · Google Antigravity · Studio Mac',
    )
    expect(rowTooltip('Fix overview layout', '')).toBe('Fix overview layout')
  })
})

describe('overview host visibility layout styles', () => {
  const css = readFileSync(OVERVIEW_CSS_PATH, 'utf8')

  it('pins the host pill so long project and agent names never push it out of view', () => {
    expect(css).toMatch(/\.k-ov-name\s*\{[^}]*container:\s*k-ov-name \/ inline-size;/s)
    expect(css).toMatch(/\.k-ov-sub\s*\{[^}]*display:\s*flex;[^}]*min-width:\s*0;/s)
    expect(css).toMatch(
      /\.k-ov-sub__host\s*\{[^}]*flex:\s*none;[^}]*max-width:\s*min\(116px,\s*40cqi\);/s,
    )
    expect(css).toMatch(
      /\.k-ov-sub__host span\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s,
    )
  })

  it('truncates the project folder name before the agent name', () => {
    expect(css).toMatch(
      /\.k-ov-sub__project\s*\{[^}]*flex:\s*0 2 auto;[^}]*min-width:\s*0;[^}]*text-overflow:\s*ellipsis;/s,
    )
    expect(css).toMatch(/\.k-ov-sub__project ~ \.k-ov-sub__by\s*\{[^}]*flex:\s*0 0 auto;/s)
  })
})
