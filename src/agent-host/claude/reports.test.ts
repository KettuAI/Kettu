import { describe, expect, it } from 'vitest'
import { mapAccount, mapContextUsage } from './reports'

describe('mapAccount', () => {
  it('reads a subscription sign-in as an account', () => {
    expect(
      mapAccount({ subscriptionType: 'max', tokenSource: 'claude.ai', apiProvider: 'firstParty' }),
    ).toMatchObject({ kind: 'account', label: 'Claude Max' })
  })

  it('keeps a subscription token from CLAUDE_CODE_OAUTH_TOKEN an account', () => {
    expect(
      mapAccount({ subscriptionType: 'pro', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' }),
    ).toMatchObject({ kind: 'account', label: 'Claude Pro' })
  })

  it('reads an API key as an API key', () => {
    expect(mapAccount({ apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' })).toEqual({
      kind: 'api_key',
      label: 'Anthropic API key',
      email: null,
    })
  })

  // Claude Code names only the token's source for a bearer token, such as a key for another
  // provider's address, and the stored sign-in must not stand in for it.
  it('reads ANTHROPIC_AUTH_TOKEN as a gateway, not as the stored subscription', () => {
    expect(mapAccount({ tokenSource: 'ANTHROPIC_AUTH_TOKEN', apiProvider: 'firstParty' })).toEqual({
      kind: 'gateway',
      label: 'Custom model gateway',
      email: null,
    })
  })

  it('lets ANTHROPIC_AUTH_TOKEN win over a subscription the same answer names', () => {
    expect(
      mapAccount({ subscriptionType: 'max', tokenSource: 'ANTHROPIC_AUTH_TOKEN' }),
    ).toMatchObject({ kind: 'gateway' })
  })
})

describe('mapContextUsage', () => {
  const answer = (paths: string[]) => ({
    categories: [{ name: 'Memory files', tokens: 900 }],
    totalTokens: 900,
    maxTokens: 200_000,
    memoryFiles: paths.map((path) => ({ path, type: 'Project', tokens: 300 })),
  })
  const places = { cwd: '/work/app', home: '/home/me' }
  const names = (paths: string[]) =>
    mapContextUsage(answer(paths), 0, places).lists.find((l) => l.name === 'Memory Files')?.items

  it('names memory files from the session folder, then the home folder', () => {
    expect(
      names(['/work/app/CLAUDE.md', '/work/app/design/AGENTS.md', '/home/me/.claude/CLAUDE.md']),
    ).toEqual([
      { name: 'CLAUDE.md', detail: null, tokens: '300' },
      { name: 'design/AGENTS.md', detail: null, tokens: '300' },
      { name: '~/.claude/CLAUDE.md', detail: null, tokens: '300' },
    ])
  })

  it('keeps a path outside both folders whole', () => {
    expect(names(['/etc/claude/CLAUDE.md', '/work/apple/CLAUDE.md'])?.map((i) => i.name)).toEqual([
      '/etc/claude/CLAUDE.md',
      '/work/apple/CLAUDE.md',
    ])
  })
})
