import { describe, expect, it } from 'vitest'
import {
  aggregateContributors,
  classifyContribution,
  END_MARKER,
  extractClosingIssueNumbers,
  extractPrNumbersFromSubject,
  formatAttribution,
  isExcludedUser,
  renderAvatarWall,
  renderReleaseNotesTemplate,
  START_MARKER,
  updateReadmeContent,
} from './core.mjs'

describe('contributor eligibility and sorting', () => {
  it('excludes maintainers, automation accounts, and bots', () => {
    expect(isExcludedUser({ login: 'Amigoer', type: 'User' })).toBe(true)
    expect(isExcludedUser({ login: 'amigoer', type: 'User' })).toBe(true)
    expect(isExcludedUser({ login: 'kettu-builder', type: 'User' })).toBe(true)
    expect(isExcludedUser({ login: 'kettu-planner', type: 'User' })).toBe(true)
    expect(isExcludedUser({ login: 'kettu-reviewer', type: 'User' })).toBe(true)
    expect(isExcludedUser({ login: 'kettu-ops', type: 'User' })).toBe(true)
    expect(isExcludedUser({ login: 'dependabot[bot]', type: 'Bot' })).toBe(true)
    expect(isExcludedUser({ login: 'some-app[bot]', type: 'User' })).toBe(true)
    expect(isExcludedUser({ login: 'some-bot', type: 'Bot' })).toBe(true)
    expect(isExcludedUser(null)).toBe(true)
    expect(isExcludedUser({ login: 'akatsukiro', type: 'User' })).toBe(false)
  })

  it('counts merged PRs, completed issues, and accepted open issues only', () => {
    expect(
      classifyContribution({
        number: 1,
        state: 'closed',
        user: { login: 'alice', type: 'User' },
        pull_request: { merged_at: '2026-11-25T00:00:00Z' },
      }),
    ).toBe('pr')

    expect(
      classifyContribution({
        number: 2,
        state: 'closed',
        user: { login: 'alice', type: 'User' },
        pull_request: { merged_at: null },
      }),
    ).toBeNull()

    expect(
      classifyContribution({
        number: 3,
        state: 'closed',
        state_reason: 'completed',
        user: { login: 'bob', type: 'User' },
      }),
    ).toBe('issue')

    expect(
      classifyContribution({
        number: 4,
        state: 'closed',
        state_reason: 'not_planned',
        user: { login: 'bob', type: 'User' },
      }),
    ).toBeNull()

    expect(
      classifyContribution({
        number: 5,
        state: 'open',
        labels: [{ name: 'desktop' }],
        user: { login: 'carol', type: 'User' },
      }),
    ).toBe('issue')

    for (const label of ['needs-info', 'invalid', 'duplicate', 'wontfix']) {
      expect(
        classifyContribution({
          number: 6,
          state: 'open',
          labels: [{ name: label }],
          user: { login: 'carol', type: 'User' },
        }),
      ).toBeNull()
    }
  })

  it('sorts deterministically by total descending, then case-insensitive login ascending', () => {
    const result = aggregateContributors([
      {
        number: 1,
        state: 'closed',
        state_reason: 'completed',
        user: { login: 'Zed', type: 'User' },
      },
      {
        number: 2,
        state: 'closed',
        user: { login: 'bob', type: 'User' },
        pull_request: { merged_at: '2026-11-20T00:00:00Z' },
      },
      {
        number: 3,
        state: 'open',
        labels: [{ name: 'desktop' }],
        user: { login: 'bob', type: 'User' },
      },
      {
        number: 4,
        state: 'closed',
        state_reason: 'completed',
        user: { login: 'alice', type: 'User' },
      },
      {
        number: 5,
        state: 'closed',
        state_reason: 'completed',
        user: { login: 'Amigoer', type: 'User' },
      },
      {
        number: 6,
        state: 'closed',
        user: { login: 'dependabot[bot]', type: 'Bot' },
        pull_request: { merged_at: '2026-11-20T00:00:00Z' },
      },
    ])

    expect(result).toEqual([
      { login: 'bob', prs: 1, issues: 1, total: 2 },
      { login: 'alice', prs: 0, issues: 1, total: 1 },
      { login: 'Zed', prs: 0, issues: 1, total: 1 },
    ])
  })
})

