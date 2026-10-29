import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DragDropProvider } from '@dnd-kit/react'
import { describe, expect, it, vi } from 'vitest'
import type { TerminalState } from '@renderer/stores/terminals'

vi.mock('./terminal-view', () => ({ TerminalView: () => null }))
vi.stubGlobal('window', { kettu: { platform: 'darwin' } })

const { TerminalTab } = await import('./terminal-panel')

const terminal: TerminalState = {
  id: 't1',
  projectPath: '/project',
  shell: 'zsh',
  title: 'vim',
  busy: false,
  exitCode: null,
  createdAt: 0,
  activity: false,
  stale: false,
  name: null,
}

function render(state: Partial<TerminalState>, selected: boolean): string {
  return renderToStaticMarkup(
    createElement(
      DragDropProvider,
      null,
      createElement(TerminalTab, {
        terminal: { ...terminal, ...state },
        index: 0,
        selected,
        onSelect: () => {},
        onClose: () => {},
      }),
    ),
  )
}

describe('TerminalTab', () => {
  it('shows the title alone, with the close button as its only icon', () => {
    const markup = render({}, true)

    expect(markup).toContain('>vim<')
    expect(markup.match(/<svg/g)).toHaveLength(1)
  })

  it('keeps the close button visible on the active tab', () => {
    const markup = render({}, true)

    expect(markup).toContain('aria-label="Close vim"')
    expect(markup).toContain(' opacity-100')
  })

  it('shows the close button of another tab on hover and focus only', () => {
    const markup = render({}, false)

    expect(markup).toContain('aria-label="Close vim"')
    expect(markup).toContain('opacity-0')
    expect(markup).toContain('group-hover/tab:opacity-100')
    expect(markup).toContain('group-focus-within/tab:opacity-100')
  })

  it('raises the active tab on the surface and leaves the others flat', () => {
    expect(render({}, true)).toContain('bg-surface')
    expect(render({}, true)).toContain('shadow-outline')
    expect(render({}, false)).not.toContain('bg-surface')
    expect(render({}, false)).not.toContain('shadow-outline')
  })

  it('marks a tab whose command is running, in place of its new output', () => {
    const running = render({ busy: true, activity: true }, false)
    expect(running).toContain('aria-label="Running"')
    expect(running).toContain('bg-success')
    expect(running).not.toContain('aria-label="New output"')

    expect(render({ busy: true }, true)).toContain('aria-label="Running"')
    expect(render({ busy: false }, false)).not.toContain('aria-label="Running"')
    expect(render({ busy: true, exitCode: 0 }, false)).not.toContain('aria-label="Running"')
  })

  it('marks output printed while hidden and shows the exit code of an exited shell', () => {
    expect(render({ activity: true }, false)).toContain('aria-label="New output"')
    expect(render({ activity: true }, true)).not.toContain('aria-label="New output"')

    const failed = render({ exitCode: 1 }, false)
    expect(failed).toContain('>1<')
    expect(failed).toContain('text-danger')
    expect(render({ exitCode: 0 }, false)).not.toContain('text-danger')
  })
})
