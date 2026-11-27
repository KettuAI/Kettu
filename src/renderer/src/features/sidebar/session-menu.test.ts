import { Children, createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'

interface RecordedMenuItem {
  text: string
  onClick?: () => void
}

const recordedItems: RecordedMenuItem[] = []
const toastMock = vi.fn()
const writeTextMock = vi.fn<(text: string) => Promise<void>>()

function collectText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) => {
      if (typeof child === 'string' || typeof child === 'number') return String(child)
      if (isValidElement<{ children?: ReactNode }>(child)) return collectText(child.props.children)
      return ''
    })
    .join('')
}

vi.mock('@hugeicons/core-free-icons', () => ({
  Archive01Icon: 'Archive01Icon',
  ArrowMoveDownRightIcon: 'ArrowMoveDownRightIcon',
  Cancel01Icon: 'Cancel01Icon',
  CancelCircleIcon: 'CancelCircleIcon',
  ComputerTerminal01Icon: 'ComputerTerminal01Icon',
  Copy01Icon: 'Copy01Icon',
  Delete02Icon: 'Delete02Icon',
  Download04Icon: 'Download04Icon',
  FolderOpenIcon: 'FolderOpenIcon',
  FolderRemoveIcon: 'FolderRemoveIcon',
  GitBranchIcon: 'GitBranchIcon',
  Layout2ColumnIcon: 'Layout2ColumnIcon',
  LinkSquare02Icon: 'LinkSquare02Icon',
  PencilEdit02Icon: 'PencilEdit02Icon',
  PinIcon: 'PinIcon',
  PinOffIcon: 'PinOffIcon',
  RefreshIcon: 'RefreshIcon',
  SidebarBottomIcon: 'SidebarBottomIcon',
  SidebarRightIcon: 'SidebarRightIcon',
  SlidersHorizontalIcon: 'SlidersHorizontalIcon',
  StopCircleIcon: 'StopCircleIcon',
  ViewIcon: 'ViewIcon',
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  Trans: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@renderer/components/ui/dropdown-menu', () => ({
  DropdownMenuGroup: ({ children }: { children?: ReactNode }) =>
    createElement('div', { role: 'group' }, children),
  DropdownMenuItem: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => {
    recordedItems.push({ text: collectText(children), onClick })
    return createElement('button', { type: 'button' }, children)
  },
  DropdownMenuLabel: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  DropdownMenuSeparator: () => createElement('hr'),
  DropdownMenuShortcut: ({ children }: { children?: ReactNode }) =>
    createElement('kbd', null, children),
  DropdownMenuSub: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DropdownMenuSubContent: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  DropdownMenuSubTrigger: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
}))

vi.mock('@renderer/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  AlertDialogAction: ({ children }: { children?: ReactNode }) =>
    createElement('button', null, children),
  AlertDialogCancel: ({ children }: { children?: ReactNode }) =>
    createElement('button', null, children),
  AlertDialogContent: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  AlertDialogDescription: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  AlertDialogFooter: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  AlertDialogHeader: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  AlertDialogTitle: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
}))

vi.mock('@renderer/components/ui/toast', () => ({
  toast: (...args: unknown[]) => toastMock(...args),
}))

vi.mock('@renderer/components/agents/agent-mark', () => ({
  AgentMark: () => null,
}))

vi.mock('@renderer/components/fork-icon', () => ({
  ForkIcon: () => null,
}))

vi.mock('@renderer/features/files/open-in-editor-menu', () => ({
  OpenInEditorMenu: () => null,
}))

vi.mock('@renderer/features/files/operations', () => ({
  isLocalProject: () => true,
}))

vi.mock('@renderer/features/git/pr-icon', () => ({
  PrIcon: () => null,
}))

vi.mock('@renderer/features/session/conversation-markdown', () => ({
  modelName: () => null,
}))

vi.mock('@renderer/features/session/export-conversation', () => ({
  exportConversation: vi.fn(),
}))

