import {
  createElement,
  isValidElement,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfigWarningDetail } from '@shared/thread'
import enHost from '@shared/locales/en/host.json'
import enSession from '@shared/locales/en/session.json'
import zhHost from '@shared/locales/zh-CN/host.json'
import zhSession from '@shared/locales/zh-CN/session.json'
import { planLinkOpen, type LinkPrefs } from '../link-open'
import {
  CODEX_CONFIG_DOCS_URL,
  formatConfigWarningLocation,
  isSafeLocalConfigPath,
  knownConfigWarningLayer,
  resolveConfigWarningSourceAction,
  safeConfigDocsUrl,
} from './config-warning-actions'

const LOCAL_PROJECT = '/Users/dev/app'
const WIN_PROJECT = 'C:\\Work\\App'
const REMOTE_PROJECT = 'kettu-host:0123456789abcdef0123456789abcdef:/home/dev/app'

const openFileMock = vi.fn()
const openFileInDefaultAppMock = vi.fn()
const openSessionLinkMock = vi.fn()
let mockIsWeb = false
let mockStoredProjectPath = LOCAL_PROJECT

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@renderer/lib/platform', () => ({
  get isWeb() {
    return mockIsWeb
  },
  isMod: (event: { metaKey?: boolean; ctrlKey?: boolean }) =>
    Boolean(event.metaKey || event.ctrlKey),
}))

vi.mock('@renderer/stores/files', () => ({
  openFile: (...args: unknown[]) => openFileMock(...args),
}))

vi.mock('@renderer/features/files/operations', () => ({
  openFileInDefaultApp: (...args: unknown[]) => openFileInDefaultAppMock(...args),
}))

vi.mock('@renderer/stores/sessions', () => ({
  useSessionsStore: <T>(
    selector: (state: { byId: Record<string, { projectPath: string }> }) => T,
  ) => selector({ byId: { 'sess-1': { projectPath: mockStoredProjectPath } } }),
}))

vi.mock('@renderer/features/git/copy-button', () => ({
  CopyButton: ({ text, label }: { text: string; label: string }) =>
    createElement('button', { type: 'button', 'data-copy': text, 'aria-label': label }),
}))

vi.mock('../link-confirm', () => ({
  ConfirmedLink: ({ url }: { url: string }) => createElement('a', { href: url }, url),
}))

vi.mock('../open-link', () => ({
  sessionLinkProps: (url: string, sessionId: string | null | undefined) => ({
    href: url,
    rel: 'noreferrer',
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
      openSessionLinkMock(url, sessionId, { other: Boolean(event.metaKey || event.ctrlKey) })
    },
    onAuxClick: (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault()
      openSessionLinkMock(url, sessionId, { other: false })
    },
  }),
}))

vi.mock('@hugeicons/core-free-icons', () => ({
  Alert02Icon: {},
  File01Icon: {},
  LinkSquare02Icon: {},
}))

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    ...rest
  }: {
    children?: ReactNode
    onClick?: (event: MouseEvent<HTMLButtonElement>) => void
    [key: string]: unknown
  }) => createElement('button', { type: 'button', onClick, ...rest }, children),
  buttonVariants: () => 'btn',
}))

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children, ...rest }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement('span', rest, children),
}))

