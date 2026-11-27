import { Children, createElement, isValidElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '@shared/agent-host'
import { onHost } from '@renderer/lib/host-paths'

interface RecordedMenuItem {
  text: string
  disabled: boolean
  onClick?: () => void
}

const recordedItems: RecordedMenuItem[] = []
const newSessionMock = vi.fn()
const openProjectTerminalMock = vi.fn()
const openWorktreeSettingsMock = vi.fn()
const openHostSettingsItemMock = vi.fn()
const showItemMock = vi.fn()

let terminalAllowed = true
let gitRepoByPath: Record<string, { repo: { root: string } | null } | undefined> = {}
let hostStatuses: { id: string; version: string }[] = []
let webHostVersion: string | null = null
let mockIsWeb = false

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
  ComputerTerminal01Icon: 'ComputerTerminal01Icon',
  Download04Icon: 'Download04Icon',
  FolderEditIcon: 'FolderEditIcon',
  FolderMinusIcon: 'FolderMinusIcon',
  FolderOpenIcon: 'FolderOpenIcon',
  GitBranchIcon: 'GitBranchIcon',
  PencilEdit02Icon: 'PencilEdit02Icon',
  PinIcon: 'PinIcon',
  PinOffIcon: 'PinOffIcon',
}))

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}))

vi.mock('@renderer/app/actions', () => ({
  newSession: (...args: unknown[]) => newSessionMock(...args),
}))

vi.mock('@renderer/components/ui/dropdown-menu', () => ({
  DropdownMenuGroup: ({ children }: { children?: ReactNode }) =>
    createElement('div', { role: 'group' }, children),
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
  }: {
    children?: ReactNode
    disabled?: boolean
    onClick?: () => void
  }) => {
    recordedItems.push({ text: collectText(children), disabled: !!disabled, onClick })
    return createElement('button', { type: 'button', disabled }, children)
  },
  DropdownMenuSeparator: () => createElement('hr'),
  DropdownMenuShortcut: ({ children }: { children?: ReactNode }) =>
    createElement('kbd', null, children),
}))

vi.mock('@renderer/features/settings/host-sections', () => ({
  openHostSettingsItem: (...args: unknown[]) => openHostSettingsItemMock(...args),
}))

vi.mock('@renderer/features/shell/glyph', () => ({
  Glyph: () => null,
  MenuGlyph: () => null,
}))

vi.mock('@renderer/features/worktrees/worktree-settings-model', () => ({
  openWorktreeSettings: (...args: unknown[]) => openWorktreeSettingsMock(...args),
}))

vi.mock('@renderer/lib/platform', () => ({
  fileManagerName: () => 'Finder',
  formatShortcut: (shortcut: string) => shortcut,
  get isWeb() {
    return mockIsWeb
  },
}))

vi.mock('@renderer/stores/git', () => ({
  useGitStore: <T>(
    selector: (state: {
      status: Record<string, { repo: { root: string } | null } | undefined>
    }) => T,
  ) => selector({ status: gitRepoByPath }),
}))

vi.mock('@renderer/stores/hosts', () => ({
  useTerminalAllowed: () => terminalAllowed,
  useHostsStore: <T>(
    selector: (state: { status: { hosts: { id: string; version: string }[] } | null }) => T,
  ) => selector({ status: { hosts: hostStatuses } }),
}))

vi.mock('@renderer/stores/web-host', () => ({
  useWebHostStore: <T>(selector: (state: { host: { version: string } | null }) => T) =>
    selector({ host: webHostVersion ? { version: webHostVersion } : null }),
}))

vi.mock('./project-menu-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./project-menu-model')>()
  return {
    ...actual,
    openProjectTerminal: (...args: unknown[]) => openProjectTerminalMock(...args),
  }
})

const HOST_A = 'a'.repeat(32)

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    path: '/work/local-app',
    name: 'Local App',
    missing: false,
    lastOpenedAt: 100,
    pinnedAt: null,
    archivedAt: null,
    order: null,
    ...overrides,
  }
}

