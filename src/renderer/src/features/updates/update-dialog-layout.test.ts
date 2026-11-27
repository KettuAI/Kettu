import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  cloneElement,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { BusySession, BusyTerminal } from '@shared/host-control'
import type { QuitRequest } from '@shared/ipc'

// Render Base UI AlertDialog primitives inline during SSR so tests inspect the real class merging
// and DOM hierarchy produced by AlertDialogContent, UpdateDialogView, and QuitConfirmView.
vi.mock('@base-ui/react/alert-dialog', () => {
  type DivProps = Record<string, unknown> & { children?: ReactNode }
  const passthrough = (tag: string) =>
    function Stub({ children, ...rest }: DivProps) {
      const props = { ...rest }
      delete props.initialFocus
      delete props.finalFocus
      return createElement(tag, props, children)
    }

  return {
    AlertDialog: {
      Root: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
        open === false ? null : createElement('div', { 'data-slot': 'alert-dialog' }, children),
      Trigger: passthrough('button'),
      Portal: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
      Backdrop: passthrough('div'),
      Popup: passthrough('div'),
      Title: passthrough('h2'),
      Description: passthrough('p'),
      Close: ({
        render,
        children,
        ...rest
      }: DivProps & { render?: ReactElement<Record<string, unknown>> }) => {
        if (render && isValidElement(render)) {
          return cloneElement(render, { ...rest }, children)
        }
        return createElement('button', { type: 'button', ...rest }, children)
      },
    },
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}))

vi.mock('@renderer/lib/i18n', () => ({
  i18n: {
    t: (key: string) => key,
  },
}))

vi.mock('@renderer/stores/overlays', () => ({
  useOverlayRoot: (_open: unknown, _defaultOpen: unknown, onOpenChange?: (open: boolean) => void) =>
    onOpenChange,
}))

vi.mock('@renderer/stores/sessions', () => ({
  sessionTitle: (s: { title?: string | null; sessionId: string }) => s.title || s.sessionId,
}))

vi.mock('@renderer/stores/updates', () => ({
  openUpdateDialog: vi.fn(),
  useUpdatesStore: vi.fn(() => null),
}))

vi.mock('@renderer/stores/files', () => ({
  saveAll: vi.fn(async () => true),
}))

vi.mock('@renderer/stores/settings', () => ({
  useSettingsStore: vi.fn(() => false),
}))

vi.mock('@renderer/components/agents/agent-mark', () => ({
  AgentMark: ({ agent }: { agent: string }) => createElement('span', { 'data-agent-mark': agent }),
}))

vi.mock('@renderer/features/files/file-type-icon', () => ({
  FileTypeIcon: ({ path: filePath, className }: { path: string; className?: string }) =>
    createElement('span', { 'data-file-icon': filePath, className }),
}))

vi.mock('@hugeicons/core-free-icons', () => ({
  ComputerTerminal01Icon: [],
  InformationCircleIcon: [],
}))

vi.mock('@renderer/features/shell/glyph', () => ({
  Glyph: ({ className }: { className?: string }) =>
    createElement('span', { 'data-glyph': 'true', className }),
}))

const RENDERER_SRC = path.resolve(import.meta.dirname, '../..')

/** Returns the class tokens of the first element with the given `data-slot`. */
function slotClasses(html: string, slot: string): string[] {
  const escaped = slot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = html.match(new RegExp(`<[^>]*data-slot="${escaped}"[^>]*>`, 'i'))
  expect(match, `expected element with data-slot="${slot}"`).not.toBeNull()
  const cls = match![0].match(/\bclass="([^"]*)"/)
  return cls ? cls[1].split(/\s+/).filter(Boolean) : []
}

/** Extracts the inner HTML of a `<div>` element identified by `data-slot`. */
function slotOuterHtml(html: string, slot: string): string {
  const marker = `data-slot="${slot}"`
  const markerIndex = html.indexOf(marker)
  expect(markerIndex, `expected data-slot="${slot}" in rendered markup`).toBeGreaterThanOrEqual(0)
  const start = html.lastIndexOf('<div', markerIndex)
  expect(start).toBeGreaterThanOrEqual(0)
  let depth = 0
  let i = start
  while (i < html.length) {
    const nextOpen = html.indexOf('<div', i)
    const nextClose = html.indexOf('</div>', i)
    if (nextClose === -1) break
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++
      i = nextOpen + 4
    } else {
      depth--
      i = nextClose + 6
      if (depth === 0) return html.slice(start, i)
    }
  }
  throw new Error(`unclosed div for data-slot="${slot}"`)
}

