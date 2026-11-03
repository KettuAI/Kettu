// Settings › Agents lists each account in the row, in English and Chinese, rendered to markup.

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccount, AgentDetails, AgentStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'

vi.stubGlobal('window', {
  kettu: { platform: 'darwin', remote: { activity: () => new Promise(() => {}) } },
  matchMedia: () => ({ matches: false, addEventListener: () => {} }),
})
// Server rendering runs no effect and reads a store's initial snapshot, so the test hands over the
// list, the hide-accounts setting and whether an account read is in progress.
const scope = vi.hoisted(() => ({
  hideAccount: false,
  agents: {
    order: [] as string[],
    byId: {} as Record<string, AgentStatus>,
    details: {} as Partial<Record<string, AgentDetails>>,
    hosts: {} as Record<string, unknown>,
  },
}))
const reads = vi.hoisted(() => ({ on: false }))
vi.mock('@renderer/stores/settings', async () => {
  const { DEFAULT_SETTINGS } = await import('@shared/settings')
  const state = () => ({
    settings: { ...DEFAULT_SETTINGS, privacy: { hideAccount: scope.hideAccount } },
    loaded: true,
    update: async () => {},
  })
  const useSettingsStore = (select?: (value: ReturnType<typeof state>) => unknown) =>
    select ? select(state()) : state()
  useSettingsStore.getState = state
  return { useSettingsStore }
})
vi.mock('@renderer/stores/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/stores/agents')>()
  const useAgentsStore = (select?: (value: typeof scope.agents) => unknown) =>
    select ? select(scope.agents) : scope.agents
  useAgentsStore.getState = () => scope.agents
  return { ...actual, useAgentsStore }
})
vi.mock('./agent-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-helpers')>()
  return {
    ...actual,
    useAgentReads: () => reads.on,
    useHasOtherAgents: (status: AgentStatus) =>
      scope.agents.order.some(
        (id) => id !== status.id && scope.agents.byId[id]?.harnessId === status.harnessId,
      ),
  }
})
vi.mock('@renderer/lib/use-now', () => ({ useNow: () => Date.now(), useSeconds: () => Date.now() }))
vi.mock('@renderer/components/refresh', () => ({
  useRefresh: () => ({ run: async (action: () => Promise<unknown>) => action(), phase: 'idle' }),
}))

const { i18n } = await import('@renderer/lib/i18n')
const { TooltipProvider } = await import('@renderer/components/ui/tooltip')
const { AgentListItem, AgentPage, AgentsGroupActions } = await import('./agents-section')
const { useAgentsSection } = await import('./section-defs')
const { matches } = await import('./model')

const EMAIL = 'alex@example.com'
const LONG_EMAIL = `${'a'.repeat(80)}@example.com`
const FOLDER = '/Users/alex/.claude-api'

function agent(
  overrides: Partial<Omit<AgentStatus, 'capabilities'>> & {
    capabilities?: Partial<AgentStatus['capabilities']>
  } = {},
): AgentStatus {
  return {
    id: 'claude-code',
    name: 'Claude Code',
    harnessId: 'claude-code',
    harnessName: 'Claude Code',
    isDefault: true,
    state: 'ready',
    signIn: 'signed-in',
    account: null,
    limits: [],
    detail: null,
    apiKey: null,
    authMethods: [],
    canLogout: false,
    capabilities: { account: true, reports: false },
    ...overrides,
  } as AgentStatus
}

function account(overrides: Partial<AgentAccount> = {}): AgentAccount {
  return { kind: 'account', label: 'Claude Pro', email: EMAIL, ...overrides }
}

function folderDetails(): AgentDetails {
  return {
    cliVersion: null,
    config: [{ id: 'folder', path: FOLDER, exists: true, env: null, chosen: true }],
  }
}

/** Puts the agents where the list reads them, and whether account details stay masked. */
function show(
  agents: AgentStatus[],
  details: AgentDetails | null = null,
  hideAccount = false,
): void {
  scope.agents.order = agents.map((status) => status.id)
  scope.agents.byId = Object.fromEntries(agents.map((status) => [status.id, status]))
  scope.agents.details = details && agents[0] ? { [agents[0].id]: details } : {}
  scope.hideAccount = hideAccount
}

function markup(element: ReactElement): string {
  return renderToStaticMarkup(createElement(TooltipProvider, null, element))
}