vi.mock('@renderer/features/session/open-link', () => ({
  sessionLinkProps: () => ({}),
}))

vi.mock('@renderer/features/shell/glyph', () => ({
  Glyph: () => null,
  MenuGlyph: () => null,
}))

vi.mock('@renderer/features/split/layout', () => ({
  allPanes: () => [],
  canSplit: () => ({ ok: true }),
  focusedPane: () => ({ id: 'pane-1' }),
  paneWithSession: () => null,
}))

vi.mock('@renderer/features/split/pane-context', () => ({
  usePane: () => null,
}))

vi.mock('@renderer/features/split/session-drag-model', () => ({
  splitSize: () => null,
}))

vi.mock('@renderer/features/terminal/close-all-terminals-model', () => ({
  refreshSessionTerminals: vi.fn(),
  requestCloseAllTerminals: vi.fn(),
}))

vi.mock('@renderer/features/worktrees/remove-worktree-model', () => ({
  askRemoveWorktree: vi.fn(),
  canRemoveWorktree: () => false,
  hasLiveWorktree: () => false,
  offerWorktreeRemoval: vi.fn(),
}))

vi.mock('@renderer/app/actions', () => ({
  archiveSession: vi.fn(),
  deleteSession: vi.fn(),
  descendantCount: () => 0,
  forkSession: vi.fn(),
  leaveSession: vi.fn(),
  markSessionUnread: vi.fn(),
  pinSession: vi.fn(),
  renameSession: vi.fn(),
  unarchiveSession: vi.fn(),
}))

vi.mock('@renderer/lib/host', () => ({
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  host: vi.fn(),
}))

vi.mock('@renderer/lib/i18n', () => ({
  i18n: { t: (key: string) => key },
}))

vi.mock('@renderer/lib/platform', () => ({
  fileManagerName: () => 'Finder',
  formatShortcut: (shortcut: string) => shortcut,
  isMac: true,
  isWeb: false,
}))

vi.mock('@renderer/stores/agents', () => ({
  agentsOn: () => ({ order: [], byId: {} }),
  isInstalled: () => false,
  usableAgents: () => [],
  useAgentsStore: <T>(selector: (state: Record<string, never>) => T) => selector({}),
}))

vi.mock('@renderer/stores/git', () => ({
  pullRequestOf: () => null,
  useGitStore: <T>(selector: (state: { status: Record<string, never> }) => T) =>
    selector({ status: {} }),
}))

vi.mock('@renderer/stores/hosts', () => ({
  useTerminalAllowed: () => true,
}))

vi.mock('@renderer/stores/session-selection', () => ({
  clearSelection: vi.fn(),
}))

vi.mock('@renderer/stores/sessions', () => ({
  hostOfSession: () => null,
  listedSubSessions: () => [],
  sessionTitle: (summary: SessionSummary) => summary.title ?? summary.id,
  useSessionsStore: Object.assign(
    <T>(selector: (state: { byId: Record<string, SessionSummary> }) => T) => selector({ byId: {} }),
    { getState: () => ({ byId: {} }) },
  ),
}))

vi.mock('@renderer/stores/terminals', () => ({
  terminalsOf: () => [],
  useTerminalsStore: <T>(selector: (state: { byId: Record<string, never> }) => T) =>
    selector({ byId: {} }),
}))

vi.mock('@renderer/stores/view', () => ({
  openInSplit: vi.fn(),
  openNewSubSession: vi.fn(),
  openSession: vi.fn(),
  toggleTerminal: vi.fn(),
  useViewStore: <T>(
    selector: (state: {
      layout: {
        kind: 'pane'
        id: string
        view: { kind: 'new'; agentId: null; projectPath: null; noProject: false }
      }
      settings: { open: boolean }
      showFinishedSubagents: boolean
      visiblePanes: string[]
    }) => T,
  ) =>
    selector({
      layout: {
        kind: 'pane',
        id: 'pane-1',
        view: { kind: 'new', agentId: null, projectPath: null, noProject: false },
      },
      settings: { open: false },
      showFinishedSubagents: false,
      visiblePanes: ['pane-1'],
    }),
}))

