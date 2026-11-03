// Settings › Agents lists each account in the row, in English and Chinese, rendered to markup.

import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccount, AgentDetails, AgentOptions, AgentStatus } from '@shared/agent-host'
import type { AgentId, ConfigOption } from '@shared/thread'

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
// The start mode row's inputs: the stored modes, the cached options and why a save failed.
const modes = vi.hoisted(() => ({
  stored: {} as Record<string, string>,
  options: {
    byId: {} as Record<string, unknown>,
    hosts: {} as Record<string, unknown>,
    loaded: true,
    error: null as string | null,
  },
  saveError: null as string | null,
}))
vi.mock('@renderer/stores/settings', async () => {
  const { DEFAULT_SETTINGS } = await import('@shared/settings')
  const state = () => ({
    settings: {
      ...DEFAULT_SETTINGS,
      startModes: modes.stored,
      privacy: { hideAccount: scope.hideAccount },
    },
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
vi.mock('@renderer/stores/agent-options', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/stores/agent-options')>()
  const useAgentOptionsStore = (select?: (value: typeof modes.options) => unknown) =>
    select ? select(modes.options) : modes.options
  useAgentOptionsStore.getState = () => modes.options
  return { ...actual, useAgentOptionsStore }
})
vi.mock('./use-apply', () => ({ useApply: () => [() => {}, modes.saveError] }))
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
const { FOLLOW_AGENT, startModeView } = await import('./agent-helpers')
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
  modes.stored = {}
  modes.options = { byId: {}, hosts: {}, loaded: true, error: null }
  modes.saveError = null
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

describe("the agent page's mode for new sessions", () => {
  const modeOption: ConfigOption = {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    value: 'default',
    choices: [
      { value: 'default', name: 'Ask before edits' },
      { value: 'acceptEdits', name: 'Accept edits' },
      { value: 'bypassPermissions', name: 'Full access' },
    ],
  }
  const cached = (agentId: AgentId, over: Partial<AgentOptions> = {}): void => {
    modes.options.byId = {
      [agentId]: {
        agentId,
        config: [modeOption],
        levels: {},
        remembered: {},
        observedAt: 1,
        ...over,
      },
    }
  }
  const page = (status: AgentStatus) => {
    show([status])
    return {
      html: markup(createElement(AgentPage, { agentId: status.id })),
      words: text(createElement(AgentPage, { agentId: status.id })),
    }
  }
  const NAME = 'Mode for new sessions'

  it('follows Claude Code until a mode is chosen, and says so for Codex', () => {
    cached('claude-code')
    const claude = page(agent())
    expect(claude.words).toContain(NAME)
    expect(claude.words).toContain('Follow Claude Code')
    expect(claude.html).not.toMatch(/data-disabled/)
    cached('codex')
    const codex = page(
      agent({ id: 'codex', name: 'Codex', harnessId: 'codex', harnessName: 'Codex' }),
    )
    expect(codex.words).toContain('Follow Codex (Auto review)')
  })

  it('shows the chosen mode by the name the agent gives it', () => {
    cached('claude-code')
    modes.stored = { 'claude-code': 'acceptEdits' }
    const { words } = page(agent())
    expect(words).toContain('Accept edits')
    expect(words).not.toContain('Follow Claude Code')
  })

  it('shows a chosen mode the agent no longer lists, marked, and leaves it to change', () => {
    cached('claude-code')
    modes.stored = { 'claude-code': 'auto' }
    const { words, html } = page(agent())
    expect(words).toContain('auto (no longer offered)')
    expect(html).not.toMatch(/data-disabled/)
  })

  it('waits behind a placeholder while the cached options load', () => {
    modes.options.loaded = false
    const { words, html } = page(agent())
    expect(words).toContain(NAME)
    expect(html).toContain('data-slot="skeleton"')
    expect(words).not.toContain('Follow Claude Code')
  })

  it('is disabled with its reason for an agent that has not been used', () => {
    const unused = page(agent())
    expect(unused.words).toContain('Available once this agent has been used.')
    expect(unused.html).toMatch(/data-disabled/)
    // A loaded session gives the model's options alone, which has no mode to choose.
    cached('claude-code', {
      provisional: true,
      config: [{ ...modeOption, id: 'model', category: 'model' }],
    })
    const provisional = page(agent())
    expect(provisional.words).toContain('Available once this agent has been used.')
    expect(provisional.html).toMatch(/data-disabled/)
  })

  it('is disabled with its reason when the options could not be read', () => {
    modes.options.error = 'The host did not answer'
    const { words, html } = page(agent())
    expect(words).toContain('Couldn’t read this agent’s modes.')
    expect(words).not.toContain('Available once this agent has been used.')
    expect(html).toMatch(/data-disabled/)
  })

  it('says under the row why a change was not saved', () => {
    cached('claude-code')
    modes.saveError = 'The host is busy'
    const { words } = page(agent())
    expect(words).toContain('The host is busy')
  })

  it('has no row for an agent whose harness takes no start mode', () => {
    cached('opencode')
    const { words } = page(
      agent({ id: 'opencode', name: 'OpenCode', harnessId: 'opencode', harnessName: 'OpenCode' }),
    )
    expect(words).not.toContain(NAME)
  })

  it('reads in Chinese', async () => {
    await i18n.changeLanguage('zh-CN')
    cached('claude-code')
    expect(page(agent()).words).toContain('新会话的模式')
    expect(page(agent()).words).toContain('跟随 Claude Code')
    cached('codex')
    const codex = page(
      agent({ id: 'codex', name: 'Codex', harnessId: 'codex', harnessName: 'Codex' }),
    )
    expect(codex.words).toContain('跟随 Codex（自动审查）')
  })
})

describe('the modes the row offers', () => {
  const mode = (choices: string[], over: Partial<ConfigOption> = {}): ConfigOption => ({
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    value: choices[0]!,
    choices: choices.map((value) => ({ value, name: value.toUpperCase() })),
    ...over,
  })
  const entry = (config: ConfigOption[], over: Partial<AgentOptions> = {}): AgentOptions => ({
    agentId: 'claude-code',
    config,
    levels: {},
    remembered: {},
    observedAt: 1,
    ...over,
  })
  const view = (
    over: Partial<Parameters<typeof startModeView>[0]> = {},
  ): ReturnType<typeof startModeView> =>
    startModeView({
      agentId: 'claude-code',
      entry: entry([mode(['default', 'plan'])]),
      loaded: true,
      failed: false,
      stored: undefined,
      ...over,
    })

  it('are the ones the agent last listed, without full access', () => {
    const listed = view({
      entry: entry([mode(['default', 'acceptEdits', 'bypassPermissions', 'agent-full-access'])]),
    })
    expect(listed.state).toBe('ready')
    expect(listed.value).toBe(FOLLOW_AGENT)
    expect(listed.choices.map((c) => [c.value, c.name, c.offered])).toEqual([
      ['default', 'DEFAULT', true],
      ['acceptEdits', 'ACCEPTEDITS', true],
    ])
  })

  it('show the stored mode as chosen', () => {
    expect(view({ stored: 'plan' })).toMatchObject({ state: 'ready', value: 'plan' })
  })

  it('keep a stored mode the agent no longer lists, marked as not offered', () => {
    const kept = view({ stored: 'auto' })
    expect(kept.value).toBe('auto')
    expect(kept.choices.at(-1)).toEqual({ value: 'auto', name: 'auto', offered: false })
    expect(kept.choices.filter((c) => c.offered)).toHaveLength(2)
  })

  it('never choose a stored mode that gives full access', () => {
    const full = view({ stored: 'bypassPermissions' })
    expect(full.value).toBe(FOLLOW_AGENT)
    expect(full.choices.map((c) => c.value)).toEqual(['default', 'plan'])
  })

  it('wait while the cached options load', () => {
    expect(view({ loaded: false, entry: undefined })).toMatchObject({ state: 'loading' })
  })

  it('are unknown for an agent that was not used, or whose options carry no mode', () => {
    expect(view({ entry: undefined })).toMatchObject({ state: 'unused', choices: [] })
    const provisional = entry([mode(['small'], { id: 'model', category: 'model' })], {
      provisional: true,
    })
    expect(view({ entry: provisional })).toMatchObject({ state: 'unused', choices: [] })
    expect(view({ entry: entry([mode([])]) })).toMatchObject({ state: 'unused' })
    // The stored mode still shows, though it cannot be changed yet.
    expect(view({ entry: undefined, stored: 'plan' })).toMatchObject({
      state: 'unused',
      value: 'plan',
    })
  })

  it('are unknown when reading them failed, unless some were read before', () => {
    expect(view({ entry: undefined, failed: true })).toMatchObject({ state: 'failed' })
    expect(view({ failed: true })).toMatchObject({ state: 'ready' })
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
