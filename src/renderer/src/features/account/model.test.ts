import { describe, expect, it } from 'vitest'
import type { AccountStatus } from '@shared/account'
import type { AgentStatus, PlanLimit } from '@shared/agent-host'
import { THIS_COMPUTER } from '@renderer/stores/view'
import { chosenHost, identityOf, limitRows, systemName } from './model'

const signedIn = (name: string | null, avatar: string | null = null): AccountStatus => ({
  state: 'signed-in',
  account: { id: 'a', email: 'you@example.com', name, avatar },
  subscription: 'none',
  manageUrl: 'https://example.com/account',
  plainText: false,
})

describe('identityOf', () => {
  it('names the account, or its email without a name, with an initial', () => {
    expect(identityOf(signedIn('amigoer'))).toEqual({
      signedIn: true,
      name: 'amigoer',
      email: 'you@example.com',
      initial: 'A',
      avatar: null,
    })
    expect(identityOf(signedIn(null)).name).toBe('you@example.com')
    expect(identityOf(signedIn('  ')).initial).toBe('Y')
  })

  it('names nobody while signed out or unknown', () => {
    expect(identityOf(null).signedIn).toBe(false)
    expect(identityOf({ state: 'signing-in' })).toMatchObject({ name: null, initial: null })
  })
})

const limit = (usedPercent: number | null, overrides: Partial<PlanLimit> = {}): PlanLimit => ({
  window: 'five_hour',
  label: '5-hour',
  usedPercent,
  resetsAt: null,
  state: 'ok',
  observedAt: 0,
  ...overrides,
})

const agent = (overrides: Partial<AgentStatus>): AgentStatus =>
  ({
    id: 'claude-code',
    name: 'Claude Code',
    account: null,
    limits: [],
    ...overrides,
  }) as AgentStatus

describe('limitRows', () => {
  it("shows each agent's fullest window with its plan, by the three-color rule", () => {
    expect(
      limitRows(
        [
          agent({
            account: { kind: 'account', label: 'Claude Max', email: null },
            limits: [limit(12), limit(74.4, { window: 'seven_day' })],
          }),
          agent({ id: 'codex', name: 'Codex', limits: [limit(91)] }),
          agent({ id: 'codex~work', name: 'Work', limits: [limit(null)] }),
        ],
        0,
      ),
    ).toEqual([
      { agentId: 'claude-code', label: 'Claude Code · Claude Max', percent: 74, level: 'warn' },
      { agentId: 'codex', label: 'Codex', percent: 91, level: 'bad' },
    ])
  })
})

describe('chosenHost', () => {
  it('checks the host the sidebar is narrowed to, or every host', () => {
    expect(chosenHost(null, ['dev-box'])).toBeNull()
    expect(chosenHost(THIS_COMPUTER, ['dev-box'])).toBe(THIS_COMPUTER)
    expect(chosenHost('dev-box', ['dev-box'])).toBe('dev-box')
    expect(chosenHost('gone', ['dev-box'])).toBeNull()
  })
})

describe('systemName', () => {
  it('leaves out the architecture', () => {
    expect(systemName('macOS 26.1 (arm64)')).toBe('macOS 26.1')
    expect(systemName('Ubuntu 24.04')).toBe('Ubuntu 24.04')
  })
})
