import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { ToolEntry } from '@shared/thread'
import type { WorkflowSuggestion } from '@shared/workflow'
import { onAppEvent, type AppEvent } from '@renderer/app/events'
import { resetSuggestionsStore, useSuggestionsStore } from '@renderer/stores/workflow-suggestions'
import { matchesFocusComposer } from '../composer/use-prompt-box'
import { WorkflowEditStrip } from '../composer/workflow-edit-strip'
import { SuggestionCard } from './suggestion-card'
import { canEditSuggestion } from './workflow-tools'

let mockSessionsById: Record<string, SessionSummary> = {}
let mockPane: {
  paneId: string
  view: { kind: 'session'; sessionId: string }
  focused: boolean
  cornered: boolean
  split: boolean
} | null = null
let mockOtherHost: { id: string; connection: string } | null = null
type CapturedApprovalProps = {
  className?: string
  editLabel?: string
  onEdit?: () => void
  preview?: ReactNode
}

const approvalCapture = {
  last: null as CapturedApprovalProps | null,
  clear() {
    this.last = null
  },
}

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@renderer/lib/host', () => ({
  host: vi.fn(),
  hostAt: vi.fn(),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  sessionHost: () => null,
}))

vi.mock('@renderer/lib/platform', () => ({
  platform: 'darwin',
  isMac: true,
  isWindows: false,
  isWeb: false,
  isMod: () => false,
}))

vi.mock('./helpers', () => ({
  revealWaiting: () => undefined,
}))

vi.mock('@renderer/stores/workflow-suggestions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/stores/workflow-suggestions')>()
  // React renderToStaticMarkup reads Zustand's getInitialState() snapshot; delegate selector reads
  // to the real live store state so SSR component tests observe real store transitions.
  const store = Object.assign(
    <T>(selector: (state: ReturnType<typeof actual.useSuggestionsStore.getState>) => T): T =>
      selector(actual.useSuggestionsStore.getState()),
    actual.useSuggestionsStore,
  )
  return {
    ...actual,
    useSuggestionsStore: store,
    useSuggestion: (id: string | null) => ({
      card: id ? (actual.useSuggestionsStore.getState().byId[id] ?? null) : null,
      status: id && actual.useSuggestionsStore.getState().byId[id] ? 'loaded' : 'loading',
      error: null,
      retry: () => undefined,
    }),
  }
})

vi.mock('@renderer/stores/host-scope', () => ({
  LOCAL_SCOPE: { hostId: null },
  hostScope: (hostId: string) => ({ hostId }),
  HostScopeContext: {
    Provider: ({ children }: { children?: ReactNode }) => children,
  },
  useHostScope: () => ({
    hostId: null,
    useSettingsStore: () => null,
    useMarketplaceStore: { getState: () => ({ connections: {}, loadConnections: vi.fn() }) },
  }),
}))

vi.mock('@renderer/stores/sessions', () => ({
  useSessionsStore: <T>(selector: (state: { byId: Record<string, SessionSummary> }) => T) =>
    selector({ byId: mockSessionsById }),
  hostOfSession: () => null,
  sessionArchived: (byId: Record<string, SessionSummary>, sessionId: string) =>
    byId[sessionId]?.archivedAt != null,
}))

vi.mock('@renderer/stores/hosts', () => ({
  useOtherHost: () => mockOtherHost,
  isAway: (connection: string) => connection === 'offline',
}))

vi.mock('@renderer/features/split/pane-context', () => ({
  usePane: () => mockPane,
}))

vi.mock('@renderer/features/session/use-thread', () => ({
  useSessionView: () => undefined,
}))

vi.mock('@renderer/components/affect/approval-card', () => ({
  ApprovalCard: (props: CapturedApprovalProps) => {
    approvalCapture.last = props
    return createElement(
      'div',
      { className: props.className, 'data-has-edit': props.onEdit ? 'true' : 'false' },
      props.preview,
    )
  },
}))

vi.mock('@renderer/components/affect/app-shell', () => ({
  Icon: () => null,
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) =>
    createElement('button', { type: 'button', onClick }, children),
}))

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DialogContent: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))

vi.mock('@renderer/components/ui/spinner', () => ({
  Spinner: () => null,
}))

vi.mock('@renderer/features/marketplace/connect', () => ({
  ConnectButton: () => null,
}))

vi.mock('@renderer/features/marketplace/hooks', () => ({
  useConnection: () => null,
}))

vi.mock('@renderer/features/marketplace/listing', () => ({
  InstallButton: () => null,
}))

vi.mock('@renderer/features/shell/glyph', () => ({
  Glyph: () => null,
}))

