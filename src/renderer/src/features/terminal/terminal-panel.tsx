import { useState } from 'react'
import { Maximize2Icon, Minimize2Icon, PlusIcon, SquareTerminalIcon, XIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { SidebarToggle } from '@renderer/features/shell/top-bar'
import { isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import {
  createTerminal,
  forgetTerminal,
  killTerminal,
  showTerminal,
  terminalsOf,
  useTerminalsStore,
  type TerminalState,
} from '@renderer/stores/terminals'
import { toggleTerminal, useViewStore } from '@renderer/stores/view'
import { TerminalView } from './terminal-view'

/** The side panel: a card holding the project's terminals, with their tabs in its header. */
export function TerminalPanel({
  projectPath,
  maximized,
}: {
  projectPath: string
  maximized: boolean
}) {
  // Maximized with the sidebar collapsed, the header is the window's top left corner.
  const cornered = useViewStore((s) => s.sidebarCollapsed) && maximized
  const list = useTerminalsStore(useShallow((s) => terminalsOf(s.byId, projectPath)))
  const activeId = useTerminalsStore((s) => s.active[projectPath])
  const error = useTerminalsStore((s) => s.error)
  const [creating, setCreating] = useState(false)
  const [closing, setClosing] = useState<TerminalState | null>(null)
  const active = list.find((t) => t.id === activeId) ?? list.at(-1)

  const newTerminal = async () => {
    setCreating(true)
    await createTerminal(projectPath)
    setCreating(false)
  }

  const close = (t: TerminalState) => {
    if (t.stale) forgetTerminal(t.id)
    else if (t.busy && t.exitCode === null) setClosing(t)
    else void killTerminal(t.id)
  }

  return (
    <div
      className={cn(
        'flex h-full min-h-0 animate-in flex-col bg-sidebar fade-in animation-duration-(--duration-fast)',
        // Maximized, it leaves its slot and covers the whole main area.
        maximized && 'absolute inset-0 z-10',
      )}
      data-terminal-panel=""
    >
      {/* The header is a window drag region, which takes every click on macOS, so its tabs and
          buttons opt out. */}
      <div
        className={cn(
          'app-region-drag flex h-top-bar shrink-0 items-center gap-0.5 pr-2 pl-2',
          cornered && (isMac ? 'pl-[84px]' : 'pl-2'),
          // The panel reaches the window's right edge, where Windows and Linux put the controls.
          !isMac && 'pr-[calc(100vw-env(titlebar-area-x,0px)-env(titlebar-area-width,100vw)+8px)]',
        )}
      >
        {cornered && <SidebarToggle className="mr-1" />}
        <div
          role="tablist"
          aria-label="Terminals"
          className="no-scrollbar app-region-no-drag flex min-w-0 items-center gap-0.5 overflow-x-auto"
        >
          {list.map((t) => (
            <TerminalTab
              key={t.id}
              terminal={t}
              selected={t.id === active?.id}
              onSelect={() => showTerminal(projectPath, t.id)}
              onClose={() => close(t)}
            />
          ))}
          {creating && (
            <span className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Starting…
            </span>
          )}
        </div>
        <PanelButton
          label="New terminal"
          shortcut="Ctrl+Shift+`"
          onClick={() => void newTerminal()}
        >
          <PlusIcon />
        </PanelButton>
        <span className="min-w-2 flex-1" />
        {error && (
          <span className="max-w-[40%] truncate text-xs text-destructive" title={error}>
            {error}
          </span>
        )}
        <PanelButton
          label={maximized ? 'Restore' : 'Maximize'}
          onClick={() => useViewStore.setState({ sidePaneMaximized: !maximized })}
        >
          {maximized ? <Minimize2Icon /> : <Maximize2Icon />}
        </PanelButton>
        <PanelButton
          label="Close"
          shortcut="Ctrl+`"
          onClick={() => toggleTerminal(projectPath, false)}
        >
          <XIcon />
        </PanelButton>
      </div>
      <div className="relative min-h-0 flex-1">
        {active ? (
          <TerminalView key={active.id} terminal={active} />
        ) : (
          !creating && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
              <span>No terminal in this project.</span>
              <Button variant="outline" size="compact" onClick={() => void newTerminal()}>
                <SquareTerminalIcon data-icon="inline-start" />
                New terminal
              </Button>
            </div>
          )
        )}
      </div>
      <AlertDialog open={!!closing} onOpenChange={(open) => !open && setClosing(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End this terminal?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono text-xs text-foreground">{closing?.title}</span> is still
              running. Closing the tab ends it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (closing) void killTerminal(closing.id)
                setClosing(null)
              }}
            >
              End process
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function TerminalTab({
  terminal,
  selected,
  onSelect,
  onClose,
}: {
  terminal: TerminalState
  selected: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const exited = terminal.exitCode !== null
  return (
    <div
      className={cn(
        'group/tab relative flex h-6 max-w-48 min-w-20 items-center rounded-md text-xs transition-[color,background-color,box-shadow] duration-(--duration-fast)',
        // The selected tab is raised like a segmented control's thumb, apart from the hover fill.
        selected
          ? 'bg-segment-thumb text-foreground shadow-segment'
          : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground',
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        onClick={onSelect}
        onAuxClick={(e) => e.button === 1 && onClose()}
        className="flex h-full min-w-0 items-center gap-1.5 rounded-md pr-6 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <SquareTerminalIcon className="size-3.5 shrink-0" />
        <span className="truncate">{terminal.title || terminal.shell}</span>
        {exited && (
          <span className={cn('shrink-0 tabular', terminal.exitCode !== 0 && 'text-destructive')}>
            {terminal.exitCode}
          </span>
        )}
        {terminal.activity && !selected && (
          <span
            role="img"
            aria-label="New output"
            className="size-1.5 shrink-0 rounded-full bg-muted-foreground"
          />
        )}
      </button>
      <button
        type="button"
        aria-label={`Close ${terminal.title || terminal.shell}`}
        onClick={onClose}
        className={cn(
          'absolute right-0.5 flex size-5 items-center justify-center rounded-[5px] text-muted-foreground opacity-0 outline-none transition-opacity duration-(--duration-fast) hover:bg-background/60 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-hover/tab:opacity-100',
          selected && 'opacity-100',
        )}
      >
        <XIcon className="size-3" />
      </button>
    </div>
  )
}