function makeSessions(count: number): BusySession[] {
  return Array.from({ length: count }, (_, i) => ({
    sessionId: `session-${i + 1}`,
    agentId: 'claude-code',
    title: `Working session ${i + 1}`,
    turnStartedAt: 1_700_000_000_000 - (i + 1) * 15_000,
    background: null,
  }))
}

function makeTerminals(count: number): BusyTerminal[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `term-${i + 1}`,
    projectPath: '/workspace/kettu',
    title: `pnpm --filter app-${i + 1} dev --port ${3000 + i}`,
  }))
}

describe('AlertDialogContent viewport height and overflow defaults', () => {
  it('caps height to the viewport and enables vertical scrolling by default', async () => {
    const {
      AlertDialog,
      AlertDialogContent,
      AlertDialogHeader,
      AlertDialogTitle,
      AlertDialogFooter,
      AlertDialogAction,
    } = await import('@renderer/components/ui/alert-dialog')

    const html = renderToStaticMarkup(
      createElement(
        AlertDialog,
        { open: true },
        createElement(
          AlertDialogContent,
          null,
          createElement(AlertDialogHeader, null, createElement(AlertDialogTitle, null, 'Confirm')),
          createElement(AlertDialogFooter, null, createElement(AlertDialogAction, null, 'OK')),
        ),
      ),
    )

    const contentClasses = slotClasses(html, 'alert-dialog-content')
    expect(contentClasses).toContain('grid')
    expect(contentClasses).toContain('max-h-[calc(100dvh-2rem)]')
    expect(contentClasses).toContain('overflow-y-auto')

    expect(slotClasses(html, 'alert-dialog-header')).toContain('shrink-0')
    expect(slotClasses(html, 'alert-dialog-footer')).toContain('shrink-0')
  })

  it('lets flex-column callers replace grid and outer overflow while keeping the viewport max-h', async () => {
    const { AlertDialog, AlertDialogContent } = await import('@renderer/components/ui/alert-dialog')

    const html = renderToStaticMarkup(
      createElement(
        AlertDialog,
        { open: true },
        createElement(AlertDialogContent, {
          className: 'flex flex-col gap-0 overflow-hidden px-0 pt-5 pb-4.5',
        }),
      ),
    )

    const contentClasses = slotClasses(html, 'alert-dialog-content')
    expect(contentClasses).toContain('max-h-[calc(100dvh-2rem)]')
    expect(contentClasses).toContain('flex')
    expect(contentClasses).toContain('flex-col')
    expect(contentClasses).toContain('overflow-hidden')
    expect(contentClasses).not.toContain('grid')
    expect(contentClasses).not.toContain('overflow-y-auto')
  })

  it('keeps the AlertDialog viewport cap and overlay-layer contract in source', () => {
    const source = readFileSync(path.join(RENDERER_SRC, 'components/ui/alert-dialog.tsx'), 'utf8')
    expect(source).toContain('max-h-[calc(100dvh-2rem)]')
    expect(source).toContain('overflow-y-auto')
    expect(source).toContain('data-overlay-layer=""')
  })
})

