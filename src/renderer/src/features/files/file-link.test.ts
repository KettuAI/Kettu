import {
  createElement,
  isValidElement,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import enFiles from '@shared/locales/en/files.json'
import enMain from '@shared/locales/en/main.json'
import zhFiles from '@shared/locales/zh-CN/files.json'
import zhMain from '@shared/locales/zh-CN/main.json'
import { planLinkOpen, type LinkPrefs } from '@renderer/features/session/link-open'
import { codexCitations } from '@renderer/features/session/markdown/codex-citations'
import { localLinks, localTarget } from '@renderer/features/session/markdown/local-links'
import { fileLinkActions, fileLinkClickTarget } from './file-link-actions'
import { hostFilePath } from './file-location'
import { parseFileRef } from './file-refs'

const LOCAL_PROJECT = '/Users/dev/app'
const WIN_PROJECT = 'C:\\Work\\App'
const REMOTE_PROJECT = 'kettu-host:0123456789abcdef0123456789abcdef:/home/dev/app'

interface MockTreeNode {
  type: unknown
  props: Record<string, unknown>
}

function collectElements(
  node: ReactNode,
  out: ReactElement<Record<string, unknown>>[] = [],
): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) {
    for (const child of node) collectElements(child, out)
    return out
  }
  if (!isValidElement<Record<string, unknown>>(node)) return out
  out.push(node)
  if (node.props.render && isValidElement(node.props.render)) {
    collectElements(node.props.render, out)
  }
  if (node.props.children !== undefined) {
    collectElements(node.props.children as ReactNode, out)
  }
  return out
}

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

function expandComponents(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expandComponents)
  if (!isValidElement<Record<string, unknown>>(node)) return node
  if (typeof node.type === 'function') {
    const rendered = (node.type as (props: Record<string, unknown>) => ReactNode)(node.props)
    return expandComponents(rendered)
  }
  const nextProps: Record<string, unknown> = { ...node.props }
  if (nextProps.render && isValidElement(nextProps.render)) {
    nextProps.render = expandComponents(nextProps.render)
  }
  if (nextProps.children !== undefined) {
    nextProps.children = expandComponents(nextProps.children as ReactNode)
  }
  return { ...node, props: nextProps } as MockTreeNode as unknown as ReactElement
}

