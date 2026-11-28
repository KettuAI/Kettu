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
import type { Project } from '@shared/agent-host'

vi.mock('@base-ui/react/dialog', () => {
  type Props = Record<string, unknown> & { children?: ReactNode }
  const passthrough = (tag: string) =>
    function Stub({ children, ...rest }: Props) {
      const props = { ...rest }
      delete props.initialFocus
      delete props.finalFocus
      delete props.forceRender
      return createElement(tag, props, children)
    }

  return {
    Dialog: {
      Root: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
        open === false ? null : createElement('div', { 'data-slot': 'dialog' }, children),
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
      }: Props & { render?: ReactElement<Record<string, unknown>> }) => {
        if (render && isValidElement(render)) {
          return cloneElement(render, { ...rest }, children)
        }
        return createElement('button', { type: 'button', ...rest }, children)
      },
    },
  }
})

vi.mock('@base-ui/react/input', () => ({
  Input: (props: Record<string, unknown>) => createElement('input', props),
}))

vi.mock('@base-ui/react/popover', () => {
  type Props = Record<string, unknown> & { children?: ReactNode }
  return {
    Popover: {
      Root: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
      Trigger: (props: Props) => createElement('button', { type: 'button', ...props }),
      Portal: () => null,
      Positioner: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
      Popup: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
      Title: ({ children }: { children?: ReactNode }) => createElement('h3', null, children),
      Description: ({ children }: { children?: ReactNode }) => createElement('p', null, children),
    },
  }
})

vi.mock('@base-ui/react/tooltip', () => {
  type Props = Record<string, unknown> & {
    children?: ReactNode
    render?: ReactElement<Record<string, unknown>>
  }
  return {
    Tooltip: {
      Provider: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
      Root: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
      Trigger: ({ render, children, ...rest }: Props) =>
        render && isValidElement(render)
          ? cloneElement(render, { ...rest }, children)
          : createElement('button', { type: 'button', ...rest }, children),
      Portal: () => null,
      Positioner: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
      Popup: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
      Arrow: () => null,
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
    language: 'en',
  },
}))

vi.mock('@renderer/stores/overlays', () => ({
  useOverlayRoot: (_open: unknown, _defaultOpen: unknown, onOpenChange?: (open: boolean) => void) =>
    onOpenChange,
}))

vi.mock('@renderer/lib/platform', () => ({
  isWeb: false,
  hasBand: false,
}))

vi.mock('@renderer/components/affect/app-shell', () => ({
  FolderClosedMark: () => createElement('span', { 'data-folder-mark': '' }),
}))

vi.mock('@renderer/features/shell/glyph', () => ({
  Glyph: ({ className }: { className?: string }) =>
    createElement('span', { 'data-glyph': '', className }),
}))

vi.mock('@renderer/features/shell/project-icon', () => ({
  ProjectMark: () => createElement('span', { 'data-project-mark': '' }),
}))

vi.mock('@renderer/features/session/new-session/host-folder-dialog', () => ({
  HostFolderDialog: () => null,
}))

const RENDERER_SRC = path.resolve(import.meta.dirname, '../..')

function slotClasses(html: string, slot: string): string[] {
  const escaped = slot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = html.match(new RegExp(`<[^>]*data-slot="${escaped}"[^>]*>`, 'i'))
  expect(match, `expected element with data-slot="${slot}"`).not.toBeNull()
  const cls = match![0].match(/\bclass="([^"]*)"/)
  return cls ? cls[1].split(/\s+/).filter(Boolean) : []
}

function makeProject(overrides: Partial<Project> & { path: string; name: string }): Project {
  return {
    missing: false,
    lastOpenedAt: 100,
    pinnedAt: null,
    order: null,
    ...overrides,
  }
}

