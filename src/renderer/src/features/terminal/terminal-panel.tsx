import { useCallback, useEffect, useRef, useState } from 'react'
import { DragDropProvider, type DragEndEvent } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import {
  Columns2Icon,
  Maximize2Icon,
  Minimize2Icon,
  PencilIcon,
  PlusIcon,
  SquareTerminalIcon,
  XIcon,
} from 'lucide-react'
import { useDefaultLayout } from 'react-resizable-panels'
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { onAppEvent } from '@renderer/app/events'
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
import { tabSensors } from '@renderer/components/tab-sensors'
import { Button } from '@renderer/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from '@renderer/components/ui/empty'
import { Kbd } from '@renderer/components/ui/kbd'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { SHEET } from '@renderer/features/shell/sheet'
import { CornerControlsSpace } from '@renderer/features/shell/top-bar'
import { hostOfPath } from '@renderer/lib/host-paths'
import { hasBand } from '@renderer/lib/platform'
import { layoutStorage } from '@renderer/lib/storage'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import {
  createTerminal,
  focusTerminalSide,
  forgetTerminal,
  killTerminal,
  moveTerminal,
  renameTerminal,
  showTerminal,
  terminalsOf,
  toggleSplit,
  useTerminalsStore,
  type TerminalSide,
  type TerminalState,
} from '@renderer/stores/terminals'
import { toggleTerminal, useViewStore } from '@renderer/stores/view'
import { OwnerBar, TakeoverNotice } from './terminal-owner'
import { TerminalView } from './terminal-view'

// The two sides of a split panel; alone, the left one fills it.
const LEFT = 'terminal-left'
const RIGHT = 'terminal-right'

