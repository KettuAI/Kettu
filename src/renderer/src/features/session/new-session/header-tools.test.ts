import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, SessionSummary } from '@shared/agent-host'
import type { TerminalInfo } from '@shared/terminal-host'
import { onHost } from '@renderer/lib/host-paths'

const headerToolsCalls: Array<{ projectPath: string; panel: string }> = []
let closePaneCalls = 0
const terminalsRpcMock = vi.fn()
let mockSessionsById: Record<string, SessionSummary> = {}

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@renderer/stores/sessions', () => ({
  useSessionsStore: <T>(
    selector: (state: { byId: Record<string, SessionSummary>; loaded: boolean }) => T,
  ) => selector({ byId: mockSessionsById, loaded: true }),
  hostOfSession: () => null,
  sessionTitle: (summary: SessionSummary) => summary.title ?? summary.id,
}))

vi.mock('@renderer/features/shell/header-tools', () => ({
  HeaderTools: (props: { projectPath: string; panel: string }) => {
    headerToolsCalls.push({ projectPath: props.projectPath, panel: props.panel })
    return createElement('div', {
      'data-testid': 'header-tools',
      'data-project-path': props.projectPath,
      'data-panel': props.panel,
    })
  },
  ClosePaneButton: () => {
    closePaneCalls += 1
    return createElement('button', { 'data-testid': 'close-pane-button' })
  },
}))

vi.mock('@renderer/features/shell/top-bar', () => ({
  TopBar: ({ children }: { children?: ReactNode }) => createElement('header', null, children),
  NoDrag: ({ children, className }: { children?: ReactNode; className?: string }) =>
    createElement('div', { className }, children),
}))

vi.mock('@renderer/features/split/pane-context', () => ({
  usePane: () => ({ paneId: 'pane-1', focused: true, cornered: false, split: false }),
}))

vi.mock('@renderer/features/session/session-header', () => ({
  ParentLink: ({ parent }: { parent: SessionSummary }) =>
    createElement('span', { 'data-testid': 'parent-link' }, parent.id),
}))

vi.mock('@renderer/features/session/session-states', () => ({
  ColumnScroller: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))

vi.mock('@renderer/features/github-star/star-prompts', () => ({
  StarLine: () => null,
}))

vi.mock('@renderer/features/session/attachments/drop-overlay', () => ({
  DropOverlay: () => null,
}))

vi.mock('@renderer/features/session/attachments/use-file-drop', () => ({
  useFileDrop: () => ({ over: false, handlers: {} }),
}))

vi.mock('@renderer/components/affect/chat-composer', () => ({
  ChatComposer: () => null,
}))

vi.mock('@renderer/components/affect/assistant-home', () => ({
  FolderMark: () => null,
}))

vi.mock('@renderer/components/agents/agent-mark', () => ({
  AgentMark: () => null,
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: () => null,
}))

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TooltipTrigger: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  TooltipContent: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))

vi.mock('@renderer/features/agents/fix-button', () => ({
  FixButton: () => null,
}))

vi.mock('@renderer/features/agents/harness-problem', () => ({
  FIX_URLS: {},
  reasonLabel: () => '',
}))

vi.mock('@renderer/features/settings/harness-install', () => ({
  openInstall: vi.fn(),
}))

vi.mock('@renderer/features/session/composer/host-chip', () => ({
  HostChip: () => null,
}))

vi.mock('@renderer/features/session/composer/model-menu', () => ({
  ModelMenu: () => null,
  ModelMenuLoading: () => null,
}))

vi.mock('@renderer/features/session/composer/send-button', () => ({
  SendButton: () => null,
}))

vi.mock('@renderer/features/session/composer/prompt-box', () => ({
  PromptBox: () => null,
}))

vi.mock('@renderer/features/session/composer/affect-styles', () => ({
  StartStyles: () => null,
  TrayStyles: () => null,
}))