beforeEach(() => {
  recordedItems.length = 0
  newSessionMock.mockReset()
  openProjectTerminalMock.mockReset()
  openWorktreeSettingsMock.mockReset()
  openHostSettingsItemMock.mockReset()
  showItemMock.mockReset()
  terminalAllowed = true
  gitRepoByPath = {}
  hostStatuses = [{ id: HOST_A, version: '0.1.25' }]
  webHostVersion = null
  mockIsWeb = false
  vi.stubGlobal('window', { kettu: { shell: { showItem: showItemMock } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ProjectMenuItems', () => {
  it('renders all local actions including file manager reveal and routes Show archived to local host', async () => {
    const { ProjectMenuItems } = await import('./project-menu')
    const project = makeProject()
    const onImport = vi.fn()

    renderToStaticMarkup(
      createElement(ProjectMenuItems, {
        project,
        away: false,
        onEdit: vi.fn(),
        onPin: vi.fn(),
        onImport,
        onArchive: vi.fn(),
        onRemove: vi.fn(),
      }),
    )

    const labels = recordedItems.map((item) => item.text)
    expect(labels).toEqual([
      'project.menu.newSessionMod+N',
      'project.menu.edit',
      'project.menu.pin',
      'project.importSessions',
      'project.menu.openInTerminal',
      'project.menu.showIn:{"name":"Finder"}',
      'project.menu.worktreeSettings',
      'project.menu.showArchived',
      'project.menu.archive',
      'project.menu.remove',
    ])
    expect(recordedItems.every((item) => !item.disabled)).toBe(true)

    recordedItems.find((item) => item.text.startsWith('project.menu.showArchived'))!.onClick?.()
    expect(openHostSettingsItemMock).toHaveBeenCalledWith(null, 'archived', null)

    recordedItems.find((item) => item.text === 'project.importSessions')!.onClick?.()
    expect(onImport).toHaveBeenCalledTimes(1)
  })

  it('exposes newSession, importSessions, openInTerminal, worktreeSettings, and showArchived for an online remote project while keeping file manager local-only', async () => {
    const { ProjectMenuItems } = await import('./project-menu')
    const remotePath = onHost(HOST_A, '/srv/remote-app')
    const project = makeProject({ path: remotePath, name: 'Remote App' })
    const onImport = vi.fn()

    renderToStaticMarkup(
      createElement(ProjectMenuItems, {
        project,
        away: false,
        onEdit: vi.fn(),
        onPin: vi.fn(),
        onImport,
        onArchive: vi.fn(),
        onRemove: vi.fn(),
      }),
    )

    const labels = recordedItems.map((item) => item.text)
    expect(labels).toEqual([
      'project.menu.newSessionMod+N',
      'project.menu.edit',
      'project.menu.pin',
      'project.importSessions',
      'project.menu.openInTerminal',
      'project.menu.worktreeSettings',
      'project.menu.showArchived',
      'project.menu.archive',
      'project.menu.remove',
    ])
    expect(labels.some((label) => label.startsWith('project.menu.showIn'))).toBe(false)
    expect(recordedItems.every((item) => !item.disabled)).toBe(true)

    recordedItems.find((item) => item.text.startsWith('project.menu.newSession'))!.onClick?.()
    expect(newSessionMock).toHaveBeenCalledWith(remotePath)

    recordedItems.find((item) => item.text === 'project.importSessions')!.onClick?.()
    expect(onImport).toHaveBeenCalledTimes(1)

    recordedItems.find((item) => item.text === 'project.menu.openInTerminal')!.onClick?.()
    expect(openProjectTerminalMock).toHaveBeenCalledWith(remotePath)

    recordedItems.find((item) => item.text === 'project.menu.worktreeSettings')!.onClick?.()
    expect(openWorktreeSettingsMock).toHaveBeenCalledWith(project)

    recordedItems.find((item) => item.text === 'project.menu.showArchived')!.onClick?.()
    expect(openHostSettingsItemMock).toHaveBeenCalledWith(HOST_A, 'archived', null)
  })

  it('disables all remote actions while the remote host is away', async () => {
    const { ProjectMenuItems } = await import('./project-menu')
    const project = makeProject({ path: onHost(HOST_A, '/srv/remote-app'), name: 'Remote App' })

    renderToStaticMarkup(
      createElement(ProjectMenuItems, {
        project,
        away: true,
        onEdit: vi.fn(),
        onPin: vi.fn(),
        onImport: vi.fn(),
        onArchive: vi.fn(),
        onRemove: vi.fn(),
      }),
    )

    expect(recordedItems.length).toBeGreaterThan(0)
    expect(recordedItems.every((item) => item.disabled)).toBe(true)
  })

  it('disables folder-dependent actions when a remote project folder is missing while keeping metadata and archive actions enabled', async () => {
    const { ProjectMenuItems } = await import('./project-menu')
    const project = makeProject({
      path: onHost(HOST_A, '/srv/missing-app'),
      name: 'Missing App',
      missing: true,
    })

    renderToStaticMarkup(
      createElement(ProjectMenuItems, {
        project,
        away: false,
        onEdit: vi.fn(),
        onPin: vi.fn(),
        onImport: vi.fn(),
        onArchive: vi.fn(),
        onRemove: vi.fn(),
      }),
    )

    const disabledByLabel = Object.fromEntries(
      recordedItems.map((item) => [item.text, item.disabled]),
    )
    expect(disabledByLabel).toEqual({
      'project.menu.newSessionMod+N': true,
      'project.menu.edit': false,
      'project.menu.pin': false,
      'project.importSessions': true,
      'project.menu.openInTerminal': true,
      'project.menu.worktreeSettings': true,
      'project.menu.showArchived': false,
      'project.menu.archive': false,
      'project.menu.remove': false,
    })
  })

  it('hides worktreeSettings for a non-Git remote project', async () => {
    const { ProjectMenuItems } = await import('./project-menu')
    const remotePath = onHost(HOST_A, '/srv/non-git')
    gitRepoByPath = { [remotePath]: { repo: null } }
    const project = makeProject({ path: remotePath, name: 'Non Git' })

    renderToStaticMarkup(
      createElement(ProjectMenuItems, {
        project,
        away: false,
        onEdit: vi.fn(),
        onPin: vi.fn(),
        onImport: vi.fn(),
        onArchive: vi.fn(),
        onRemove: vi.fn(),
      }),
    )

    expect(recordedItems.map((item) => item.text)).not.toContain('project.menu.worktreeSettings')
  })

  it('hides openInTerminal when remote terminal access is disallowed while keeping read-only worktreeSettings accessible', async () => {
    const { ProjectMenuItems } = await import('./project-menu')
    terminalAllowed = false
    const project = makeProject({ path: onHost(HOST_A, '/srv/no-term'), name: 'No Terminal' })

    renderToStaticMarkup(
      createElement(ProjectMenuItems, {
        project,
        away: false,
        onEdit: vi.fn(),
        onPin: vi.fn(),
        onImport: vi.fn(),
        onArchive: vi.fn(),
        onRemove: vi.fn(),
      }),
    )

    const labels = recordedItems.map((item) => item.text)
    expect(labels).not.toContain('project.menu.openInTerminal')
    expect(labels).toContain('project.importSessions')
    expect(labels).toContain('project.menu.worktreeSettings')
  })

  it('hides worktreeSettings, pin, and archive for an older remote host that lacks them', async () => {
    const { ProjectMenuItems } = await import('./project-menu')
    hostStatuses = [{ id: HOST_A, version: '0.0.37' }]
    const legacyProject: Project = {
      path: onHost(HOST_A, '/srv/legacy'),
      name: 'Legacy',
      missing: false,
      lastOpenedAt: 100,
    }

    renderToStaticMarkup(
      createElement(ProjectMenuItems, {
        project: legacyProject,
        away: false,
        onEdit: vi.fn(),
        onPin: vi.fn(),
        onImport: vi.fn(),
        onArchive: vi.fn(),
        onRemove: vi.fn(),
      }),
    )

    expect(recordedItems.map((item) => item.text)).toEqual([
      'project.menu.newSessionMod+N',
      'project.menu.edit',
      'project.importSessions',
      'project.menu.openInTerminal',
      'project.menu.showArchived',
      'project.menu.remove',
    ])
  })

  it('hides worktreeSettings on web client when the serving host predates worktree settings', async () => {
    const { ProjectMenuItems } = await import('./project-menu')
    mockIsWeb = true
    webHostVersion = '0.0.37'
    const project = makeProject({ path: '/srv/web-legacy', name: 'Web Legacy' })

    renderToStaticMarkup(
      createElement(ProjectMenuItems, {
        project,
        away: false,
        onEdit: vi.fn(),
        onPin: vi.fn(),
        onImport: vi.fn(),
        onArchive: vi.fn(),
        onRemove: vi.fn(),
      }),
    )

    expect(recordedItems.map((item) => item.text)).not.toContain('project.menu.worktreeSettings')
    expect(recordedItems.map((item) => item.text)).not.toContain(
      'project.menu.showIn:{"name":"Finder"}',
    )
  })
})

describe('NoProjectMenuItems', () => {
  it('opens the remote host archived page from a remote No project row', async () => {
    const { NoProjectMenuItems } = await import('./project-menu')

    renderToStaticMarkup(
      createElement(NoProjectMenuItems, {
        hostId: HOST_A,
        pinned: false,
        away: false,
        onPin: vi.fn(),
      }),
    )

    expect(recordedItems.map((item) => item.text)).toEqual([
      'project.menu.pinNoProject',
      'project.menu.showArchived',
    ])
    expect(recordedItems.every((item) => !item.disabled)).toBe(true)

    recordedItems.find((item) => item.text === 'project.menu.showArchived')!.onClick?.()
    expect(openHostSettingsItemMock).toHaveBeenCalledWith(HOST_A, 'archived', null)
  })

  it('keeps showArchived available for older remote hosts without No project pinning and disables when away', async () => {
    const { NoProjectMenuItems } = await import('./project-menu')

    renderToStaticMarkup(
      createElement(NoProjectMenuItems, {
        hostId: HOST_A,
        pinned: undefined,
        away: true,
        onPin: vi.fn(),
      }),
    )

    expect(recordedItems).toHaveLength(1)
    expect(recordedItems[0]!.text).toBe('project.menu.showArchived')
    expect(recordedItems[0]!.disabled).toBe(true)
  })
})
