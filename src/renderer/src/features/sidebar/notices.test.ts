import { afterEach, describe, expect, it } from 'vitest'
import type { AgentId } from '@shared/thread'
import { i18n } from '@renderer/lib/i18n'
import type { HarnessItem } from '@renderer/features/updates/card-model'
import { noticeSummary, type Notices } from './notices'

afterEach(() => i18n.changeLanguage('en'))

const none: Notices = { signIn: [], update: null }

function harness(agentId: AgentId, name: string, to: string): HarnessItem {
  return {
    kind: 'harness',
    offer: { agentId, name, from: null, to, command: null, method: null, package: null },
    harnessId: agentId === 'codex' ? 'codex' : 'claude-code',
    agents: 1,
    running: 0,
    waiting: false,
    queued: false,
    skipped: false,
  }
}

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

  it('names the update card by its first line', () => {
    expect(
      noticeSummary({
        ...none,
        update: {
          kind: 'several',
          items: [
            { kind: 'app', notice: { kind: 'ready', version: '0.3.0' } },
            harness('claude-code', 'Claude Code', '2.1.310'),
            harness('codex', 'Codex', '2.2.3'),
          ],
        },
      }),
    ).toEqual({ labels: ['3 updates'], name: 'Notices: 3 updates' })
  })

  it('lists the sign-in first, then the update', () => {
    const summary = noticeSummary({
      signIn: ['Codex', 'Claude Code'],
      update: { kind: 'one', item: harness('claude-code', 'Claude Code', '2.1.310') },
    })
    expect(summary).toMatchObject({
      name: 'Notices: 2 agents need you to sign in, Claude Code 2.1.310 is out',
    })
  })

  it('speaks Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    expect(
      noticeSummary({
        ...none,
        signIn: ['Codex'],
        update: { kind: 'one', item: { kind: 'app', notice: { kind: 'ready', version: '0.3.0' } } },
      })?.name,
    ).toBe('通知：Codex 需要登录，Kettu 0.3.0 已就绪')
  })
})
