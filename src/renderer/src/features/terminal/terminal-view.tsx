import { useEffect, useRef, useState } from 'react'
import { MessageSquareTextIcon, RotateCwIcon } from 'lucide-react'
import { onAppEvent } from '@renderer/app/events'
import { Button } from '@renderer/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { formatShortcut, isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
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
function useAskLabel(): string {
  const sessionId = useViewStore((s) => (s.main.kind === 'session' ? s.main.sessionId : null))
  const agentId = useSessionsStore((s) => (sessionId ? s.byId[sessionId]?.agentId : undefined))
  return agentId ? `Ask ${agentName(agentId)}` : 'Ask the agent'
}

export function TerminalView({ terminal }: { terminal: TerminalState }) {
  const container = useRef<HTMLDivElement>(null)
  const [instance, setInstance] = useState<Instance | null>(null)
  const [selection, setSelection] = useState<{ x: number; y: number } | null>(null)
  const stopped = terminal.stale
  const ask = useAskLabel()

  useEffect(() => {
    let live = true
    let attached: Instance | null = null
    void getInstance(terminal.id).then((inst) => {
      if (!live || !container.current) return
      attached = inst
      mount(inst, container.current, true)
      inst.term.focus()
      setInstance(inst)
    })
    return () => {
      live = false
      if (attached) unmount(attached)
    }
  }, [terminal.id])

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
        x: Math.min(el.clientWidth - 8, position.end.x * cellWidth),
        y: (row + 1) * cellHeight,
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
    <div className="absolute inset-0 flex flex-col">
      <ContextMenu>
        <ContextMenuTrigger
          render={<div className="relative min-h-0 flex-1 py-1 pr-1 pl-3" data-terminal="" />}
        >
          <div ref={container} className="size-full" />
          {selection && instance && (
            <Button
              variant="outline"
              size="xs"
              className="absolute z-10 animate-in shadow-md fade-in zoom-in-95 animation-duration-(--duration-fast)"
              style={{
                left: `calc(12px + ${selection.x}px)`,
                top: `calc(4px + ${selection.y}px + 2px)`,
              }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => askAboutSelection(instance)}
            >
              <MessageSquareTextIcon data-icon="inline-start" />
              {ask}
              <span className="opacity-60">{formatShortcut('Mod+L')}</span>
            </Button>
          )}
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52">
          <ContextMenuItem
            disabled={!instance?.term.hasSelection()}
            onClick={() => instance && void copySelection(instance)}
          >
            Copy
            <ContextMenuShortcut>{isMac ? '⌘C' : 'Ctrl+Shift+C'}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => instance && void pasteClipboard(instance)}>
            Paste
            <ContextMenuShortcut>{isMac ? '⌘V' : 'Ctrl+Shift+V'}</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem onClick={() => instance?.term.selectAll()}>Select all</ContextMenuItem>
          <ContextMenuItem onClick={() => instance?.term.clear()}>Clear</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            disabled={!instance?.term.hasSelection()}
            onClick={() => instance && askAboutSelection(instance)}
          >
            <MessageSquareTextIcon />
            {ask}
            <ContextMenuShortcut>{formatShortcut('Mod+L')}</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {(exited || stopped) && (
        <div className="flex h-8 shrink-0 animate-in items-center gap-2 border-t border-border-soft px-3 text-xs text-muted-foreground fade-in animation-duration-(--duration-base)">
          <span className={cn(stopped && 'text-destructive')}>
            {stopped ? 'Terminal stopped unexpectedly' : `Exited with code ${terminal.exitCode}`}
          </span>
          <Button
            variant="quiet"
            size="xs"
            onClick={() =>
              stopped ? void replaceStale(terminal.id) : void restartTerminal(terminal.id)
            }
          >
            <RotateCwIcon data-icon="inline-start" />
            Restart
          </Button>
        </div>
      )}
    </div>
  )
}