vi.mock('@renderer/features/session/composer/drafts', () => ({
  NEW_SESSION_DRAFT: 'new',
  hasMessage: () => false,
  readDraft: () => '',
  readDraftArtifacts: () => [],
  readDraftAttachments: () => [],
}))

vi.mock('@renderer/features/session/composer/attachments', () => ({
  attachmentContent: () => [],
  attachmentsBlock: () => null,
}))

vi.mock('@renderer/features/session/composer/chips', () => ({
  mentionResolver: () => () => null,
  NO_SURFACES: [],
  pluginRefs: () => [],
  surfaceRefs: () => [],
}))

vi.mock('@renderer/features/session/composer/plugin-mentions', () => ({
  draftMentions: () => [],
}))

vi.mock('@renderer/features/session/composer/mention-surfaces', () => ({
  mentionSurfacesOf: () => [],
}))

vi.mock('@renderer/features/session/composer/use-prompt-box', () => ({
  usePromptBox: () => ({
    artifacts: [],
    artifactPickerOpen: false,
    setArtifactPickerOpen: () => undefined,
    openArtifactPicker: () => undefined,
    attachArtifact: () => undefined,
    removeArtifact: () => undefined,
    attachments: [],
    editor: { current: null },
    source: { text: '' },
    error: null,
    focus: () => undefined,
    addRequest: null,
    setError: () => undefined,
    take: () => ({ prompt: '' }),
    restore: () => () => undefined,
  }),
  useBoxText: () => false,
}))

vi.mock('@renderer/features/session/composer/use-blocked-enter', () => ({
  useBlockedEnter: () => ({ refused: null, enter: () => undefined }),
}))

vi.mock('@renderer/features/session/composer/use-slash-commands', () => ({
  useSlashCommands: () => [],
}))

vi.mock('@renderer/features/session/composer/add-menu', () => ({
  useAddMenu: () => ({ sections: [], onAttach: () => undefined, disabled: false }),
}))

vi.mock('@renderer/features/session/composer/mode-control', () => ({
  useModeControl: () => ({}),
}))

vi.mock('@renderer/features/session/new-session/agent-picker', () => ({
  AgentPicker: () => null,
}))

vi.mock('@renderer/features/session/new-session/host-menu', () => ({
  HostMenu: () => null,
}))

vi.mock('@renderer/features/session/new-session/project-menu', () => ({
  ProjectMenu: () => null,
}))

vi.mock('@renderer/features/session/new-session/recent-artifacts', () => ({
  RecentArtifacts: () => null,
}))

vi.mock('@renderer/features/session/new-session/agent-guide', () => ({
  AgentGuide: () => null,
}))

vi.mock('@renderer/features/session/new-session/workflow-menu', () => ({
  WorkflowMenu: () => null,
  TaskWorktreeNote: () => null,
  TaskWorktreeTag: () => null,
}))

vi.mock('@renderer/features/session/new-session/worktree-menu', () => ({
  WorktreeMenu: () => null,
  WorktreeNote: () => null,
}))

vi.mock('@renderer/features/session/worktree/worktree-tag', () => ({
  WorktreeTrayTag: () => null,
}))

vi.mock('@renderer/features/session/turn-dots', () => ({
  TurnDots: () => null,
}))

vi.mock('@renderer/features/session/new-session/guide-statuses', () => ({
  useGuideStatuses: () => null,
}))

vi.mock('@renderer/features/session/new-session/use-start-config', () => ({
  useStartConfig: () => undefined,
}))

vi.mock('@renderer/features/session/new-session/worktree-base', () => ({
  currentBase: () => null,
  useWorktreeStatus: () => null,
}))

vi.mock('@renderer/features/session/new-session/greeting', () => ({
  greetingMoment: () => 'first',
  greetingPeriod: () => 'morning',
  lastStartedAt: () => undefined,
  lineShown: () => undefined,
  pickLine: () => 0,
}))

