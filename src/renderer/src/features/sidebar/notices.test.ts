import { afterEach, describe, expect, it } from 'vitest'
import { i18n } from '@renderer/lib/i18n'
import { noticeSummary, type Notices } from './notices'

afterEach(() => i18n.changeLanguage('en'))

const none: Notices = { signIn: [], agentUpdate: null, appUpdate: null }

describe('noticeSummary', () => {
  it('has nothing to show without a notice', () => {
    expect(noticeSummary(none)).toBeNull()
  })

  it('reads a sign-in to do in the warning tone', () => {
    expect(noticeSummary({ ...none, signIn: ['Codex'] })).toEqual({
      count: 1,
      tone: 'warning',
      labels: ['Codex needs you to sign in'],
      name: 'Notices: Codex needs you to sign in',
    })
  })

  it('reads updates on offer in the info tone', () => {
    expect(
      noticeSummary({
        ...none,
        agentUpdate: { kind: 'many', agentIds: ['claude-code', 'codex'] },
        appUpdate: { kind: 'ready', version: '0.3.0' },
      }),
    ).toEqual({
      count: 2,
      tone: 'info',
      labels: ['Agent updates 2', 'Update ready 0.3.0'],
      name: 'Notices: Agent updates 2, Update ready 0.3.0',
    })
  })

  it('lists all three in the popover order, the sign-in first', () => {
    const summary = noticeSummary({
      signIn: ['Codex', 'Claude Code'],
      agentUpdate: { kind: 'one', agentId: 'claude-code', name: 'Claude Code', version: '2.1.310' },
      appUpdate: { kind: 'available', version: '0.3.0' },
    })
    expect(summary).toMatchObject({
      count: 3,
      tone: 'warning',
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