describe('README contributors wall rendering and idempotent updates', () => {
  it('renders GitHub-safe native avatar markup without inline styles or third-party proxies', () => {
    const html = renderAvatarWall([{ login: 'akatsukiro' }, { login: 'Yezh1i' }])
    expect(html).toContain('https://github.com/akatsukiro.png?size=96')
    expect(html).toContain('width="48" height="48"')
    expect(html).not.toContain('style=')
  })

  it('inserts before Community & Contributing and updates idempotently on subsequent runs', () => {
    const initial = [
      '## Open-Source Ecosystem',
      '',
      'Table here.',
      '',
      '## Community & Contributing',
      '',
      '- Issues',
    ].join('\n')

    const contributors = [{ login: 'alice' }, { login: 'bob' }]
    const once = updateReadmeContent(initial, contributors, 'en')
    expect(once).toContain('## Contributors')
    expect(once).toContain(START_MARKER)
    expect(once).toContain(END_MARKER)
    expect(once.indexOf('## Contributors')).toBeLessThan(
      once.indexOf('## Community & Contributing'),
    )

    const twice = updateReadmeContent(once, contributors, 'en')
    expect(twice).toBe(once)

    const updated = updateReadmeContent(once, [{ login: 'carol' }], 'en')
    expect(updated).toContain('https://github.com/carol.png?size=96')
    expect(updated).not.toContain('https://github.com/alice.png?size=96')
  })

  it('inserts before Chinese Community & Contributing heading', () => {
    const initial = ['## 开源生态', '', '表格。', '', '## 社区与参与贡献', '', '- 反馈'].join('\n')
    const out = updateReadmeContent(initial, [{ login: 'alice' }], 'zh-CN')
    expect(out).toContain('## 贡献者')
    expect(out.indexOf('## 贡献者')).toBeLessThan(out.indexOf('## 社区与参与贡献'))
  })
})

describe('release notes contributor extraction and template rendering', () => {
  it('extracts PR numbers from subjects and closing issue numbers from bodies', () => {
    expect(
      extractPrNumbersFromSubject('fix(session): keep timeline dots above rail (#2679)'),
    ).toEqual([2679])
    expect(
      extractClosingIssueNumbers(
        'Fixes #2675, #2676 and closes KettuAI/Kettu#2680.\nAlso mentions #9999 without keyword.',
      ),
    ).toEqual([2675, 2676, 2680])
  })

  it('formats bilingual release notes with folded Simplified Chinese and bottom Contributors row', () => {
    expect(formatAttribution([2675], ['akatsukiro'], 'en')).toBe('(#2675, thanks @akatsukiro)')
    expect(formatAttribution([2675], ['akatsukiro'], 'zh-CN')).toBe('(#2675，感谢 @akatsukiro)')

    const md = renderReleaseNotesTemplate({
      entries: [
        {
          number: 2679,
          kind: 'pr',
          title: 'fix(session): keep timeline dots above rail (#2679)',
          credits: ['akatsukiro'],
          linkedIssues: [2675],
        },
      ],
      contributors: [{ login: 'akatsukiro', prs: 0, issues: 1, total: 1 }],
    })

    expect(md).toContain('## What changed')
    expect(md).toContain('- keep timeline dots above rail (#2675, thanks @akatsukiro)')
    expect(md).toContain('<details>\n<summary>简体中文更新说明</summary>\n\n## 中文')
    expect(md).toContain('- keep timeline dots above rail (#2675，感谢 @akatsukiro)')
    expect(md).toContain('## Contributors')
    expect(md).toContain('https://github.com/akatsukiro.png?size=96')
  })
})
