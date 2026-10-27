import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@renderer/lib/i18n'
import { noticeSummary, type Notices } from './notices'

afterEach(() => i18n.changeLanguage('en'))

const none: Notices = { signIn: [], agentUpdate: null, appUpdate: null }

describe('noticeSummary', () => {
  it('has nothing to show without a notice', () => {
    expect(noticeSummary(none)).toBeNull()
  })

  it('names a sign-in to do', () => {
    expect(noticeSummary({ ...none, signIn: ['Codex'] })).toEqual({
      labels: ['Codex needs you to sign in'],
      name: 'Notices: Codex needs you to sign in',
    })
  })

  it('names updates on offer', () => {
    expect(
      noticeSummary({
        ...none,
        agentUpdate: { kind: 'many', agentIds: ['claude-code', 'codex'] },
        appUpdate: { kind: 'ready', version: '0.3.0' },
      }),
    ).toEqual({
      labels: ['Agent updates 2', 'Update ready 0.3.0'],
      name: 'Notices: Agent updates 2, Update ready 0.3.0',
    })
  })

  it('lists all three in the footer order, the sign-in first', () => {
    const summary = noticeSummary({
      signIn: ['Codex', 'Claude Code'],
      agentUpdate: { kind: 'one', agentId: 'claude-code', name: 'Claude Code', version: '2.1.310' },
      appUpdate: { kind: 'available', version: '0.3.0', moves: false },
    })
    expect(summary).toMatchObject({
      name: 'Notices: 2 agents need you to sign in, Claude Code update 2.1.310, 0.3.0 is out',
    })
  })

  it('speaks Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(
      noticeSummary({ ...none, signIn: ['Codex'], appUpdate: { kind: 'ready', version: '0.3.0' } })
        ?.name,
    ).toBe('通知：Codex 需要登录，更新已就绪 0.3.0')
  })
})