/** The side panel: a card holding the project's terminals, with their tabs in its header. */
export function TerminalPanel({
  projectPath,
  maximized,
}: {
  projectPath: string
  maximized: boolean
}) {
  const { t } = useTranslation(['terminal', 'common'])
  // On macOS, maximized with the sidebar collapsed, the header is the window's top left corner.
  const cornered = useViewStore((s) => s.sidebarCollapsed) && maximized && !hasBand
  const list = useTerminalsStore(
    useShallow((s) => terminalsOf(s.byId, projectPath, s.order[projectPath])),
  )
  const activeId = useTerminalsStore((s) => s.active[projectPath])
  const rightId = useTerminalsStore((s) => s.split[projectPath] ?? null)
  const side = useTerminalsStore((s) => s.focusedSide[projectPath] ?? 'left')
  const error = useTerminalsStore((s) => s.error)
  const [creating, setCreating] = useState(false)
  const [closing, setClosing] = useState<TerminalState | null>(null)
  const right = list.find((t) => t.id === rightId) ?? null
  const active =
    list.find((t) => t.id === activeId) ?? list.filter((t) => t.id !== right?.id).at(-1)
  const split = !!active && !!right
  const layout = useDefaultLayout({
    id: 'terminal-split',
    panelIds: split ? [LEFT, RIGHT] : [LEFT],
    storage: layoutStorage,
    onlySaveAfterUserInteractions: true,
  })

  const starting = async (start: () => Promise<unknown>) => {
    setCreating(true)
    await start()
    setCreating(false)
  }
  const newTerminal = () => void starting(() => createTerminal(projectPath))

  const close = useCallback((t: TerminalState) => {
    if (t.stale) forgetTerminal(t.id)
    else if (t.busy && t.exitCode === null) setClosing(t)
    else void killTerminal(t.id)
  }, [])

  // Mod+W closes the tab of the side that has the focus, asking first like its close button.
  const focused = side === 'right' && split ? right : active
  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.kind === 'close-terminal' && focused) close(focused)
      }),
    [close, focused],
  )

  const dragEnded = (event: DragEndEvent) => {
    if (event.canceled) return
    const source = event.operation.source ?? null
    if (!isSortable(source)) return
    const id = String(source.id)
    if (source.index !== source.initialIndex) moveTerminal(projectPath, id, source.index)
    // The sensor reads a press held for 200 ms as a drag and drops the click, so select here.
    else if (event.nativeEvent?.type.startsWith('pointer')) showTerminal(projectPath, id)
  }

  return (
    <div
      className={cn(
        'flex h-full min-h-0 animate-in flex-col fade-in animation-duration-(--duration-fast)',
        SHEET,
        // Maximized, it leaves its slot and covers the whole main area.
        maximized && 'absolute inset-0 z-10',
      )}
      data-terminal-panel=""
    >
      {/* The header is a window drag region, which takes every click on macOS, so its tabs and
          buttons opt out. */}
      <div
        className={cn(
          'app-region-drag flex h-11 shrink-0 items-center gap-1 pr-2 pl-2.5 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]',
          cornered && 'pl-(--corner-inset)',
        )}
      >
        {cornered && <CornerControlsSpace className="mr-1" />}
        <DragDropProvider sensors={tabSensors} onDragEnd={dragEnded}>
          <div
            role="tablist"
            aria-label={t('panel.tabs')}
            aria-multiselectable={split || undefined}
            className="no-scrollbar app-region-no-drag flex min-w-0 items-center gap-1 overflow-x-auto"
          >
            {list.map((terminal, index) => (
              <TerminalTab
                key={terminal.id}
                terminal={terminal}
                index={index}
                selected={terminal.id === active?.id || (split && terminal.id === right.id)}
                onSelect={() => showTerminal(projectPath, terminal.id)}
                onClose={() => close(terminal)}
              />
            ))}
            {creating && (
              <span className="inline-flex h-7 shrink-0 items-center gap-1.75 rounded-lg px-2.5 text-hint text-tertiary">
                <Spinner className="size-2.75" />
                {t('panel.starting')}
              </span>
            )}
          </div>
        </DragDropProvider>
        {/* 26 px, between a tab's 28 and the panel buttons' 24. */}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="quiet"
                size="icon-xs"
                aria-label={t('panel.newTerminal')}
                onClick={newTerminal}
                className="app-region-no-drag size-6.5 shrink-0"
              />
            }
          >
            <PlusIcon className="size-3.5 text-icon group-hover/button:text-primary" />
          </TooltipTrigger>
          <TooltipContent>
            {t('panel.newTerminal')}
            <Kbd>Ctrl+Shift+`</Kbd>
          </TooltipContent>
        </Tooltip>
        <span className="min-w-2 flex-1" />
        {error && (
          <span className="max-w-[40%] truncate text-xs text-danger" title={error}>
            {error}
          </span>
        )}
        <PanelButton
          label={split ? t('panel.unsplit') : t('panel.split')}
          size="icon-sm"
          pressed={split}
          disabled={creating || (!split && !active)}
          // Unsplitting starts nothing.
          onClick={() =>
            void (split ? toggleSplit(projectPath) : starting(() => toggleSplit(projectPath)))
          }
        >
          <Columns2Icon className={HEADER_ICON} />
        </PanelButton>
        <PanelButton
          label={maximized ? t('panel.restore') : t('panel.maximize')}
          size="icon-sm"
          onClick={() => useViewStore.setState({ sidePaneMaximized: !maximized })}
        >
          {maximized ? (
            <Minimize2Icon className={HEADER_ICON} />
          ) : (
            <Maximize2Icon className={HEADER_ICON} />
          )}
        </PanelButton>
        <PanelButton
          label={t('panel.close')}
          size="icon-sm"
          shortcut="Ctrl+`"
          onClick={() => toggleTerminal(projectPath, false)}
        >
          <XIcon className={HEADER_ICON} />
        </PanelButton>
      </div>
      <div className="relative min-h-0 flex-1">
        {active ? (
          <ResizablePanelGroup
            orientation="horizontal"
            defaultLayout={layout.defaultLayout}
            onLayoutChanged={layout.onLayoutChanged}
            className="absolute inset-0"
          >
            <ResizablePanel id={LEFT} minSize="160px" className="min-w-0">
              <TerminalSideView
                projectPath={projectPath}
                terminal={active}
                side={split ? 'left' : null}
                focused={!split || side === 'left'}
              />
            </ResizablePanel>
            {split && (
              <>
                <ResizableHandle className="bg-border-soft" />
                <ResizablePanel id={RIGHT} defaultSize="50%" minSize="160px" className="min-w-0">
                  <TerminalSideView
                    projectPath={projectPath}
                    terminal={right}
                    side="right"
                    focused={side === 'right'}
                  />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        ) : (
          !creating && (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SquareTerminalIcon />
                </EmptyMedia>
                <EmptyDescription>{t('panel.empty')}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" size="compact" onClick={newTerminal}>
                  <PlusIcon data-icon="inline-start" />
                  {t('panel.newTerminal')}
                </Button>
              </EmptyContent>
            </Empty>
          )
        )}
      </div>
      <AlertDialog open={!!closing} onOpenChange={(open) => !open && setClosing(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('closeDialog.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              <Trans
                t={t}
                i18nKey="closeDialog.body"
                components={{
                  title: <span className="font-mono text-xs text-primary">{closing?.title}</span>,
                }}
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (closing) void killTerminal(closing.id)
                setClosing(null)
              }}
            >
              {t('closeDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

const HEADER_ICON =
  'size-3.75 text-icon group-hover/button:text-primary group-aria-pressed/button:text-primary'

/**
 * One terminal shown in the panel, under the bar of the agent that started it and over its notice
 * that typing takes it over. While split, a press or focus in it makes its side the focused one.
 */
function TerminalSideView({
  projectPath,
  terminal,
  side,
  focused,
}: {
  projectPath: string
  terminal: TerminalState
  side: TerminalSide | null
  focused: boolean
}) {
  const focus = side ? () => focusTerminalSide(projectPath, side) : undefined
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      {terminal.owner && <OwnerBar terminal={terminal} owner={terminal.owner} />}
      <div className="relative min-h-0 flex-1">
        <TerminalView key={terminal.id} terminal={terminal} focused={focused} />
      </div>
      {terminal.owner && <TakeoverNotice terminal={terminal} owner={terminal.owner} />}
    </div>
  )
}

export function TerminalTab({
  terminal,
  index,
  selected,
  onSelect,
  onClose,
}: {
  terminal: TerminalState
  index: number
  selected: boolean
  onSelect: () => void
  onClose: () => void
}) {
  const { t } = useTranslation(['terminal', 'common'])
  const [editing, setEditing] = useState(false)
  const tab = useRef<HTMLButtonElement | null>(null)
  const refocus = useRef(false)
  const renameAfterMenu = useRef(false)
  const { ref, handleRef, isDragging } = useSortable({ id: terminal.id, index, disabled: editing })
  // The tab button is the drag handle, so a press on the close button never starts a drag.
  const setTab = useCallback(
    (element: HTMLButtonElement | null) => {
      tab.current = element
      handleRef(element)
    },
    [handleRef],
  )
  const automatic = terminal.title || terminal.shell
  const name = terminal.name ?? automatic
  const exited = terminal.exitCode !== null
  const running = terminal.busy && !exited
  const owner = terminal.owner

  // A full strip scrolls; a tab selected out of sight, such as one an agent starts, comes into view.
  useEffect(() => {
    if (selected) tab.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [selected])

  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    tab.current?.focus()
  }, [editing])

  // Null cancels. Enter and Esc hand the focus back to the tab; a blur leaves it where it went.
  const finishRename = (value: string | null, restoreFocus: boolean) => {
    if (value !== null) renameTerminal(terminal.id, value)
    refocus.current = restoreFocus
    setEditing(false)
  }

  return (
    <ContextMenu
      disabled={editing}
      // The input waits for the menu to close: an open context menu holds the focus.
      onOpenChangeComplete={(open) => {
        if (open || !renameAfterMenu.current) return
        renameAfterMenu.current = false
        setEditing(true)
      }}
    >
      <ContextMenuTrigger
        ref={ref}
        className={cn(
          'group/tab relative flex h-7 items-center rounded-lg text-hint transition-[color,background-color,box-shadow] duration-(--duration-fast)',
          // An agent's tab is the widest, so it would shrink the most: it keeps room for its name.
          owner ? 'max-w-64 min-w-28' : 'max-w-48 min-w-14',
          editing
            ? 'bg-surface text-primary ring-1 ring-border-strong ring-inset'
            : selected || isDragging
              ? 'bg-raised text-primary shadow-segment'
              : 'text-tertiary hover:bg-hover hover:text-secondary',
        )}
      >
        {/* Stays mounted while renaming, hidden under the input, so the tab keeps its width. */}
        <button
          ref={setTab}
          type="button"
          role="tab"
          aria-selected={selected}
          // A renamed tab keeps its process title in reach.
          title={terminal.name ? automatic : undefined}
          onClick={onSelect}
          onDoubleClick={() => setEditing(true)}
          onAuxClick={(e) => e.button === 1 && onClose()}
          className={cn(
            'flex h-full min-w-0 items-center rounded-lg pl-2.5 outline-none focus-ring',
            // The selected tab makes room for its close button.
            selected ? 'pr-7.75' : 'pr-2.5',
            editing && 'invisible',
          )}
        >
          {/* Another tab shows its close button on hover, over its end, which fades out under it. */}
          <span
            className={cn(
              'flex min-w-0 flex-1 items-center gap-1.75',
              !selected &&
                'group-focus-within/tab:mask-r-from-[calc(100%-26px)] group-focus-within/tab:mask-r-to-[calc(100%-14px)] group-hover/tab:mask-r-from-[calc(100%-26px)] group-hover/tab:mask-r-to-[calc(100%-14px)]',
            )}
          >
            {/* An agent's running command turns in the icon's place, without the running dot. */}
            {owner && running ? (
              <Spinner aria-label={t('tab.running')} className="size-2.75 shrink-0" />
            ) : (
              <SquareTerminalIcon aria-hidden className="size-3.25 shrink-0" strokeWidth={1.4} />
            )}
            {/* One line, so the agent's name after it is cut before the terminal's. */}
            <span className="truncate">
              {name}
              {owner && (
                <span className="ml-1.75 text-tertiary">
                  {t('tab.owner', {
                    agent: agentName(owner.agentId, hostOfPath(terminal.projectPath)),
                  })}
                </span>
              )}
            </span>
            {exited && (
              <span className={cn('shrink-0 tabular', terminal.exitCode !== 0 && 'text-danger')}>
                {terminal.exitCode}
              </span>
            )}
            {running && !owner && (
              <span
                role="img"
                aria-label={t('tab.running')}
                className="size-1.5 shrink-0 rounded-full bg-success"
              />
            )}
            {!running && terminal.activity && !selected && (
              <span
                role="img"
                aria-label={t('tab.newOutput')}
                className="size-1.5 shrink-0 rounded-full bg-current text-tertiary"
              />
            )}
          </span>
        </button>
        {editing ? (
          <TabNameInput initial={name} label={t('tab.nameLabel')} onFinish={finishRename} />
        ) : (
          <button
            type="button"
            aria-label={t('tab.close', { name })}
            onClick={onClose}
            className={cn(
              'absolute right-1.5 flex size-4.5 items-center justify-center rounded-md text-tertiary opacity-0 outline-none transition-opacity duration-(--duration-fast) hover:bg-pressed-hover hover:text-primary focus-visible:opacity-100 focus-ring group-focus-within/tab:opacity-100 group-hover/tab:opacity-100',
              selected && 'opacity-100',
            )}
          >
            <XIcon className="size-2.75" />
          </button>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() => {
            renameAfterMenu.current = true
          }}
        >
          <PencilIcon />
          {t('tab.rename')}
        </ContextMenuItem>
        <ContextMenuItem onClick={onClose}>
          <XIcon />
          {t('common:actions.close')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** The tab's label as a text field, laid over the tab. Enter or a blur accepts; Esc cancels. */
function TabNameInput({
  initial,
  label,
  onFinish,
}: {
  initial: string
  label: string
  onFinish: (value: string | null, restoreFocus: boolean) => void
}) {
  // Enter unmounts the input, which blurs it in some engines; only the first outcome counts.
  const finished = useRef(false)
  const finish = (value: string | null, restoreFocus: boolean) => {
    if (finished.current) return
    finished.current = true
    onFinish(value, restoreFocus)
  }
  return (
    // Its text starts where the label does, past the icon.
    <div className="absolute inset-0 flex items-center pr-2.5 pl-7.5">
      <input
        autoFocus
        aria-label={label}
        defaultValue={initial}
        autoComplete="off"
        spellCheck={false}
        className="h-full min-w-0 flex-1 bg-transparent outline-none"
        onFocus={(e) => e.currentTarget.select()}
        onBlur={(e) => finish(e.currentTarget.value, false)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return
          if (e.key === 'Enter') {
            e.preventDefault()
            finish(e.currentTarget.value, true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            finish(null, true)
          }
        }}
      />
    </div>
  )
}
