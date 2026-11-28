import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionSummary } from '@shared/agent-host'
import type { ConfigOption, SessionView } from '@shared/thread'

let mockSessions: Record<string, SessionSummary> = {}
let mockViews: Record<string, SessionView | undefined> = {}

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string) =>
      ns === 'composer' && key === 'controls.permissionMode' ? 'Permission mode' : key,
  }),
  Trans: ({
    values,
    components,
  }: {
    values?: { title?: string }
    components?: { parent?: ReactNode }
  }) => createElement('span', null, 'Started from ', components?.parent ?? values?.title ?? ''),
}))

vi.mock('@renderer/stores/sessions', () => ({
  sessionTitle: (summary: SessionSummary) => summary.title ?? 'Untitled session',
  useSessionsStore: (selector: (state: { byId: Record<string, SessionSummary> }) => unknown) =>
    selector({ byId: mockSessions }),
}))

vi.mock('@renderer/stores/view', () => ({
  openSession: vi.fn(),
}))

vi.mock('../use-thread', () => ({
  useSessionView: (sessionId: string) => mockViews[sessionId],
}))

const { SubSessionStart } = await import('./sub-session-start')

function summary(overrides: Partial<SessionSummary> & { id: string }): SessionSummary {
  return {
    agentId: 'claude-code',
    projectPath: '/repo',
    scratch: false,
    title: overrides.id,
    status: 'ready',
    attention: 'none',
    permissionCount: 0,
    createdAt: 1,
    updatedAt: 1,
    parentId: null,
    origin: 'user',
    routine: null,
    description: null,
    missing: false,
    branch: null,
    pr: null,
    cache: null,
    model: null,
    pinnedAt: null,
    archivedAt: null,
    acpSessionId: null,
    ...overrides,
  }
}

function viewWithMode(value: string, name: string): SessionView {
  const mode: ConfigOption = {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    value,
    choices: [{ value, name }],
  }
  return { config: [mode] } as unknown as SessionView
}

describe('SubSessionStart', () => {
  beforeEach(() => {
    mockSessions = {
      parent: summary({ id: 'parent', title: 'Coordinator' }),
      child: summary({ id: 'child', title: 'Worker', parentId: 'parent' }),
    }
    mockViews = {}
  })

  it('displays the effective Full access mode badge with danger styling in a child session', () => {
    mockViews.child = viewWithMode('bypassPermissions', 'Full access')
    const html = renderToStaticMarkup(createElement(SubSessionStart, { sessionId: 'child' }))
    expect(html).toContain('Started from')
    expect(html).toContain('Full access')
    expect(html).toContain('text-danger')
    expect(html).toContain('Permission mode: Full access')
  })

  it('displays a standard effective mode badge without danger styling', () => {
    mockViews.child = viewWithMode('acceptEdits', 'Accept edits')
    const html = renderToStaticMarkup(createElement(SubSessionStart, { sessionId: 'child' }))
    expect(html).toContain('Accept edits')
    expect(html).not.toContain('text-danger')
  })

  it('omits the mode badge when the child session reports no mode config option', () => {
    mockViews.child = { config: [] } as unknown as SessionView
    const html = renderToStaticMarkup(createElement(SubSessionStart, { sessionId: 'child' }))
    expect(html).toContain('Started from')
    expect(html).not.toContain('Permission mode:')
  })
})
