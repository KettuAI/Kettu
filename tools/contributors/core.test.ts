import { describe, expect, it } from 'vitest'
import {
  aggregateContributors,
  assertSafeContributorUpdate,
  calculateContributionScore,
  classifyContribution,
  END_MARKER,
  extractClosingIssueNumbers,
  extractExistingContributorLogins,
  extractPrNumbersFromSubject,
  formatAttribution,
  githubAvatarUrl,
  isExcludedUser,
  normalizeGitHubAvatarUrl,
  renderAvatarWall,
  renderReleaseNotesTemplate,
  START_MARKER,
  updateReadmeContent,
} from './core.mjs'

describe('contributor eligibility and sorting', () => {
  it('includes maintainers by default while excluding bots, and supports excluding maintainers for release notes', () => {
    // 默认口径（README 贡献者墙）：保留维护者 Amigoer
    expect(isExcludedUser({ login: 'Amigoer', type: 'User' })).toBe(false)
    expect(isExcludedUser({ login: 'amigoer', type: 'User' })).toBe(false)

    // 单版本发布说明致谢口径：可选排除维护者
    expect(isExcludedUser({ login: 'Amigoer', type: 'User' }, { excludeMaintainers: true })).toBe(
      true,
    )
    expect(isExcludedUser({ login: 'amigoer', type: 'User' }, { excludeMaintainers: true })).toBe(
      true,
    )

    // 自动化账号、机器人与无效对象一律排除
    expect(isExcludedUser({ login: 'kettu-builder', type: 'User' })).toBe(true)
    expect(isExcludedUser({ login: 'kettu-planner', type: 'User' })).toBe(true)
    expect(isExcludedUser({ login: 'kettu-reviewer', type: 'User' })).toBe(true)
    expect(isExcludedUser({ login: 'kettu-ops', type: 'User' })).toBe(true)
    expect(isExcludedUser({ login: 'dependabot[bot]', type: 'Bot' })).toBe(true)
    expect(isExcludedUser({ login: 'some-app[bot]', type: 'User' })).toBe(true)
    expect(isExcludedUser({ login: 'some-bot', type: 'Bot' })).toBe(true)
    expect(isExcludedUser({ login: 'ghost', type: 'User' })).toBe(true)
    expect(isExcludedUser(null)).toBe(true)
    expect(isExcludedUser({ login: 'akatsukiro', type: 'User' })).toBe(false)
  })

  it('normalizes avatar URLs onto avatars.githubusercontent.com', () => {
    expect(githubAvatarUrl('Amigoer')).toBe('https://avatars.githubusercontent.com/Amigoer?s=96')
    expect(
      normalizeGitHubAvatarUrl('https://avatars.githubusercontent.com/u/266790742?v=4', 'Amigoer'),
    ).toBe('https://avatars.githubusercontent.com/u/266790742?v=4&s=96')
    expect(normalizeGitHubAvatarUrl('https://github.com/Amigoer.png?size=96', 'Amigoer')).toBe(
      'https://avatars.githubusercontent.com/Amigoer?s=96',
    )
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
    ).toBe('completed_issue')

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
    ).toBe('open_issue')

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

  it('ranks contributors including maintainer by weighted contribution score with deterministic tie-breakers', () => {
    expect(
      calculateContributionScore({ commits: 10, prs: 2, completedIssues: 3, openIssues: 1 }),
    ).toBe(27)

    const result = aggregateContributors(
      [
        {
          number: 1,
          state: 'closed',
          state_reason: 'completed',
          user: { login: 'Zed', type: 'User' },
        },
        {
          number: 2,
          state: 'closed',
          user: {
            login: 'bob',
            type: 'User',
            avatar_url: 'https://avatars.githubusercontent.com/u/200?v=4',
          },
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
        // OpenOnly 提了 3 条开启中 Issue（3 分），低于 2 条已解决 Issue 的 CompletedTwo（4 分）
        {
          number: 5,
          state: 'open',
          labels: [{ name: 'desktop' }],
          user: { login: 'OpenOnly', type: 'User' },
        },
        {
          number: 6,
          state: 'open',
          labels: [{ name: 'desktop' }],
          user: { login: 'OpenOnly', type: 'User' },
        },
        {
          number: 7,
          state: 'open',
          labels: [{ name: 'desktop' }],
          user: { login: 'OpenOnly', type: 'User' },
        },
        {
          number: 8,
          state: 'closed',
          state_reason: 'completed',
          user: { login: 'CompletedTwo', type: 'User' },
        },
        {
          number: 9,
          state: 'closed',
          state_reason: 'completed',
          user: { login: 'CompletedTwo', type: 'User' },
        },
        {
          number: 10,
          state: 'closed',
          state_reason: 'completed',
          user: { login: 'Amigoer', type: 'User' },
        },
        {
          number: 11,
          state: 'closed',
          user: { login: 'dependabot[bot]', type: 'Bot' },
          pull_request: { merged_at: '2026-11-20T00:00:00Z' },
        },
      ],
      {
        commitContributors: [
          {
            login: 'Amigoer',
            type: 'User',
            avatar_url: 'https://avatars.githubusercontent.com/u/266790742?v=4',
            contributions: 100,
          },
          {
            login: 'kettu-builder[bot]',
            type: 'Bot',
            contributions: 50,
          },
        ],
      },
    )

    // 贡献值排序：
    // 1. Amigoer: 100*1 + 1*2 = 102
    // 2. bob: 1*5 + 1*1 = 6
    // 3. CompletedTwo: 2*2 = 4
    // 4. OpenOnly: 3*1 = 3
    // 5. alice: 1*2 = 2
    // 6. Zed: 1*2 = 2
    expect(result).toEqual([
      {
        login: 'Amigoer',
        avatarUrl: 'https://avatars.githubusercontent.com/u/266790742?v=4&s=96',
        commits: 100,
        prs: 0,
        completedIssues: 1,
        openIssues: 0,
        issues: 1,
        total: 101,
        score: 102,
      },
      {
        login: 'bob',
        avatarUrl: 'https://avatars.githubusercontent.com/u/200?v=4&s=96',
        commits: 0,
        prs: 1,
        completedIssues: 0,
        openIssues: 1,
        issues: 1,
        total: 2,
        score: 6,
      },
      {
        login: 'CompletedTwo',
        avatarUrl: 'https://avatars.githubusercontent.com/CompletedTwo?s=96',
        commits: 0,
        prs: 0,
        completedIssues: 2,
        openIssues: 0,
        issues: 2,
        total: 2,
        score: 4,
      },
      {
        login: 'OpenOnly',
        avatarUrl: 'https://avatars.githubusercontent.com/OpenOnly?s=96',
        commits: 0,
        prs: 0,
        completedIssues: 0,
        openIssues: 3,
        issues: 3,
        total: 3,
        score: 3,
      },
      {
        login: 'alice',
        avatarUrl: 'https://avatars.githubusercontent.com/alice?s=96',
        commits: 0,
        prs: 0,
        completedIssues: 1,
        openIssues: 0,
        issues: 1,
        total: 1,
        score: 2,
      },
      {
        login: 'Zed',
        avatarUrl: 'https://avatars.githubusercontent.com/Zed?s=96',
        commits: 0,
        prs: 0,
        completedIssues: 1,
        openIssues: 0,
        issues: 1,
        total: 1,
        score: 2,
      },
    ])
  })
})

describe('README contributors wall rendering and idempotent updates', () => {
  it('renders GitHub-safe native avatar markup on avatars.githubusercontent.com without inline styles', () => {
    const html = renderAvatarWall([
      {
        login: 'Amigoer',
        avatarUrl: 'https://avatars.githubusercontent.com/u/266790742?v=4&s=96',
      },
      { login: 'Yezh1i' },
    ])
    expect(html).toContain('https://avatars.githubusercontent.com/u/266790742?v=4&amp;s=96')
    expect(html).toContain('https://avatars.githubusercontent.com/Yezh1i?s=96')
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
    expect(updated).toContain('https://avatars.githubusercontent.com/carol?s=96')
    expect(updated).not.toContain('https://avatars.githubusercontent.com/alice?s=96')
  })

  it('inserts before Chinese Community & Contributing heading', () => {
    const initial = ['## 开源生态', '', '表格。', '', '## 社区与参与贡献', '', '- 反馈'].join('\n')
    const out = updateReadmeContent(initial, [{ login: 'alice' }], 'zh-CN')
    expect(out).toContain('## 贡献者')
    expect(out.indexOf('## 贡献者')).toBeLessThan(out.indexOf('## 社区与参与贡献'))
  })

  it('extracts existing contributor logins only from within the contributor markers', () => {
    const initial = [
      '<a href="https://github.com/outside-link">Outside</a>',
      '<a href="https://github.com/KettuAI/Kettu">Repo</a>',
      '',
      '## Community & Contributing',
      '',
      '- Issues',
    ].join('\n')

    expect(extractExistingContributorLogins(initial)).toEqual([])

    const withWall = updateReadmeContent(
      initial,
      [{ login: 'Yezh1i' }, { login: 'alice-dev' }],
      'en',
    )
    expect(extractExistingContributorLogins(withWall)).toEqual(['Yezh1i', 'alice-dev'])

    const withEmptyWall = updateReadmeContent(initial, [], 'en')
    expect(extractExistingContributorLogins(withEmptyWall)).toEqual([])
  })

  it('refuses to clear or silently truncate an existing contributors wall on filtered API results', () => {
    const existingLogins = ['Amigoer', 'alice', 'bob', 'carol', 'dave', 'erin']
    const prOnlyItems = [
      {
        number: 10,
        state: 'closed',
        user: { login: 'Amigoer', type: 'User' },
        pull_request: { merged_at: '2026-11-25T00:00:00Z' },
      },
    ]
    const issueOnlyItems = [
      {
        number: 11,
        state: 'closed',
        state_reason: 'completed',
        user: { login: 'alice', type: 'User' },
      },
    ]
    const mixedItems = [...prOnlyItems, ...issueOnlyItems]

    // 复现缺少 `issues: read` 权限：接口只返回 PR，即使保留维护者也会丢失所有 Issue 贡献者
    expect(() =>
      assertSafeContributorUpdate({
        existingLogins,
        nextContributors: [{ login: 'Amigoer' }],
        items: prOnlyItems,
      }),
    ).toThrow(/issues: read/)

    expect(() =>
      assertSafeContributorUpdate({
        existingLogins,
        nextContributors: [],
        items: prOnlyItems,
      }),
    ).toThrow(/issues: read/)

    // 复现缺少 `pull-requests: read` 权限导致既有 PR 贡献者丢失
    expect(() =>
      assertSafeContributorUpdate({
        existingLogins,
        nextContributors: [{ login: 'alice' }],
        items: issueOnlyItems,
      }),
    ).toThrow(/pull-requests: read/)

    // API 返回 0 条数据时拒绝清空已有头像墙
    expect(() =>
      assertSafeContributorUpdate({
        existingLogins,
        nextContributors: [],
        items: [],
      }),
    ).toThrow(/0 items/)

    // 骤减 50% 以上时默认拦截，除非显式传入 --allow-shrink
    expect(() =>
      assertSafeContributorUpdate({
        existingLogins,
        nextContributors: [{ login: 'Amigoer' }, { login: 'alice' }],
        items: mixedItems,
      }),
    ).toThrow(/--allow-shrink/)

    expect(() =>
      assertSafeContributorUpdate({
        existingLogins,
        nextContributors: [{ login: 'Amigoer' }, { login: 'alice' }],
        items: mixedItems,
        allowShrink: true,
      }),
    ).not.toThrow()

    // 即使传入 allowShrink 也不允许把非空头像墙清空为 0
    expect(() =>
      assertSafeContributorUpdate({
        existingLogins,
        nextContributors: [],
        items: mixedItems,
        allowShrink: true,
      }),
    ).toThrow(/Refusing to clear/)

    // 同时包含 Issue 和 PR 且仅为正常增删时放行
    expect(() =>
      assertSafeContributorUpdate({
        existingLogins,
        nextContributors: [
          { login: 'Amigoer' },
          { login: 'alice' },
          { login: 'bob' },
          { login: 'carol' },
          { login: 'dave' },
          { login: 'grace' },
        ],
        items: mixedItems,
      }),
    ).not.toThrow()

    // 首次生成（原本没有贡献者墙）时放行
    expect(() =>
      assertSafeContributorUpdate({
        existingLogins: [],
        nextContributors: [],
        items: [],
      }),
    ).not.toThrow()
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

  it('formats flat bilingual release notes without details folding or duplicate Contributors section', () => {
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
      contributors: [
        {
          login: 'akatsukiro',
          avatarUrl: 'https://avatars.githubusercontent.com/akatsukiro?s=96',
          commits: 0,
          prs: 0,
          completedIssues: 1,
          openIssues: 0,
          issues: 1,
          total: 1,
          score: 2,
        },
      ],
    })

    expect(md).toContain('## What changed')
    expect(md).toContain('- keep timeline dots above rail (#2675, thanks @akatsukiro)')
    expect(md).toContain('\n\n## 中文\n\n- keep timeline dots above rail (#2675，感谢 @akatsukiro)')
    expect(md).not.toContain('<details>')
    expect(md).not.toContain('<summary>')
    expect(md).not.toContain('## Contributors')
  })
})