vi.mock('@renderer/features/tasks/chart-morph', () => ({
  chartShown: () => undefined,
  chartToTask: () => undefined,
  holdChart: () => undefined,
}))

vi.mock('@renderer/features/tasks/workflow-chart', () => ({
  WorkflowChart: () => createElement('div', { 'data-testid': 'workflow-chart' }),
}))

vi.mock('../new-session/open-task', () => ({
  openTask: () => undefined,
  openWorkflowMarketplace: () => undefined,
}))

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 's1',
    agentId: 'codex',
    projectPath: '/tmp/project',
    title: 'Test session',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
    permissionCount: 0,
    ...overrides,
  } as SessionSummary
}

function makeCard(overrides: Partial<WorkflowSuggestion> = {}): WorkflowSuggestion {
  return {
    id: 'wfs-abcdefghij23',
    sessionId: 's1',
    purpose: 'start',
    source: { kind: 'draft', draftId: 'draft:abcdefghij23' },
    workflow: {
      format: 1,
      name: 'Theme Refresh',
      description: 'Update theme and review',
      locales: {},
      sendBackLimit: 3,
      steps: [
        {
          id: 'update',
          name: 'Update theme',
          prompt: 'Apply theme updates',
          by: 'agent',
          handIn: 'outcome',
          outcomes: [{ name: 'Done', to: [], end: 'done', limit: null }],
          youReview: false,
          hint: null,
          reviewOf: [],
          tools: { mcp: [], skills: [] },
        },
      ],
    },
    hash: 'a'.repeat(64),
    approves: true,
    task: 'Refresh the theme',
    title: 'Theme Refresh',
    pace: 'balanced',
    paceReason: 'Standard scope',
    agentId: 'codex',
    tools: [],
    facts: { pastMs: null, runs: 0, worktree: true },
    answer: { kind: 'waiting' },
    createdAt: 1,
    ...overrides,
  }
}

function makeEntry(cardId: string): ToolEntry {
  return {
    kind: 'tool',
    id: 'tool-1',
    title: 'mcp__kettu__suggest_workflow',
    toolKind: 'other',
    status: 'completed',
    content: [],
    locations: [],
    permission: null,
    permissionResult: null,
    structured: { suggestion: { id: cardId } },
  }
}

