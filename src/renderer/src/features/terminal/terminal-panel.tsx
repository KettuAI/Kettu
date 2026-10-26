import { useCallback, useEffect, useRef, useState } from 'react'
import { DragDropProvider, KeyboardSensor, PointerSensor, type DragEndEvent } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import {
  Maximize2Icon,
  Minimize2Icon,
  PencilIcon,
  PlusIcon,
  SquareTerminalIcon,
  XIcon,
} from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
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
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { Spinner } from '@renderer/components/ui/spinner'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { SHEET } from '@renderer/features/shell/sheet'
import { SidebarToggle } from '@renderer/features/shell/top-bar'
import { isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import {
  createTerminal,
  forgetTerminal,
  killTerminal,
  moveTerminal,
  renameTerminal,
  showTerminal,
  terminalsOf,
  useTerminalsStore,
  type TerminalState,
} from '@renderer/stores/terminals'
import { toggleTerminal, useViewStore } from '@renderer/stores/view'
import { TerminalView } from './terminal-view'

const pointerDefaults = PointerSensor.defaults.activationConstraints

// Space picks a tab up; Enter stays the tab's own key for selecting it.
const sensors = [
  PointerSensor.configure({
    // A mouse press on a handle starts a drag at once by default, which swallows the tab's clicks;
    // the handle takes the constraints of a press anywhere else: 5 px of travel or a 200 ms hold.
    activationConstraints: (event, source) =>
      typeof pointerDefaults === 'function'
        ? pointerDefaults(event, Object.create(source, { handle: { value: undefined } }))
        : pointerDefaults,
  }),
  KeyboardSensor.configure({
    keyboardCodes: { ...KeyboardSensor.defaults.keyboardCodes, start: ['Space'] },
  }),
]

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
  const cornered = useViewStore((s) => s.sidebarCollapsed) && maximized && isMac
  const list = useTerminalsStore(
    useShallow((s) => terminalsOf(s.byId, projectPath, s.order[projectPath])),
  )
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
          'app-region-drag flex h-top-bar shrink-0 items-center gap-0.5 pr-2 pl-2 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]',
          cornered && 'pl-[calc(32px-var(--sheet-gap)+var(--traffic-lights))]',
        )}
      >
        {cornered && <SidebarToggle className="mr-1" />}
        <DragDropProvider sensors={sensors} onDragEnd={dragEnded}>
          <div
            role="tablist"
            aria-label={t('panel.tabs')}
            className="no-scrollbar app-region-no-drag flex min-w-0 items-center gap-0.5 overflow-x-auto"
          >
            {list.map((terminal, index) => (
              <TerminalTab
                key={terminal.id}
                terminal={terminal}
                index={index}
                selected={terminal.id === active?.id}
                onSelect={() => showTerminal(projectPath, terminal.id)}
                onClose={() => close(terminal)}
              />
            ))}
            {creating && (
              <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-ui text-tertiary">
                <Spinner className="size-3" />
                {t('panel.starting')}
              </span>
            )}
          </div>
        </DragDropProvider>
        <PanelButton
          label={t('panel.newTerminal')}
          shortcut="Ctrl+Shift+`"
          size="icon-sm"
          onClick={() => void newTerminal()}
        >
          <PlusIcon />
        </PanelButton>
        <span className="min-w-2 flex-1" />
        {error && (
          <span className="max-w-[40%] truncate text-xs text-danger" title={error}>
            {error}
          </span>
        )}
        <PanelButton
          label={maximized ? t('panel.restore') : t('panel.maximize')}
          size="icon-sm"
          onClick={() => useViewStore.setState({ sidePaneMaximized: !maximized })}
        >
          {maximized ? <Minimize2Icon /> : <Maximize2Icon />}
        </PanelButton>
        <PanelButton
          label={t('common:actions.close')}
          shortcut="Ctrl+`"
          size="icon-sm"
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
            <div className="flex h-full flex-col items-center justify-center gap-2 text-ui text-secondary">
              <span>{t('panel.empty')}</span>
              <Button variant="outline" size="compact" onClick={() => void newTerminal()}>
                <SquareTerminalIcon data-icon="inline-start" />
                {t('panel.newTerminal')}
              </Button>
            </div>
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
          'group/tab relative flex h-7 max-w-48 min-w-20 items-center rounded-lg text-ui transition-[color,background-color] duration-(--duration-fast)',
          editing
            ? 'bg-background text-primary ring-1 ring-border-strong ring-inset'
            : selected || isDragging
              ? 'bg-selected text-primary'
              : 'text-secondary hover:bg-hover hover:text-primary',
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
            'flex h-full min-w-0 items-center gap-1.5 rounded-lg pr-6 pl-2.5 outline-none focus-ring',
            editing && 'invisible',
          )}
        >
          <span className="truncate">{name}</span>
          {exited && (
            <span className={cn('shrink-0 tabular', terminal.exitCode !== 0 && 'text-danger')}>
              {terminal.exitCode}
            </span>
          )}
          {terminal.activity && !selected && (
            <span
              role="img"
              aria-label={t('tab.newOutput')}
              className="size-1.5 shrink-0 rounded-full bg-current text-tertiary"
            />
          )}
        </button>
        {editing ? (
          <TabNameInput initial={name} label={t('tab.nameLabel')} onFinish={finishRename} />
        ) : (
          <button
            type="button"
            aria-label={t('tab.close', { name })}
            onClick={onClose}
            className={cn(
              'absolute right-1.5 flex size-4 items-center justify-center rounded-md text-icon opacity-0 outline-none transition-opacity duration-(--duration-fast) hover:bg-pressed-hover hover:text-primary focus-visible:opacity-100 focus-ring group-focus-within/tab:opacity-100 group-hover/tab:opacity-100',
              selected && 'opacity-100',
            )}
          >
            <XIcon className="size-3" />
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
    <div className="absolute inset-0 flex items-center px-2.5">
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