vi.mock('@renderer/features/session/new-session/prepared', () => ({
  enterNewSession: () => undefined,
  leaveNewSession: () => undefined,
  noteActivity: () => undefined,
  prepareFor: () => undefined,
  readFirstOptions: () => Promise.resolve(),
  refreshOnMenu: () => undefined,
  setOption: () => undefined,
  settleOptions: () => Promise.resolve(),
}))

vi.mock('@renderer/app/actions', () => ({
  startNewSession: vi.fn(),
}))

vi.mock('@renderer/features/shell/glyph', () => ({
  Glyph: () => null,
}))

vi.mock('@renderer/features/shell/no-project-icon', () => ({
  NO_PROJECT_ICON: null,
}))

vi.mock('@renderer/features/sidebar/host-label', () => ({
  useHostLabel: () => '',
}))

vi.mock('@renderer/lib/cloud', () => ({
  useCloudOff: () => true,
}))

vi.mock('@renderer/lib/use-now', () => ({
  useClock: () => 'morning:first',
  useNow: () => 0,
}))

vi.mock('@renderer/lib/host', () => ({
  errorCode: () => null,
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  host: vi.fn(),
  hostAt: vi.fn(),
  terminalHost: () => null,
  terminals: (...args: unknown[]) => terminalsRpcMock(...args),
  terminalsAt: vi.fn(),
}))

vi.mock('@renderer/lib/platform', () => ({
  isMac: true,
  isMod: () => false,
  isWeb: false,
  platform: 'darwin',
  hasBand: false,
  formatShortcut: (shortcut: string) => shortcut,
}))

vi.mock('@renderer/features/shell/narrow', () => ({
  NARROW_WINDOW: '(max-width: 720px)',
  PHONE_WINDOW: '(max-width: 540px)',
  isPhoneWindow: () => false,
}))

const REMOTE_HOST_ID = '0123456789abcdef0123456789abcdef'

const PROJECT_A: Project = {
  path: '/tmp/project-a',
  name: 'project-a',
  lastOpenedAt: 1,
  missing: false,
}

const PROJECT_MISSING: Project = {
  path: '/tmp/project-gone',
  name: 'project-gone',
  lastOpenedAt: 2,
  missing: true,
}

const REMOTE_PROJECT: Project = {
  path: onHost(REMOTE_HOST_ID, '/srv/project-b'),
  name: 'project-b',
  lastOpenedAt: 3,
  missing: false,
}

function fakeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'parent-1',
    agentId: 'fake-agent',
    projectPath: '/tmp/parent-project',
    title: 'Parent session',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
    lastViewedAt: null,
    parentId: null,
    origin: 'user',
    archivedAt: null,
    pinned: false,
    unread: false,
    description: null,
    branch: null,
    ...overrides,
  } as unknown as SessionSummary
}

function fakeTerminal(overrides: Partial<TerminalInfo> = {}): TerminalInfo {
  return {
    id: 'term-1',
    projectPath: PROJECT_A.path,
    sessionId: null,
    shell: 'zsh',
    title: 'zsh',
    name: null,
    namedBy: null,
    busy: false,
    exitCode: null,
    createdAt: 100,
    owner: null,
    agentAllowed: false,
    control: { kind: 'idle' },
    waiting: null,
    ...overrides,
  }
}