describe('fileLinkActions and fileLinkClickTarget', () => {
  it('enables default-app Mod-click and local actions for local desktop files', () => {
    const actions = fileLinkActions({
      projectPath: LOCAL_PROJECT,
      hostFile: '/Users/dev/app/reports/sample.xlsx',
      web: false,
    })
    expect(actions).toEqual({ localFile: '/Users/dev/app/reports/sample.xlsx' })
    expect(fileLinkClickTarget({ localFile: actions.localFile, mod: false })).toBe('files-pane')
    expect(fileLinkClickTarget({ localFile: actions.localFile, mod: true })).toBe('default-app')
  })

  it('supports Windows local project paths', () => {
    const actions = fileLinkActions({
      projectPath: WIN_PROJECT,
      hostFile: 'C:\\Work\\App\\db\\schema.sql',
      web: false,
    })
    expect(actions).toEqual({ localFile: 'C:\\Work\\App\\db\\schema.sql' })
    expect(fileLinkClickTarget({ localFile: actions.localFile, mod: true })).toBe('default-app')
  })

  it('disables local actions and falls back to the Files pane for remote hosts, web clients, and non-absolute paths', () => {
    const remote = fileLinkActions({
      projectPath: REMOTE_PROJECT,
      hostFile: '/home/dev/app/README.md',
      web: false,
    })
    expect(remote.localFile).toBeNull()
    expect(fileLinkClickTarget({ localFile: remote.localFile, mod: true })).toBe('files-pane')

    const web = fileLinkActions({
      projectPath: LOCAL_PROJECT,
      hostFile: '/Users/dev/app/README.md',
      web: true,
    })
    expect(web.localFile).toBeNull()
    expect(fileLinkClickTarget({ localFile: web.localFile, mod: true })).toBe('files-pane')

    const relative = fileLinkActions({
      projectPath: LOCAL_PROJECT,
      hostFile: 'README.md',
      web: false,
    })
    expect(relative.localFile).toBeNull()
    expect(fileLinkClickTarget({ localFile: relative.localFile, mod: true })).toBe('files-pane')
  })

  it('strips line numbers and preserves spaces and CJK names when building host paths', () => {
    const refs = [
      parseFileRef('README.md', LOCAL_PROJECT, true),
      parseFileRef('reports/2026%20财报.xlsx', LOCAL_PROJECT, true),
      parseFileRef('db/schema.sql:42', LOCAL_PROJECT, true),
      parseFileRef('docs/中文 文档.md#L10-L20', LOCAL_PROJECT, true),
      parseFileRef('file:///Users/dev/app/docs/hello%20world.md#L5', LOCAL_PROJECT, true),
    ]
    expect(refs.map((ref) => ref && hostFilePath(LOCAL_PROJECT, ref.path))).toEqual([
      '/Users/dev/app/README.md',
      '/Users/dev/app/reports/2026 财报.xlsx',
      '/Users/dev/app/db/schema.sql',
      '/Users/dev/app/docs/中文 文档.md',
      '/Users/dev/app/docs/hello world.md',
    ])
  })

  it('resolves Codex file citations through localLinks without keeping line numbers in the opened path', () => {
    interface MdNode {
      type: string
      value?: string
      url?: string
      children?: MdNode[]
    }
    const root: MdNode = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            {
              type: 'text',
              value:
                'See :codex-file-citation{path="db/schema.sql" line_range_start=12 line_range_end=20} and :codex-file-citation{path="reports/2026 财报.xlsx" line_range_start=3}.',
            },
          ],
        },
      ],
    }
    codexCitations()(root)
    localLinks()(root)
    const links = (root.children?.[0]?.children ?? []).filter(
      (node): node is MdNode & { url: string } =>
        node.type === 'link' && typeof node.url === 'string',
    )
    const resolved = links.map((node) => {
      const target = localTarget(node.url)
      const parsed = target ? parseFileRef(target, LOCAL_PROJECT, true) : null
      return parsed ? { host: hostFilePath(LOCAL_PROJECT, parsed.path), line: parsed.line } : null
    })
    expect(resolved).toEqual([
      { host: '/Users/dev/app/db/schema.sql', line: 12 },
      { host: '/Users/dev/app/reports/2026 财报.xlsx', line: 3 },
    ])
  })
})