describe('UpdateDialog scrollable body and pinned header/footer layout', () => {
  it('keeps header and footer pinned outside a scrollable body for tall highlights and many terminals', async () => {
    const { UpdateDialogView } = await import('@renderer/features/updates/update-dialog')

    const highlights = Array.from(
      { length: 12 },
      (_, i) => `Release highlight ${i + 1}: significant improvement across desktop and mobile`,
    )
    const sessions = makeSessions(5)
    const terminals = makeTerminals(20)

    const html = renderToStaticMarkup(
      createElement(UpdateDialogView, {
        open: true,
        version: '0.1.28',
        highlights,
        work: { sessions, terminals },
        waiting: false,
        now: 1_700_000_100_000,
        defaultButton: { current: null },
        onOpenChange: vi.fn(),
        onRestartNow: vi.fn(),
        onRestartWhenIdle: vi.fn(),
        onStopWaiting: vi.fn(),
      }),
    )

    const contentClasses = slotClasses(html, 'alert-dialog-content')
    expect(contentClasses).toContain('max-h-[calc(100dvh-2rem)]')
    expect(contentClasses).toContain('flex')
    expect(contentClasses).toContain('flex-col')
    expect(contentClasses).toContain('overflow-hidden')
    expect(contentClasses).toContain('px-0')

    const headerClasses = slotClasses(html, 'alert-dialog-header')
    expect(headerClasses).toContain('shrink-0')
    expect(headerClasses).toContain('px-5.5')

    const bodyClasses = slotClasses(html, 'update-dialog-body')
    expect(bodyClasses).toContain('min-h-0')
    expect(bodyClasses).toContain('flex-1')
    expect(bodyClasses).toContain('overflow-y-auto')
    expect(bodyClasses).toContain('px-5.5')

    const footerClasses = slotClasses(html, 'alert-dialog-footer')
    expect(footerClasses).toContain('shrink-0')
    expect(footerClasses).toContain('px-5.5')

    const headerHtml = slotOuterHtml(html, 'alert-dialog-header')
    const bodyHtml = slotOuterHtml(html, 'update-dialog-body')
    const footerHtml = slotOuterHtml(html, 'alert-dialog-footer')

    // Header and footer must remain siblings outside the scrollable middle region.
    expect(bodyHtml).not.toContain('data-slot="alert-dialog-header"')
    expect(bodyHtml).not.toContain('data-slot="alert-dialog-footer"')
    expect(html.indexOf(headerHtml)).toBeLessThan(html.indexOf(bodyHtml))
    expect(html.indexOf(bodyHtml)).toBeLessThan(html.indexOf(footerHtml))

    // Tall highlights, all running sessions/terminals, and the info note live inside the scroll body.
    expect(bodyHtml).toContain('Release highlight 1:')
    expect(bodyHtml).toContain('Release highlight 12:')
    expect(bodyHtml).toContain('Working session 1')
    expect(bodyHtml).toContain('Working session 5')
    expect(bodyHtml).toContain('pnpm --filter app-1 dev --port 3000')
    expect(bodyHtml).toContain('pnpm --filter app-20 dev --port 3019')
    expect(bodyHtml).toContain('data-slot="alert-dialog-description"')

    // Every running-work row prevents flex shrinking so row height never collapses.
    const rowTags = bodyHtml.match(/<li class="flex h-8\.5[^"]*">/g) ?? []
    expect(rowTags).toHaveLength(25)
    for (const tag of rowTags) {
      expect(tag).toContain('shrink-0')
    }

    // Release notes link and action buttons stay pinned inside the footer.
    expect(footerHtml).toContain('dialog.releaseNotes')
    expect(footerHtml).toContain('dialog.later')
    expect(footerHtml).toContain('dialog.restart')
    expect(footerHtml).toContain('dialog.restartWhenIdle')
  })

  it('keeps the compact layout intact when there are no highlights or running work', async () => {
    const { UpdateDialogView } = await import('@renderer/features/updates/update-dialog')

    const html = renderToStaticMarkup(
      createElement(UpdateDialogView, {
        open: true,
        version: '0.1.28',
        highlights: [],
        work: { sessions: [], terminals: [] },
        waiting: false,
        now: 1_700_000_100_000,
        defaultButton: { current: null },
        onOpenChange: vi.fn(),
        onRestartNow: vi.fn(),
        onRestartWhenIdle: vi.fn(),
        onStopWaiting: vi.fn(),
      }),
    )

    const bodyClasses = slotClasses(html, 'update-dialog-body')
    expect(bodyClasses).toContain('mt-3')
    expect(bodyClasses).toContain('min-h-0')
    expect(bodyClasses).toContain('flex-1')
    expect(bodyClasses).toContain('overflow-y-auto')

    const footerHtml = slotOuterHtml(html, 'alert-dialog-footer')
    expect(footerHtml).toContain('dialog.later')
    expect(footerHtml).toContain('dialog.restart')
  })
})

