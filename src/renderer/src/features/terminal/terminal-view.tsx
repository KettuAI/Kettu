import { useEffect, useRef, useState } from 'react'
import {
  BubbleChatIcon,
  Copy01Icon,
  Eraser01Icon,
  ReloadIcon,
  TextSelectionIcon,
  ClipboardIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import { onAppEvent } from '@renderer/app/events'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { formatShortcut, isMac } from '@renderer/lib/platform'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { replaceStale, restartTerminal, type TerminalState } from '@renderer/stores/terminals'
import { useViewStore } from '@renderer/stores/view'
import {
  askAboutSelection,
  copySelection,
  fitNow,
  getInstance,
  mount,
  pasteClipboard,
  unmount,
  type Instance,
} from './xterm-registry'

/** The agent of the session on screen, for "Ask Claude Code". */
function useAsk(): { label: string; agentId: AgentId | null; hostId: string | null } {
  const { t } = useTranslation('terminal')
  const sessionId = useViewStore((s) => (s.main.kind === 'session' ? s.main.sessionId : null))
  const summary = useSessionsStore((s) => (sessionId ? s.byId[sessionId] : undefined))
  if (!summary) return { label: t('view.askGeneric'), agentId: null, hostId: null }
  const hostId = hostOfSession(summary)
  return {
    label: t('view.askAgent', { agent: agentName(summary.agentId, hostId) }),
    agentId: summary.agentId,
    hostId,
  }
}

/**
 * A terminal's screen. Two show at once while the panel is split; only the focused one takes the
 * keyboard when it shows.
 */
export function TerminalView({
  terminal,
  focused = true,
}: {
  terminal: TerminalState
  focused?: boolean
}) {
  const { t } = useTranslation(['terminal', 'common'])
  const container = useRef<HTMLDivElement>(null)
  const [instance, setInstance] = useState<Instance | null>(null)
  const [selection, setSelection] = useState<{ x: number; y: number } | null>(null)
  const stopped = terminal.stale
  const ask = useAsk()

  useEffect(() => {
    let live = true
    let attached: Instance | null = null
    void getInstance(terminal.id).then((inst) => {
      if (!live || !container.current) return
      attached = inst
      mount(inst, container.current, true)
      setInstance(inst)
    })
    return () => {
      live = false
      if (attached) unmount(attached)
    }
  }, [terminal.id])

  useEffect(() => {
    if (instance && focused) instance.term.focus()
  }, [instance, focused])

  // Fit while the panel is resized, at most every 50 ms.
  useEffect(() => {
    const el = container.current
    if (!el || !instance) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(() => fitNow(instance), 50)
    })
    observer.observe(el)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
    }
  }, [instance])

  // The Ask button sits at the end of the selection.
  useEffect(() => {
    if (!instance) return
    const { term } = instance
    const update = () => {
      const position = term.getSelectionPosition()
      const el = container.current
      if (!position || !term.hasSelection() || !el) {
        setSelection(null)
        return
      }
      const cellWidth = el.clientWidth / term.cols
      const cellHeight = el.clientHeight / term.rows
      const row = position.end.y - term.buffer.active.viewportY
      if (row < 0 || row >= term.rows) {
        setSelection(null)
        return
      }
      setSelection({
        x: el.offsetLeft + Math.min(el.clientWidth - 140, position.end.x * cellWidth),
        y: el.offsetTop + (row + 1) * cellHeight,
      })
    }
    const a = term.onSelectionChange(update)
    const b = term.onScroll(update)
    return () => {
      a.dispose()
      b.dispose()
    }
  }, [instance])

  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.kind === 'ask-selection' && instance) askAboutSelection(instance)
      }),
    [instance],
  )

  const exited = terminal.exitCode !== null

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger render={<div className="kp-tscreen" data-terminal="" />}>
          <div ref={container} className="kp-tscreen__xterm" />
          {selection && instance && (
            <button
              type="button"
              className="kp-ask"
              style={{ left: Math.max(0, selection.x), top: selection.y + 6 }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => askAboutSelection(instance)}
            >
              {ask.agentId && <AgentMark agent={ask.agentId} size={13} hostId={ask.hostId} />}
              {ask.label}
              <kbd>{formatShortcut('Mod+L')}</kbd>
            </button>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            disabled={!instance?.term.hasSelection()}
            onClick={() => instance && void copySelection(instance)}
          >
            <PaneIcon icon={Copy01Icon} size={16} />
            {t('common:actions.copy')}
            <ContextMenuShortcut>{isMac ? '⌘C' : 'Ctrl+Shift+C'}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => instance && void pasteClipboard(instance)}>
            <PaneIcon icon={ClipboardIcon} size={16} />
            {t('view.paste')}
            <ContextMenuShortcut>{isMac ? '⌘V' : 'Ctrl+Shift+V'}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => instance?.term.selectAll()}>
            <PaneIcon icon={TextSelectionIcon} size={16} />
            {t('view.selectAll')}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => instance?.term.clear()}>
            <PaneIcon icon={Eraser01Icon} size={16} />
            {t('view.clear')}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!instance?.term.hasSelection()}
            onClick={() => instance && askAboutSelection(instance)}
          >
            <PaneIcon icon={BubbleChatIcon} size={16} />
            {ask.label}
            <ContextMenuShortcut>{formatShortcut('Mod+L')}</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {(exited || stopped) && (
        <div className="kp-texit" data-failed={stopped || undefined}>
          <span className="min-w-0 flex-1 truncate">
            {stopped ? t('view.stopped') : t('view.exited', { code: terminal.exitCode })}
          </span>
          <button
            type="button"
            className="kp-btn kp-btn--sm"
            onClick={() =>
              stopped ? void replaceStale(terminal.id) : void restartTerminal(terminal.id)
            }
          >
            <PaneIcon icon={ReloadIcon} size={13} />
            {t('view.restart')}
          </button>
        </div>
      )}
    </>
  )
}