describe('FileLink interactions, context menu, error toast, and platform modifiers', () => {
  const openFileMock = vi.fn()
  const toastMock = vi.fn()
  const showItemMock = vi.fn(async () => {})
  const shellOpenFileMock = vi.fn(async () => {})

  async function loadFileLinkModule(options: {
    platform: 'darwin' | 'win32' | 'linux'
    web?: boolean
  }) {
    vi.resetModules()
    openFileMock.mockReset()
    toastMock.mockReset()
    showItemMock.mockReset().mockResolvedValue(undefined)
    shellOpenFileMock.mockReset().mockResolvedValue(undefined)

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: {
        kettu: {
          platform: options.platform,
          client: options.web ? 'web' : 'desktop',
          hostPlatform: () => options.platform,
          shell: {
            showDataFolder: vi.fn(async () => {}),
            showItem: showItemMock,
            openFile: shellOpenFileMock,
          },
        },
      },
    })

    vi.doMock('@hugeicons/core-free-icons', () => ({
      BrowserIcon: 'BrowserIcon',
      File01Icon: 'File01Icon',
      FolderOpenIcon: 'FolderOpenIcon',
      Link01Icon: 'Link01Icon',
      LinkSquare02Icon: 'LinkSquare02Icon',
    }))
    vi.doMock('@hugeicons/react', () => ({ HugeiconsIcon: () => null }))
    vi.doMock('react-i18next', () => ({
      useTranslation: () => ({
        t: (key: string, params?: Record<string, string>) => {
          if (key === 'preview.openWithDefault') return enFiles.preview.openWithDefault
          if (key === 'preview.showIn') return `Show in ${params?.name ?? 'Finder'}`
          if (key === 'tree.copyPath') return enFiles.tree.copyPath
          if (key === 'link.open') return `Open ${params?.target ?? ''}`
          return key
        },
      }),
    }))
    vi.doMock('@renderer/components/ui/context-menu', () => ({
      ContextMenu: ({ children }: { children?: ReactNode }) =>
        createElement('div', { 'data-mock': 'menu' }, children),
      ContextMenuTrigger: ({
        render,
        children,
      }: {
        render?: ReactElement
        children?: ReactNode
      }) =>
        render
          ? createElement(render.type, render.props, children)
          : createElement('span', null, children),
      ContextMenuContent: ({ children }: { children?: ReactNode }) =>
        createElement('div', { 'data-mock': 'menu-content' }, children),
      ContextMenuItem: ({ onClick, children }: { onClick?: () => void; children?: ReactNode }) =>
        createElement('button', { type: 'button', 'data-mock': 'menu-item', onClick }, children),
      ContextMenuSeparator: () => createElement('hr'),
    }))
    vi.doMock('@renderer/components/ui/tooltip', () => ({
      Tooltip: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
      TooltipTrigger: ({ children }: { children?: ReactNode }) =>
        createElement('span', null, children),
      TooltipContent: ({ children }: { children?: ReactNode }) =>
        createElement('span', null, children),
    }))
    vi.doMock('@renderer/components/ui/toast', () => ({ toast: toastMock }))
    vi.doMock('@renderer/features/session/media/grants', () => ({
      SessionIdContext: { _currentValue: null },
    }))
    vi.doMock('react', async (importOriginal) => {
      const actual = await importOriginal<typeof import('react')>()
      return {
        ...actual,
        useContext: () => null,
        useEffect: () => {},
      }
    })
    vi.doMock('@renderer/features/session/markdown/web-link', () => ({ BrowserIcon: () => null }))
    vi.doMock('@renderer/stores/files', () => ({
      openFile: openFileMock,
      closeRemoved: vi.fn(),
      followMoves: vi.fn(),
      loadFiles: vi.fn(),
      useFilesStore: { getState: () => ({ clipboard: null }), setState: vi.fn() },
    }))
    vi.doMock('@renderer/stores/site-icons', () => ({
      loadSiteIcons: vi.fn(),
      useDefaultBrowser: () => ({ name: 'Safari', icon: null }),
    }))
    vi.doMock('./file-type-icon', () => ({ FileTypeIcon: () => null }))
    vi.doMock('./html-preview', () => ({
      isHtmlFile: () => false,
      openHtmlInBrowser: vi.fn(),
      previewHtml: vi.fn(),
      useHtmlPreview: () => false,
    }))
    vi.doMock('@renderer/lib/i18n', () => ({
      i18n: {
        t: (key: string) => {
          if (key === 'fileManager.mac') return 'Finder'
          if (key === 'fileManager.windows') return 'Explorer'
          if (key === 'fileManager.linux') return 'Files'
          return key
        },
      },
    }))

    return import('./file-link')
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens in the Files pane on plain click and opens with the default app (without line suffix) on Cmd+click on macOS', async () => {
    const { FileLink } = await loadFileLinkModule({ platform: 'darwin' })
    const tree = expandComponents(
      createElement(FileLink, {
        file: { projectPath: LOCAL_PROJECT, path: 'db/schema.sql', line: 42 },
      }),
    )
    const elements = collectElements(tree)
    const trigger = elements.find((el) => el.props['data-file-ref'] === '')!
    const onClick = trigger.props.onClick as (event: Partial<MouseEvent<HTMLButtonElement>>) => void

    // Plain left click keeps existing Files pane behavior with line number.
    onClick({ metaKey: false, ctrlKey: false, preventDefault: vi.fn() })
    expect(openFileMock).toHaveBeenCalledWith(LOCAL_PROJECT, 'db/schema.sql', 42, { preview: true })
    expect(shellOpenFileMock).not.toHaveBeenCalled()

    // Ctrl+click on macOS does not invoke default app.
    openFileMock.mockClear()
    onClick({ metaKey: false, ctrlKey: true, preventDefault: vi.fn() })
    expect(openFileMock).toHaveBeenCalledTimes(1)
    expect(shellOpenFileMock).not.toHaveBeenCalled()

    // Cmd+click on macOS invokes shell.openFile with the resolved path (no :42) and does not open the Files pane.
    openFileMock.mockClear()
    const preventDefault = vi.fn()
    onClick({ metaKey: true, ctrlKey: false, preventDefault })
    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(shellOpenFileMock).toHaveBeenCalledWith('/Users/dev/app/db/schema.sql')
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('opens with the default app on Ctrl+click (and not Meta+click) on Windows and Linux', async () => {
    const { FileLink } = await loadFileLinkModule({ platform: 'win32' })
    const tree = expandComponents(
      createElement(FileLink, {
        file: { projectPath: WIN_PROJECT, path: 'reports/sample.xlsx', line: null },
      }),
    )
    const trigger = collectElements(tree).find((el) => el.props['data-file-ref'] === '')!
    const onClick = trigger.props.onClick as (event: Partial<MouseEvent<HTMLButtonElement>>) => void

    onClick({ metaKey: true, ctrlKey: false, preventDefault: vi.fn() })
    expect(openFileMock).toHaveBeenCalledTimes(1)
    expect(shellOpenFileMock).not.toHaveBeenCalled()

    openFileMock.mockClear()
    onClick({ metaKey: false, ctrlKey: true, preventDefault: vi.fn() })
    expect(shellOpenFileMock).toHaveBeenCalledWith('C:\\Work\\App\\reports\\sample.xlsx')
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('shows "Open with default app" in the context menu for local desktop files and invokes the same open path', async () => {
    const { FileLink } = await loadFileLinkModule({ platform: 'darwin' })
    const tree = expandComponents(
      createElement(FileLink, {
        file: { projectPath: LOCAL_PROJECT, path: 'docs/中文 笔记.md', line: 7 },
      }),
    )
    const menuItems = collectElements(tree).filter((el) => el.props['data-mock'] === 'menu-item')
    expect(menuItems.map((item) => textOf(item.props.children as ReactNode))).toEqual([
      'Open with default app',
      'Show in Finder',
      'Copy path',
    ])

    ;(menuItems[0]!.props.onClick as () => void)()
    expect(shellOpenFileMock).toHaveBeenCalledWith('/Users/dev/app/docs/中文 笔记.md')
  })

  it('hides local open actions in remote host sessions and falls back to Files pane on Mod+click', async () => {
    const { FileLink } = await loadFileLinkModule({ platform: 'darwin' })
    const tree = expandComponents(
      createElement(FileLink, {
        file: { projectPath: REMOTE_PROJECT, path: 'README.md', line: 3 },
      }),
    )
    const elements = collectElements(tree)
    const menuItems = elements.filter((el) => el.props['data-mock'] === 'menu-item')
    expect(menuItems.map((item) => textOf(item.props.children as ReactNode))).toEqual(['Copy path'])

    const trigger = elements.find((el) => el.props['data-file-ref'] === '')!
    ;(trigger.props.onClick as (event: Partial<MouseEvent<HTMLButtonElement>>) => void)({
      metaKey: true,
      ctrlKey: false,
      preventDefault: vi.fn(),
    })
    expect(shellOpenFileMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(REMOTE_PROJECT, 'README.md', 3, { preview: true })
  })

  it('hides local open actions in the web client and never calls shell.openFile', async () => {
    const { FileLink } = await loadFileLinkModule({ platform: 'darwin', web: true })
    const tree = expandComponents(
      createElement(FileLink, {
        file: { projectPath: LOCAL_PROJECT, path: 'README.md', line: null },
      }),
    )
    const elements = collectElements(tree)
    const menuItems = elements.filter((el) => el.props['data-mock'] === 'menu-item')
    expect(menuItems.map((item) => textOf(item.props.children as ReactNode))).toEqual(['Copy path'])

    const trigger = elements.find((el) => el.props['data-file-ref'] === '')!
    ;(trigger.props.onClick as (event: Partial<MouseEvent<HTMLButtonElement>>) => void)({
      metaKey: true,
      ctrlKey: false,
      preventDefault: vi.fn(),
    })
    expect(shellOpenFileMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledWith(LOCAL_PROJECT, 'README.md', null, { preview: true })
  })

  it('shows a visible warning toast when opening a missing or failed local file rejects', async () => {
    const { FileLink } = await loadFileLinkModule({ platform: 'darwin' })
    shellOpenFileMock.mockRejectedValueOnce(
      new Error('Could not open “missing.xlsx”: the file no longer exists'),
    )
    const tree = expandComponents(
      createElement(FileLink, {
        file: { projectPath: LOCAL_PROJECT, path: 'reports/missing.xlsx', line: null },
      }),
    )
    const trigger = collectElements(tree).find((el) => el.props['data-file-ref'] === '')!
    ;(trigger.props.onClick as (event: Partial<MouseEvent<HTMLButtonElement>>) => void)({
      metaKey: true,
      ctrlKey: false,
      preventDefault: vi.fn(),
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(toastMock).toHaveBeenCalledWith(
      'Could not open “missing.xlsx”: the file no longer exists',
      undefined,
      { tone: 'warning' },
    )
  })

  it('supports AgentFileLink with the same local Mod+click behavior and remote guard', async () => {
    const { AgentFileLink } = await loadFileLinkModule({ platform: 'darwin' })
    const localTree = expandComponents(
      createElement(AgentFileLink, {
        file: {
          projectPath: LOCAL_PROJECT,
          path: '/Users/dev/.claude/plans/plan.md',
          line: 9,
          sessionId: 'sess-1',
          agentId: 'claude-code',
        },
      }),
    )
    const localTrigger = collectElements(localTree).find((el) => el.props['data-file-ref'] === '')!
    ;(localTrigger.props.onClick as (event: Partial<MouseEvent<HTMLButtonElement>>) => void)({
      metaKey: true,
      ctrlKey: false,
      preventDefault: vi.fn(),
    })
    expect(shellOpenFileMock).toHaveBeenCalledWith('/Users/dev/.claude/plans/plan.md')

    shellOpenFileMock.mockClear()
    const remoteTree = expandComponents(
      createElement(AgentFileLink, {
        file: {
          projectPath: REMOTE_PROJECT,
          path: '/home/dev/.claude/plans/plan.md',
          line: 9,
          sessionId: 'sess-2',
          agentId: 'claude-code',
        },
      }),
    )
    const remoteTrigger = collectElements(remoteTree).find(
      (el) => el.props['data-file-ref'] === '',
    )!
    ;(remoteTrigger.props.onClick as (event: Partial<MouseEvent<HTMLButtonElement>>) => void)({
      metaKey: true,
      ctrlKey: false,
      preventDefault: vi.fn(),
    })
    expect(shellOpenFileMock).not.toHaveBeenCalled()
    expect(openFileMock).toHaveBeenCalledTimes(1)
  })
})

describe('web URL Mod+click behavior and bilingual locales', () => {
  it('preserves web URL planLinkOpen Mod+click flipping between external browser and session browser', () => {
    const prefs: LinkPrefs = { openLinksIn: 'browser', confirmLinks: false, alwaysOpenIn: {} }
    expect(planLinkOpen('https://example.com/docs', prefs, { session: true }, true, false)).toEqual(
      {
        destination: 'browser',
        ask: false,
      },
    )
    expect(planLinkOpen('https://example.com/docs', prefs, { session: true }, true, true)).toEqual({
      destination: 'session',
      ask: false,
    })
  })

  it('provides matching English and Simplified Chinese strings for default-app actions and errors', () => {
    expect(enFiles.preview.openWithDefault).toBe('Open with default app')
    expect(zhFiles.preview.openWithDefault).toBe('使用默认应用打开')
    expect(enMain.shell.notFound).toContain('{{name}}')
    expect(zhMain.shell.notFound).toContain('{{name}}')
    expect(enMain.shell.notFile).toContain('{{name}}')
    expect(zhMain.shell.notFile).toContain('{{name}}')
    expect(enMain.shell.executable).toContain('{{name}}')
    expect(zhMain.shell.executable).toContain('{{name}}')
    expect(enMain.shell.openFailed).toContain('{{name}}')
    expect(zhMain.shell.openFailed).toContain('{{name}}')
  })
})