describe('QuitConfirm scrollable body and pinned header/footer layout', () => {
  it('keeps header and footer pinned outside a scrollable body for many terminals and unsaved files', async () => {
    const { QuitConfirmView } = await import('@renderer/features/updates/quit-confirm')

    const request: QuitRequest = {
      id: 1,
      reason: 'update',
      sessions: makeSessions(6),
      terminals: makeTerminals(18),
      unsaved: Array.from({ length: 15 }, (_, i) => ({
        projectPath: '/workspace/kettu',
        path: `src/renderer/src/features/updates/file-${i + 1}.ts`,
      })),
      keepRunning: false,
      whenIdle: false,
    }

    const html = renderToStaticMarkup(
      createElement(QuitConfirmView, {
        request,
        saving: false,
        saveFailed: false,
        remote: false,
        now: 1_700_000_100_000,
        keepRef: { current: null },
        waitRef: { current: null },
        onAnswer: vi.fn(),
        onSaveThenAnswer: vi.fn(),
      }),
    )

    const contentClasses = slotClasses(html, 'alert-dialog-content')
    expect(contentClasses).toContain('max-h-[calc(100dvh-2rem)]')
    expect(contentClasses).toContain('flex')
    expect(contentClasses).toContain('flex-col')
    expect(contentClasses).toContain('overflow-hidden')
    expect(contentClasses).toContain('px-0')

    const headerClasses = slotClasses(html, 'alert-dialog-header')
    expect(headerClasses).toContain('shrink-0')
    expect(headerClasses).toContain('px-5.5')

    const bodyClasses = slotClasses(html, 'quit-confirm-body')
    expect(bodyClasses).toContain('min-h-0')
    expect(bodyClasses).toContain('flex-1')
    expect(bodyClasses).toContain('overflow-y-auto')
    expect(bodyClasses).toContain('px-5.5')

    const footerClasses = slotClasses(html, 'alert-dialog-footer')
    expect(footerClasses).toContain('shrink-0')
    expect(footerClasses).toContain('px-5.5')

    const headerHtml = slotOuterHtml(html, 'alert-dialog-header')
    const bodyHtml = slotOuterHtml(html, 'quit-confirm-body')
    const footerHtml = slotOuterHtml(html, 'alert-dialog-footer')

    expect(bodyHtml).not.toContain('data-slot="alert-dialog-header"')
    expect(bodyHtml).not.toContain('data-slot="alert-dialog-footer"')
    expect(html.indexOf(headerHtml)).toBeLessThan(html.indexOf(bodyHtml))
    expect(html.indexOf(bodyHtml)).toBeLessThan(html.indexOf(footerHtml))

    // Running work, unsaved files, and explanatory copy live inside the scrollable body.
    expect(bodyHtml).toContain('Working session 1')
    expect(bodyHtml).toContain('pnpm --filter app-18 dev --port 3017')
    expect(bodyHtml).toContain('file-1.ts')
    expect(bodyHtml).toContain('file-15.ts')
    expect(bodyHtml).toContain('quit.comeBackUpdate')

    // Action buttons remain pinned in the footer.
    expect(footerHtml).toContain('common:actions.cancel')
    expect(footerHtml).toContain('quit.dontSave')
    expect(footerHtml).toContain('quit.saveAndRestart')
  })

  it('pins header and footer in keepRunning mode with running terminals', async () => {
    const { QuitConfirmView } = await import('@renderer/features/updates/quit-confirm')

    const request: QuitRequest = {
      id: 2,
      reason: 'quit',
      sessions: [],
      terminals: makeTerminals(20),
      unsaved: [],
      keepRunning: true,
      whenIdle: false,
    }

    const html = renderToStaticMarkup(
      createElement(QuitConfirmView, {
        request,
        saving: false,
        saveFailed: false,
        remote: true,
        now: 1_700_000_100_000,
        keepRef: { current: null },
        waitRef: { current: null },
        onAnswer: vi.fn(),
        onSaveThenAnswer: vi.fn(),
      }),
    )

    const bodyHtml = slotOuterHtml(html, 'quit-confirm-body')
    const footerHtml = slotOuterHtml(html, 'alert-dialog-footer')

    expect(bodyHtml).toContain('pnpm --filter app-20 dev --port 3019')
    expect(bodyHtml).toContain('quit.keepRunningRemote')
    expect(footerHtml).toContain('quit.stopAndQuit')
    expect(footerHtml).toContain('quit.keepRunningAction')
  })
})