/** The markup's text, tags and entities left out. */
function text(element: ReactElement): string {
  return markup(element)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

afterEach(async () => {
  reads.on = false
  show([])
  await i18n.changeLanguage('en')
})

describe('an agent row', () => {
  it('shows the email in the list while accounts stay hidden, and the plan beside the harness', () => {
    const status = agent({
      account: account(),
      limits: [
        {
          window: 'seven_day',
          label: 'Weekly',
          usedPercent: 75,
          resetsAt: null,
          state: 'ok',
          observedAt: 1,
        },
      ],
      capabilities: { account: true, reports: true },
    })
    const other = agent({
      id: 'claude-code~personal' as AgentId,
      name: 'Personal',
      isDefault: false,
      account: account({ email: 'other@example.com' }),
    })
    show([status, other], null, true)
    const row = text(createElement(AgentListItem, { status }))
    expect(row).toContain(EMAIL)
    expect(row).toContain('Default')
    expect(row).toContain('Claude Pro')
    expect(row).toContain('75%')
    expect(markup(createElement(AgentListItem, { status }))).not.toContain('blur-mask')
  })

  it('keeps a long email whole, in the row and in its title', () => {
    const status = agent({ account: account({ email: LONG_EMAIL }) })
    show([status], null, true)
    const html = markup(createElement(AgentListItem, { status }))
    expect(html).toContain(`title="${LONG_EMAIL}"`)
    expect(text(createElement(AgentListItem, { status }))).toContain(LONG_EMAIL)
  })

  it('names an API key by its login and shows the configuration folder, not a key or an address', () => {
    const status = agent({
      id: 'claude-code~api' as AgentId,
      name: 'API',
      isDefault: false,
      account: { kind: 'api_key', label: 'Anthropic API key', email: null },
      apiKey: { set: true, providers: true },
    })
    show([status], folderDetails())
    const html = markup(createElement(AgentListItem, { status }))
    const row = text(createElement(AgentListItem, { status }))
    expect(row).toContain('Anthropic API key')
    expect(row.split('Anthropic API key')).toHaveLength(2)
    expect(html).toContain(`title="${FOLDER}"`)
    expect(html).not.toContain('api.anthropic.com')
    expect(row).not.toContain('sk-')
    expect(row).toContain('No plan usage')
  })

  it('adds a tier to the plan once, and not when the plan already names it', () => {
    const tiered = agent({ account: account({ label: 'Claude Max', tier: '5x' }) })
    show([tiered])
    expect(text(createElement(AgentListItem, { status: tiered }))).toContain('Claude Max (5x)')
    const named = agent({ account: account({ label: 'Claude Max 5x', tier: '5x' }) })
    show([named])
    const row = text(createElement(AgentListItem, { status: named }))
    expect(row).toContain('Claude Max 5x')
    expect(row).not.toContain('Claude Max 5x (5x)')
  })

  it('says when it is reading, when nothing was provided, and when a sign-in is required', async () => {
    const bare = agent({ account: null, signIn: 'unknown' })
    reads.on = true
    show([bare])
    expect(text(createElement(AgentListItem, { status: bare }))).toContain('Reading the account…')

    const unsigned = agent({
      account: null,
      signIn: 'unknown',
      capabilities: { account: false, reports: false },
    })
    show([unsigned])
    expect(text(createElement(AgentListItem, { status: unsigned }))).toContain(
      'No account reported',
    )
    expect(text(createElement(AgentListItem, { status: unsigned }))).not.toContain(
      'Reading the account…',
    )

    reads.on = false
    const empty = agent({ account: null })
    show([empty])
    expect(text(createElement(AgentListItem, { status: empty }))).toContain('No account reported')

    const needsLogin = agent({ account: null, signIn: 'required', state: 'available' })
    reads.on = true
    show([needsLogin])
    const login = text(createElement(AgentListItem, { status: needsLogin }))
    expect(login).toContain('needs you to sign in')
    expect(login).toContain('Sign in')
    expect(login).not.toContain('Reading the account…')
    expect(login).not.toContain('No account reported')

    await i18n.changeLanguage('zh-CN')
    reads.on = false
    show([empty])
    expect(text(createElement(AgentListItem, { status: empty }))).toContain('未提供账号信息')
  })

  it('keeps a failure or a missing program ahead of the account line', () => {
    const failed = agent({
      state: 'failed',
      detail: 'The adapter exited before it was ready.',
      account: account(),
    })
    show([failed])
    const failure = text(createElement(AgentListItem, { status: failed }))
    expect(failure).toContain('The adapter exited before it was ready.')
    expect(failure).not.toContain('No account reported')

    const missing = agent({
      state: 'not-installed',
      detail: 'Claude Code was not found on PATH.',
      account: null,
    })
    show([missing])
    const gone = text(createElement(AgentListItem, { status: missing }))
    expect(gone).toContain('Claude Code was not found on PATH.')
    expect(gone).not.toContain('No account reported')
    expect(gone).not.toContain('Reading the account…')
  })
})

describe('the agent page', () => {
  it('shows the email as itself while accounts stay hidden', () => {
    const status = agent({ account: account() })
    show([status], null, true)
    const html = markup(createElement(AgentPage, { agentId: status.id }))
    expect(html).toContain(EMAIL)
    expect(html).not.toContain('blur-mask')
    expect(html).not.toContain('data-slot="masked"')
  })
})

describe('the group actions', () => {
  it('only adds an agent, with accounts hidden or not', () => {
    show([], null, true)
    const hidden = text(createElement(AgentsGroupActions))
    expect(hidden).toContain('Add agent')
    expect(hidden).not.toContain('Hide accounts')
    expect(hidden).not.toContain('Show accounts')
    expect(markup(createElement(AgentsGroupActions))).not.toContain('aria-pressed')
    show([], null, false)
    expect(text(createElement(AgentsGroupActions))).not.toContain('Hide accounts')
  })
})

describe('search', () => {
  it('finds a row by the email it shows, even while accounts stay hidden', () => {
    const status = agent({ account: account() })
    show([status], null, true)
    let keywords = ''
    const Probe = () => {
      const section = useAgentsSection()
      keywords = section.rows.find((row) => row.id === status.id)?.keywords ?? ''
      return null
    }
    renderToStaticMarkup(createElement(Probe))
    expect(keywords).toContain(EMAIL)
    expect(
      matches(
        {
          id: status.id,
          name: status.name,
          description: status.account?.label,
          keywords,
          render: () => null,
        },
        EMAIL,
      ),
    ).toBe(true)
  })
})