vi.mock('@renderer/components/ui/alert', () => ({
  Alert: ({ children, ...rest }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement('div', { role: 'alert', ...rest }, children),
  AlertTitle: ({ children, ...rest }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement('div', rest, children),
  AlertDescription: ({ children, ...rest }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement('div', rest, children),
}))

vi.mock('@hugeicons/react', () => ({
  HugeiconsIcon: () => null,
}))

const { ConfigWarningEntry } = await import('./config-warning')

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
  if (node.props.children !== undefined) collectElements(node.props.children as ReactNode, out)
  return out
}

function expand(node: ReactNode): ReactNode {
  if (Array.isArray(node)) return node.map(expand)
  if (!isValidElement<Record<string, unknown>>(node)) return node
  if (typeof node.type === 'function') {
    return expand((node.type as (props: Record<string, unknown>) => ReactNode)(node.props))
  }
  if (
    typeof node.type === 'object' &&
    node.type !== null &&
    'type' in node.type &&
    typeof (node.type as { type: unknown }).type === 'function'
  ) {
    return expand(
      (node.type as { type: (props: Record<string, unknown>) => ReactNode }).type(node.props),
    )
  }
  return {
    ...node,
    props: {
      ...node.props,
      ...(node.props.children !== undefined
        ? { children: expand(node.props.children as ReactNode) }
        : {}),
    },
  } as ReactElement
}

function fakeMouseEvent(overrides: Partial<MouseEvent<HTMLElement>> = {}): MouseEvent<HTMLElement> {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as MouseEvent<HTMLElement>
}

describe('config-warning-actions', () => {
  it('validates safe local absolute config paths and rejects unsafe or relative inputs', () => {
    expect(isSafeLocalConfigPath('/Users/dev/.codex/config.toml')).toBe(true)
    expect(isSafeLocalConfigPath('C:\\Users\\dev\\.codex\\config.toml')).toBe(true)
    expect(isSafeLocalConfigPath('~/.codex/config.toml')).toBe(false)
    expect(isSafeLocalConfigPath('.codex/config.toml')).toBe(false)
    expect(isSafeLocalConfigPath('//server/share/config.toml')).toBe(false)
    expect(isSafeLocalConfigPath('\\\\server\\share\\config.toml')).toBe(false)
    expect(isSafeLocalConfigPath('/Users/dev/\0config.toml')).toBe(false)
    expect(isSafeLocalConfigPath('')).toBe(false)
  })

  it('formats locations with optional 1-based line and column', () => {
    expect(formatConfigWarningLocation({ path: '/Users/dev/.codex/config.toml' })).toBe(
      '/Users/dev/.codex/config.toml',
    )
    expect(formatConfigWarningLocation({ path: '/Users/dev/.codex/config.toml', line: 7 })).toBe(
      '/Users/dev/.codex/config.toml:7',
    )
    expect(
      formatConfigWarningLocation({ path: '/Users/dev/.codex/config.toml', line: 7, column: 3 }),
    ).toBe('/Users/dev/.codex/config.toml:7:3')
  })

  it('normalizes known config layer labels and sanitizes docs URLs', () => {
    expect(knownConfigWarningLayer('USER')).toBe('user')
    expect(knownConfigWarningLayer('project')).toBe('project')
    expect(knownConfigWarningLayer('custom')).toBeNull()
    expect(safeConfigDocsUrl('https://developers.openai.com/codex/config-basic')).toBe(
      'https://developers.openai.com/codex/config-basic',
    )
    expect(safeConfigDocsUrl('javascript:alert(1)')).toBe(CODEX_CONFIG_DOCS_URL)
    expect(safeConfigDocsUrl(undefined)).toBe(CODEX_CONFIG_DOCS_URL)
  })

  it('opens in-project config files in Files pane and outside-project local configs in default app', () => {
    const projectFile = resolveConfigWarningSourceAction(
      { layer: 'project', path: '/Users/dev/app/.codex/config.toml', line: 3, column: 2 },
      { projectPath: LOCAL_PROJECT, web: false },
    )
    expect(projectFile).toEqual({
      location: '/Users/dev/app/.codex/config.toml:3:2',
      filesPane: { projectPath: LOCAL_PROJECT, relativePath: '.codex/config.toml', line: 3 },
      localFile: '/Users/dev/app/.codex/config.toml',
      primary: 'files-pane',
    })

    const userFile = resolveConfigWarningSourceAction(
      { layer: 'user', path: '/Users/dev/.codex/config.toml' },
      { projectPath: LOCAL_PROJECT, web: false },
    )
    expect(userFile).toEqual({
      location: '/Users/dev/.codex/config.toml',
      filesPane: null,
      localFile: '/Users/dev/.codex/config.toml',
      primary: 'default-app',
    })

    const winUserFile = resolveConfigWarningSourceAction(
      { layer: 'user', path: 'C:\\Users\\dev\\.codex\\config.toml' },
      { projectPath: WIN_PROJECT, web: false },
    )
    expect(winUserFile.primary).toBe('default-app')
    expect(winUserFile.localFile).toBe('C:\\Users\\dev\\.codex\\config.toml')
  })

  it('gracefully degrades outside-project configs on remote hosts and web clients', () => {
    const remoteUser = resolveConfigWarningSourceAction(
      { layer: 'user', path: '/home/dev/.codex/config.toml' },
      { projectPath: REMOTE_PROJECT, web: false },
    )
    expect(remoteUser.filesPane).toBeNull()
    expect(remoteUser.localFile).toBeNull()
    expect(remoteUser.primary).toBeNull()

    const webUser = resolveConfigWarningSourceAction(
      { layer: 'user', path: '/Users/dev/.codex/config.toml' },
      { projectPath: LOCAL_PROJECT, web: true },
    )
    expect(webUser.filesPane).toBeNull()
    expect(webUser.localFile).toBeNull()
    expect(webUser.primary).toBeNull()

    // In-project config on a remote host still opens in Kettu's Files side pane.
    const remoteProject = resolveConfigWarningSourceAction(
      { layer: 'project', path: '/home/dev/app/.codex/config.toml', line: 9 },
      { projectPath: REMOTE_PROJECT, web: false },
    )
    expect(remoteProject.filesPane).toEqual({
      projectPath: REMOTE_PROJECT,
      relativePath: '.codex/config.toml',
      line: 9,
    })
    expect(remoteProject.localFile).toBeNull()
    expect(remoteProject.primary).toBe('files-pane')
  })
  it('plans Codex docs link routing through planLinkOpen', () => {
    const prefs: LinkPrefs = {
      openLinksIn: 'browser',
      confirmLinks: false,
      alwaysOpenIn: {},
    }
    expect(planLinkOpen(CODEX_CONFIG_DOCS_URL, prefs, { session: true }, true, false)).toEqual({
      destination: 'browser',
      ask: false,
    })
    expect(planLinkOpen(CODEX_CONFIG_DOCS_URL, prefs, { session: true }, true, true)).toEqual({
      destination: 'session',
      ask: false,
    })
    expect(
      planLinkOpen(
        CODEX_CONFIG_DOCS_URL,
        { ...prefs, confirmLinks: true },
        { session: true },
        false,
        false,
      ),
    ).toEqual({
      destination: 'browser',
      ask: true,
    })
  })
})

describe('ConfigWarningEntry rendering and action routing', () => {
  beforeEach(() => {
    mockIsWeb = false
    mockStoredProjectPath = LOCAL_PROJECT
    openFileMock.mockReset()
    openFileInDefaultAppMock.mockReset()
    openSessionLinkMock.mockReset()
  })

  afterEach(() => {
    mockIsWeb = false
  })

  it('renders deprecated impact, omits file open action without a path, and routes docs via sessionLinkProps', () => {
    const detail: ConfigWarningDetail = {
      agent: 'codex',
      impact: 'deprecated',
      docsUrl: CODEX_CONFIG_DOCS_URL,
    }
    const element = createElement(ConfigWarningEntry, {
      sessionId: 'sess-1',
      projectPath: LOCAL_PROJECT,
      title: 'Codex configuration warning',
      description: '`[features].multi_agent` is deprecated. It still controls the V1 fallback.',
      detail,
    })

    const html = renderToStaticMarkup(element)
    expect(html).toContain('thread.configWarning.title')
    expect(html).toContain('thread.configWarning.impact.deprecated.badge')
    expect(html).toContain('thread.configWarning.impact.deprecated.note')
    expect(html).not.toContain('data-config-action="open-file"')
    expect(html).toContain('data-config-action="open-docs"')

    const tree = expand(element)
    const nodes = collectElements(tree)
    const docsLink = nodes.find((node) => node.props['data-config-action'] === 'open-docs')
    expect(docsLink?.props.href).toBe(CODEX_CONFIG_DOCS_URL)
    const click = fakeMouseEvent({ metaKey: true })
    ;(docsLink?.props.onClick as (event: MouseEvent<HTMLAnchorElement>) => void)(
      click as unknown as MouseEvent<HTMLAnchorElement>,
    )
    expect(openSessionLinkMock).toHaveBeenCalledWith(CODEX_CONFIG_DOCS_URL, 'sess-1', {
      other: true,
    })
  })

  it('opens local user config.toml in default app and hides the button on remote/web sessions', () => {
    const detail: ConfigWarningDetail = {
      agent: 'codex',
      impact: 'ignored',
      sources: [{ layer: 'user', path: '/Users/dev/.codex/config.toml' }],
      docsUrl: CODEX_CONFIG_DOCS_URL,
    }

    const localElement = createElement(ConfigWarningEntry, {
      sessionId: 'sess-1',
      projectPath: LOCAL_PROJECT,
      title: 'Codex configuration warning',
      description: 'disable_response_storage is ignored.',
      detail,
    })
    const localHtml = renderToStaticMarkup(localElement)
    expect(localHtml).toContain('thread.configWarning.impact.ignored.badge')
    expect(localHtml).toContain('thread.configWarning.layer.user')
    expect(localHtml).toContain('/Users/dev/.codex/config.toml')
    expect(localHtml).toContain('thread.configWarning.openConfig')

    const localTree = expand(localElement)
    const openBtn = collectElements(localTree).find(
      (node) => node.props['data-config-action'] === 'open-file',
    )
    expect(openBtn).toBeDefined()
    ;(openBtn?.props.onClick as (event: MouseEvent<HTMLButtonElement>) => void)(
      fakeMouseEvent() as unknown as MouseEvent<HTMLButtonElement>,
    )
    expect(openFileInDefaultAppMock).toHaveBeenCalledWith('/Users/dev/.codex/config.toml')
    expect(openFileMock).not.toHaveBeenCalled()

    // Remote host degrades gracefully: path and docs remain, local open button is omitted.
    const remoteHtml = renderToStaticMarkup(
      createElement(ConfigWarningEntry, {
        sessionId: 'sess-1',
        projectPath: REMOTE_PROJECT,
        title: 'Codex configuration warning',
        description: 'disable_response_storage is ignored.',
        detail,
      }),
    )
    expect(remoteHtml).toContain('/Users/dev/.codex/config.toml')
    expect(remoteHtml).not.toContain('data-config-action="open-file"')
    expect(remoteHtml).toContain('data-config-action="open-docs"')

    // Web client also degrades gracefully for outside-project config files.
    mockIsWeb = true
    const webHtml = renderToStaticMarkup(
      createElement(ConfigWarningEntry, {
        sessionId: 'sess-1',
        projectPath: LOCAL_PROJECT,
        title: 'Codex configuration warning',
        description: 'disable_response_storage is ignored.',
        detail,
      }),
    )
    expect(webHtml).not.toContain('data-config-action="open-file"')
    expect(webHtml).toContain('data-config-action="open-docs"')
  })

  it('opens in-project config.toml in Kettu Files pane on click and default app on Mod+click', () => {
    const detail: ConfigWarningDetail = {
      agent: 'codex',
      impact: 'invalid',
      sources: [
        { layer: 'project', path: '/Users/dev/app/.codex/config.toml', line: 4, column: 9 },
      ],
      docsUrl: CODEX_CONFIG_DOCS_URL,
    }
    const element = createElement(ConfigWarningEntry, {
      sessionId: 'sess-1',
      projectPath: LOCAL_PROJECT,
      title: 'Codex configuration warning',
      description: 'Invalid configuration; using defaults.',
      detail,
    })

    const html = renderToStaticMarkup(element)
    expect(html).toContain('thread.configWarning.viewInFiles')
    expect(html).toContain('/Users/dev/app/.codex/config.toml:4:9')

    const openBtn = collectElements(expand(element)).find(
      (node) => node.props['data-config-action'] === 'open-file',
    )
    ;(openBtn?.props.onClick as (event: MouseEvent<HTMLButtonElement>) => void)(
      fakeMouseEvent() as unknown as MouseEvent<HTMLButtonElement>,
    )
    expect(openFileMock).toHaveBeenCalledWith(LOCAL_PROJECT, '.codex/config.toml', 4, {
      preview: true,
    })

    ;(openBtn?.props.onClick as (event: MouseEvent<HTMLButtonElement>) => void)(
      fakeMouseEvent({ metaKey: true }) as unknown as MouseEvent<HTMLButtonElement>,
    )
    expect(openFileInDefaultAppMock).toHaveBeenCalledWith('/Users/dev/app/.codex/config.toml')
  })

  it('renders per-source actions when multiple config files are reported', () => {
    const detail: ConfigWarningDetail = {
      agent: 'codex',
      impact: 'ignored',
      sources: [
        { layer: 'project', path: '/Users/dev/app/.codex/config.toml' },
        { layer: 'user', path: '/Users/dev/.codex/config.toml' },
      ],
      docsUrl: CODEX_CONFIG_DOCS_URL,
    }
    const element = createElement(ConfigWarningEntry, {
      sessionId: 'sess-1',
      projectPath: LOCAL_PROJECT,
      title: 'Codex configuration warning',
      description: 'Codex is ignoring 2 unrecognized configuration settings.',
      detail,
    })

    const html = renderToStaticMarkup(element)
    expect(html).toContain('thread.configWarning.layer.project')
    expect(html).toContain('thread.configWarning.layer.user')
    expect(html).toContain('thread.configWarning.viewShort')
    expect(html).toContain('thread.configWarning.openShort')
    expect(html).not.toContain('data-config-action="open-file"')
  })

  it('keeps en and zh-CN configWarning locale keys in parity', () => {
    expect(enHost.codex.notice.configWarning).toBeTruthy()
    expect(zhHost.codex.notice.configWarning).toBeTruthy()
    expect(Object.keys(zhSession.thread.configWarning).sort()).toEqual(
      Object.keys(enSession.thread.configWarning).sort(),
    )
    expect(Object.keys(zhSession.thread.configWarning.impact).sort()).toEqual(
      Object.keys(enSession.thread.configWarning.impact).sort(),
    )
    expect(Object.keys(zhSession.thread.configWarning.layer).sort()).toEqual(
      Object.keys(enSession.thread.configWarning.layer).sort(),
    )
  })
})