describe('SuggestionCard Edit action', () => {
  beforeEach(() => {
    mockSessionsById = { s1: makeSummary() }
    mockPane = {
      paneId: 'pane-2',
      view: { kind: 'session', sessionId: 's1' },
      focused: false,
      cornered: false,
      split: true,
    }
    mockOtherHost = null
    approvalCapture.clear()
  })

  afterEach(() => {
    resetSuggestionsStore()
  })

  it('activates workflow edit mode and emits a targeted focus-composer event for draft, library, marketplace and save cards', () => {
    const variants: WorkflowSuggestion[] = [
      makeCard({
        id: 'wfs-draftcard234',
        source: { kind: 'draft', draftId: 'draft:abcdefghij23' },
      }),
      makeCard({
        id: 'wfs-library23456',
        source: { kind: 'library', workflowId: 'bug-fix' },
      }),
      makeCard({
        id: 'wfs-market234567',
        source: {
          kind: 'marketplace',
          listingId: 'lst_01J9Z3K4V5W6X7Y8Z9A0B1C2D3',
          version: '1.0.0',
          handle: 'kettu-labs',
          slug: 'feature',
          official: true,
          installs: 42,
        },
      }),
      makeCard({
        id: 'wfs-savecard2345',
        purpose: 'save',
        source: { kind: 'draft', draftId: 'draft:234567abcdef' },
      }),
    ]

    const events: AppEvent[] = []
    const unsub = onAppEvent((event) => events.push(event))
    try {
      for (const card of variants) {
        events.length = 0
        approvalCapture.clear()
        useSuggestionsStore.getState().receive(card)

        renderToStaticMarkup(
          createElement(SuggestionCard, {
            sessionId: 's1',
            entry: makeEntry(card.id),
            agent: 'Codex',
          }),
        )

        const captured = approvalCapture.last
        expect(captured?.onEdit).toBeTypeOf('function')
        captured!.onEdit!()

        expect(useSuggestionsStore.getState().editing['s1']?.cardId).toBe(card.id)
        expect(events).toEqual([{ kind: 'focus-composer', sessionId: 's1', paneId: 'pane-2' }])

        const editingHtml = renderToStaticMarkup(
          createElement(SuggestionCard, {
            sessionId: 's1',
            entry: makeEntry(card.id),
            agent: 'Codex',
          }),
        )
        expect(editingHtml).toContain('ks-suggest--editing')
        expect(editingHtml).toContain('ks-suggest__editing')
        expect(editingHtml).toContain('workflow.card.editingHint')
        expect(editingHtml).toContain('workflow.card.cancelEdit')
      }
    } finally {
      unsub()
    }
  })

  it('hides Edit when the session has no live composer (archived, away, subagent, or removed worktree)', () => {
    expect(
      canEditSuggestion({
        waiting: true,
        away: false,
        archived: false,
        origin: undefined,
        worktreeState: 'ready',
      }),
    ).toBe(true)
    expect(
      canEditSuggestion({
        waiting: false,
        away: false,
        archived: false,
        origin: undefined,
        worktreeState: 'ready',
      }),
    ).toBe(false)
    expect(
      canEditSuggestion({
        waiting: true,
        away: true,
        archived: false,
        origin: undefined,
        worktreeState: 'ready',
      }),
    ).toBe(false)
    expect(
      canEditSuggestion({
        waiting: true,
        away: false,
        archived: true,
        origin: undefined,
        worktreeState: 'ready',
      }),
    ).toBe(false)
    expect(
      canEditSuggestion({
        waiting: true,
        away: false,
        archived: false,
        origin: 'subagent',
        worktreeState: 'ready',
      }),
    ).toBe(false)
    expect(
      canEditSuggestion({
        waiting: true,
        away: false,
        archived: false,
        origin: undefined,
        worktreeState: 'gone',
      }),
    ).toBe(false)

    const card = makeCard()
    useSuggestionsStore.getState().receive(card)
    mockSessionsById = { s1: makeSummary({ archivedAt: 100 }) }

    const html = renderToStaticMarkup(
      createElement(SuggestionCard, {
        sessionId: 's1',
        entry: makeEntry(card.id),
        agent: 'Codex',
      }),
    )
    expect(html).toContain('data-has-edit="false"')
    expect(approvalCapture.last?.onEdit).toBeUndefined()
  })

  it('renders WorkflowEditStrip with workflow name, hint and cancel action for both start and save cards', () => {
    const startHtml = renderToStaticMarkup(
      createElement(WorkflowEditStrip, {
        workflowName: 'Theme Refresh',
        agentName: 'Codex',
        onCancel: () => undefined,
      }),
    )
    expect(startHtml).toContain('workflowEdit.title')
    expect(startHtml).toContain('Theme Refresh')
    expect(startHtml).toContain('workflowEdit.hint')
    expect(startHtml).toContain('workflowEdit.cancel')

    const saveHtml = renderToStaticMarkup(
      createElement(WorkflowEditStrip, {
        workflowName: 'Release Flow',
        agentName: 'Claude Code',
        save: true,
        onCancel: () => undefined,
      }),
    )
    expect(saveHtml).toContain('workflowEdit.saveHint')
    expect(saveHtml).toContain('Release Flow')
  })

  it('routes focus-composer to the matching split pane even before pane focus flushes', () => {
    // Unfocused split pane targeted explicitly by paneId still receives focus immediately.
    expect(
      matchesFocusComposer(
        { sessionId: 's1', paneId: 'pane-2' },
        { sessionId: 's1', paneId: 'pane-2', focused: false },
      ),
    ).toBe(true)

    // Another pane (even if focused, or showing the same session) is not stolen.
    expect(
      matchesFocusComposer(
        { sessionId: 's1', paneId: 'pane-2' },
        { sessionId: 's1', paneId: 'pane-1', focused: true },
      ),
    ).toBe(false)
    expect(
      matchesFocusComposer(
        { sessionId: 's1', paneId: 'pane-2' },
        { sessionId: 's2', paneId: 'pane-1', focused: true },
      ),
    ).toBe(false)

    // Single-pane (paneId null) matches by sessionId.
    expect(
      matchesFocusComposer(
        { sessionId: 's1', paneId: null },
        { sessionId: 's1', paneId: null, focused: false },
      ),
    ).toBe(true)
    expect(
      matchesFocusComposer(
        { sessionId: 's1', paneId: null },
        { sessionId: 's2', paneId: null, focused: true },
      ),
    ).toBe(false)

    // Unscoped focus-composer preserves legacy behavior: only the focused pane responds.
    expect(matchesFocusComposer({}, { sessionId: 's1', paneId: 'pane-1', focused: true })).toBe(
      true,
    )
    expect(matchesFocusComposer({}, { sessionId: 's1', paneId: 'pane-2', focused: false })).toBe(
      false,
    )
  })
})