beforeEach(() => {
  headerToolsCalls.length = 0
  closePaneCalls = 0
  mockSessionsById = {}
  terminalsRpcMock.mockReset()
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  })
  vi.stubGlobal('window', {
    kettu: { client: 'desktop' },
    matchMedia: () => ({ matches: false }),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('NewSessionView top bar HeaderTools', () => {
  it('renders HeaderTools with newSessionPanel(projectPath) when a project is selected', async () => {
    const { NewSessionView } = await import('@renderer/features/session/new-session')
    const { newSessionPanel } = await import('@renderer/stores/view')

    const html = renderToStaticMarkup(
      createElement(NewSessionView, {
        paneId: 'pane-1',
        project: PROJECT_A,
        noProject: false,
      }),
    )

    expect(headerToolsCalls).toEqual([
      { projectPath: PROJECT_A.path, panel: newSessionPanel(PROJECT_A.path) },
    ])
    expect(closePaneCalls).toBe(0)
    expect(html).toContain('data-testid="header-tools"')
    expect(html).toContain(`data-panel="${newSessionPanel(PROJECT_A.path)}"`)
  })

  it('omits HeaderTools and keeps ClosePaneButton when No project is selected', async () => {
    const { NewSessionView } = await import('@renderer/features/session/new-session')

    const html = renderToStaticMarkup(
      createElement(NewSessionView, {
        paneId: 'pane-1',
        project: PROJECT_A,
        noProject: true,
      }),
    )

    expect(headerToolsCalls).toEqual([])
    expect(closePaneCalls).toBe(1)
    expect(html).not.toContain('data-testid="header-tools"')
    expect(html).toContain('data-testid="close-pane-button"')
  })

  it('omits HeaderTools when no project exists or the selected project folder is missing', async () => {
    const { NewSessionView } = await import('@renderer/features/session/new-session')

    renderToStaticMarkup(
      createElement(NewSessionView, {
        paneId: 'pane-1',
        project: null,
        noProject: false,
      }),
    )
    expect(headerToolsCalls).toEqual([])
    expect(closePaneCalls).toBe(1)

    closePaneCalls = 0
    renderToStaticMarkup(
      createElement(NewSessionView, {
        paneId: 'pane-1',
        project: PROJECT_MISSING,
        noProject: false,
      }),
    )
    expect(headerToolsCalls).toEqual([])
    expect(closePaneCalls).toBe(1)
  })

  it('renders HeaderTools for the parent session folder in a sub-session', async () => {
    const { NewSessionView } = await import('@renderer/features/session/new-session')
    const { newSessionPanel } = await import('@renderer/stores/view')

    const parent = fakeSession({
      id: 'parent-scratch',
      projectPath: '/tmp/scratch-1',
      scratch: true,
    })
    mockSessionsById = { [parent.id]: parent }

    renderToStaticMarkup(
      createElement(NewSessionView, {
        paneId: 'pane-1',
        project: null,
        noProject: false,
        parentId: parent.id,
      }),
    )

    expect(headerToolsCalls).toEqual([
      { projectPath: parent.projectPath, panel: newSessionPanel(parent.projectPath) },
    ])
    expect(closePaneCalls).toBe(0)
  })
})

describe('New session side panel resolution and terminal migration', () => {
  it('resolves paneProjectPath and panelOf across explicit, restored, host-scoped, missing, and No project views', async () => {
    const { newSessionPanel, paneProjectPath, panelOf, shownPanel, useViewStore } =
      await import('@renderer/stores/view')
    const { createLayout, newSessionView } = await import('@renderer/features/split/layout')

    const projects = [PROJECT_A, PROJECT_MISSING, REMOTE_PROJECT]

    // Restored New session (view.projectPath === null) falls back to selected or first project.
    const restoredView = {
      kind: 'new' as const,
      agentId: null,
      projectPath: null,
      noProject: false,
    }
    expect(restoredView).toEqual(newSessionView())
    expect(paneProjectPath(restoredView, null, projects)).toBe(PROJECT_A.path)
    expect(panelOf(restoredView, null, projects)).toBe(newSessionPanel(PROJECT_A.path))

    // Host-scoped New session resolves to a project on that host.
    expect(
      paneProjectPath({ ...restoredView, hostId: REMOTE_HOST_ID }, PROJECT_A.path, projects),
    ).toBe(REMOTE_PROJECT.path)

    // Missing project yields null so the side panel is not opened for a nonexistent directory.
    expect(
      paneProjectPath({ ...restoredView, projectPath: PROJECT_MISSING.path }, null, projects),
    ).toBeNull()

    // No project returns null even when view.projectPath retains the previously chosen path.
    const noProjectView = {
      kind: 'new' as const,
      agentId: null,
      projectPath: PROJECT_A.path,
      noProject: true,
    }
    expect(paneProjectPath(noProjectView, PROJECT_A.path, projects)).toBeNull()
    expect(panelOf(noProjectView, PROJECT_A.path, projects)).toBeNull()
    expect(panelOf(noProjectView)).toBeNull()

    // shownPanel reflects the focused pane's resolved panel.
    useViewStore.setState({
      layout: createLayout(restoredView),
      projectPath: null,
    })
    expect(shownPanel(useViewStore.getState(), projects)).toBe(newSessionPanel(PROJECT_A.path))
  })

  it('opens a project terminal on New session and seamlessly migrates panel state and terminals when a session starts', async () => {
    const {
      newSessionAt,
      newSessionPanel,
      openNewSession,
      restoreLayout,
      showCreatedSession,
      toggleSidePane,
      toggleTerminal,
      useViewStore,
    } = await import('@renderer/stores/view')
    const { assignTerminals, createTerminal, terminalsOf, useTerminalsStore } =
      await import('@renderer/stores/terminals')
    const { createLayout, newSessionView } = await import('@renderer/features/split/layout')

    // Reset terminal store cleanly.
    useTerminalsStore.setState({
      byId: {},
      active: {},
      order: {},
      split: {},
      focusedSide: {},
      focusing: null,
      errors: {},
      controls: {},
    })

    // Start from a restored New session layout (where view.projectPath is null).
    restoreLayout(createLayout(newSessionView()))
    const panel = newSessionPanel(PROJECT_A.path)

    // Open Files and Terminal on New session without creating any agent session.
    toggleSidePane(panel, 'files', true)
    toggleTerminal(panel, true)
    const created = fakeTerminal({ id: 'term-pre-session', projectPath: PROJECT_A.path })
    terminalsRpcMock.mockResolvedValueOnce(created)
    const info = await createTerminal(PROJECT_A.path, panel)

    expect(info?.id).toBe('term-pre-session')
    expect(terminalsRpcMock).toHaveBeenCalledWith('terminals.create', {
      projectPath: PROJECT_A.path,
      cols: 100,
      rows: 24,
    })
    expect(useViewStore.getState().sidePane[panel]).toBe('terminal')
    expect(terminalsOf(useTerminalsStore.getState().byId, panel).map((t) => t.id)).toEqual([
      'term-pre-session',
    ])

    // Later the user starts a session: both side panel state and terminals migrate seamlessly.
    const paneId = newSessionAt()!
    expect(paneId).toBeTruthy()
    expect(showCreatedSession(paneId, 'sess-1', PROJECT_A.path)).toBe(true)

    terminalsRpcMock.mockResolvedValueOnce(undefined)
    await assignTerminals(PROJECT_A.path, 'sess-1')

    const viewState = useViewStore.getState()
    expect(viewState.sidePane['sess-1']).toBe('terminal')
    expect(viewState.sideTabs['sess-1']).toEqual(['files'])
    expect(viewState.sidePane[panel]).toBeUndefined()

    const termState = useTerminalsStore.getState()
    expect(terminalsOf(termState.byId, 'sess-1').map((t) => t.id)).toEqual(['term-pre-session'])
    expect(terminalsOf(termState.byId, panel)).toEqual([])
    expect(termState.active['sess-1']).toBe('term-pre-session')
    expect(terminalsRpcMock).toHaveBeenLastCalledWith('terminals.assign', {
      projectPath: PROJECT_A.path,
      sessionId: 'sess-1',
    })

    // Opening a fresh New session in the same project starts clean with no leftover panel state.
    openNewSession(PROJECT_A.path, null, false)
    expect(useViewStore.getState().sidePane[panel]).toBeUndefined()
  })
})