vi.mock('./archive-confirm-model', () => ({
  confirmArchive: vi.fn(),
}))

vi.mock('./running-work', () => ({
  workAtStake: vi.fn(),
}))

vi.mock('./running-work-list', () => ({
  RunningWorkList: () => null,
}))

vi.mock('./row-dust', () => ({
  dissolveRows: vi.fn(),
}))

vi.mock('./row-exit', () => ({
  markReturning: vi.fn(),
}))

vi.mock('./subagents-menu', () => ({
  SubagentsMenu: () => null,
}))

function fakeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'session-local-1',
    acpSessionId: 'acp-session-1',
    agentId: 'claude-code',
    projectPath: '/tmp/project',
    title: 'History session',
    status: 'ready',
    createdAt: 1,
    updatedAt: 1,
    parentId: null,
    origin: 'user',
    archivedAt: null,
    pinnedAt: null,
    attention: null,
    pr: null,
    ...overrides,
  } as unknown as SessionSummary
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  recordedItems.length = 0
  toastMock.mockReset()
  writeTextMock.mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText: writeTextMock } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SessionMenuItems copySessionId action', () => {
  it.each(['row', 'more'] as const)(
    'renders Copy session ID and copies acpSessionId with toast in %s menu',
    async (place) => {
      const { SessionMenuItems } = await import('./session-menu')
      const summary = fakeSession({ id: 'kettu-id-1', acpSessionId: 'harness-id-1' })

      renderToStaticMarkup(
        createElement(SessionMenuItems, {
          summary,
          place,
          onRename: () => undefined,
          onNewSubSession: () => undefined,
          onDelete: () => undefined,
        }),
      )

      const copyItem = recordedItems.find((item) => item.text === 'row.copySessionId')
      expect(copyItem).toBeDefined()

      copyItem!.onClick?.()
      await flushPromises()

      expect(writeTextMock).toHaveBeenCalledTimes(1)
      expect(writeTextMock).toHaveBeenCalledWith('harness-id-1')
      expect(toastMock).toHaveBeenCalledWith('row.copiedSessionId')
    },
  )

  it('falls back to summary.id when acpSessionId is null in the sidebar row menu', async () => {
    const { SessionMenuItems } = await import('./session-menu')
    const summary = fakeSession({ id: 'kettu-id-fallback', acpSessionId: null })

    renderToStaticMarkup(
      createElement(SessionMenuItems, {
        summary,
        place: 'row',
        onRename: () => undefined,
        onNewSubSession: () => undefined,
        onDelete: () => undefined,
      }),
    )

    const copyItem = recordedItems.find((item) => item.text === 'row.copySessionId')
    expect(copyItem).toBeDefined()

    copyItem!.onClick?.()
    await flushPromises()

    expect(writeTextMock).toHaveBeenCalledWith('kettu-id-fallback')
    expect(toastMock).toHaveBeenCalledWith('row.copiedSessionId')
  })

  it('shows an error toast if clipboard write fails', async () => {
    const { SessionMenuItems } = await import('./session-menu')
    writeTextMock.mockRejectedValueOnce(new Error('Clipboard blocked'))

    renderToStaticMarkup(
      createElement(SessionMenuItems, {
        summary: fakeSession({ id: 'kettu-id-err', acpSessionId: null }),
        place: 'row',
        onRename: () => undefined,
        onNewSubSession: () => undefined,
        onDelete: () => undefined,
      }),
    )

    const copyItem = recordedItems.find((item) => item.text === 'row.copySessionId')
    copyItem!.onClick?.()
    await flushPromises()

    expect(toastMock).toHaveBeenCalledWith('Clipboard blocked')
  })
})