describe('DialogContent single-column track containment', () => {
  it('constrains its default grid track with grid-cols-1 so wide content cannot overflow the dialog', async () => {
    const { Dialog, DialogContent, DialogHeader, DialogTitle } =
      await import('@renderer/components/ui/dialog')

    const html = renderToStaticMarkup(
      createElement(
        Dialog,
        { open: true },
        createElement(
          DialogContent,
          null,
          createElement(DialogHeader, null, createElement(DialogTitle, null, 'Dialog')),
        ),
      ),
    )

    const contentClasses = slotClasses(html, 'dialog-content')
    expect(contentClasses).toContain('grid')
    expect(contentClasses).toContain('grid-cols-1')
    expect(contentClasses).toContain('w-full')
    expect(contentClasses).toContain('max-w-[calc(100%-2rem)]')
  })

  it('allows callers to override grid columns or switch to flex layout cleanly', async () => {
    const { Dialog, DialogContent } = await import('@renderer/components/ui/dialog')

    const customGridHtml = renderToStaticMarkup(
      createElement(
        Dialog,
        { open: true },
        createElement(DialogContent, { className: 'grid-cols-[minmax(0,1fr)] gap-0 p-0' }),
      ),
    )
    const customGridClasses = slotClasses(customGridHtml, 'dialog-content')
    expect(customGridClasses).toContain('grid-cols-[minmax(0,1fr)]')
    expect(customGridClasses).not.toContain('grid-cols-1')

    const flexHtml = renderToStaticMarkup(
      createElement(
        Dialog,
        { open: true },
        createElement(DialogContent, { className: 'flex flex-col gap-0 p-0' }),
      ),
    )
    const flexClasses = slotClasses(flexHtml, 'dialog-content')
    expect(flexClasses).toContain('flex')
    expect(flexClasses).toContain('flex-col')
    expect(flexClasses).not.toContain('grid')
  })

  it('keeps grid-cols-1 on DialogContent in source', () => {
    const source = readFileSync(path.join(RENDERER_SRC, 'components/ui/dialog.tsx'), 'utf8')
    expect(source).toContain('grid-cols-1')
  })
})

describe('EditProjectDialog input and path containment', () => {
  it('keeps the dialog column, body, input group, and long folder paths bounded inside the dialog', async () => {
    const { EditProjectDialog } = await import('./edit-project')

    const longPath =
      '/Users/someone/Documents/workspace/very-long-organization-name/some-very-long-repository-name-with-many-nested-folders/packages/web-client'
    const project = makeProject({
      path: longPath,
      name: 'Client Portal',
      customName: true,
      folders: [longPath],
    })

    const html = renderToStaticMarkup(
      createElement(EditProjectDialog, {
        project,
        open: true,
        onOpenChange: vi.fn(),
        onRequestRemove: vi.fn(),
      }),
    )

    const dialogClasses = slotClasses(html, 'dialog-content')
    expect(dialogClasses).toContain('grid')
    expect(dialogClasses).toContain('grid-cols-1')
    expect(dialogClasses).toContain('sm:max-w-120')
    expect(dialogClasses).toContain('max-w-[calc(100%-2rem)]')

    const bodyClasses = slotClasses(html, 'edit-project-body')
    expect(bodyClasses).toContain('min-w-0')
    expect(bodyClasses).toContain('min-h-0')

    const inputGroupClasses = slotClasses(html, 'input-group')
    expect(inputGroupClasses).toContain('w-full')
    expect(inputGroupClasses).toContain('min-w-0')

    const inputClasses = slotClasses(html, 'input-group-control')
    expect(inputClasses).toContain('flex-1')
    expect(inputClasses).toContain('min-w-0')

    const pathMatch = html.match(new RegExp(`<p[^>]*title="${longPath}"[^>]*>`))
    expect(pathMatch).not.toBeNull()
    expect(pathMatch![0]).toContain('truncate')

    const hintMatch = html.match(/<p[^>]*>project\.edit\.nameHint:[^<]*<\/p>/)
    expect(hintMatch).not.toBeNull()
    expect(hintMatch![0]).toContain('wrap-anywhere')
  })
})
