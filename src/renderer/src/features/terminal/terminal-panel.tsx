import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog'
import { DragDropProvider, type DragEndEvent } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import {
  Cancel01Icon,
  ComputerTerminal01Icon,
  Layout2ColumnIcon,
  PencilEdit02Icon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons'
import { useDefaultLayout } from 'react-resizable-panels'
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { onAppEvent } from '@renderer/app/events'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { tabSensors } from '@renderer/components/tab-sensors'
import { AlertDialog } from '@renderer/components/ui/alert-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@renderer/components/ui/resizable'
import {
  PaneEmpty,
  PaneHead,
  PaneIcon,
  PaneSheet,
  PaneSpinner,
  PaneTabClose,
  PanelButton,
} from '@renderer/features/shell/panel-button'
import { hostOfPath } from '@renderer/lib/host-paths'
import { formatShortcut } from '@renderer/lib/platform'
import { layoutStorage } from '@renderer/lib/storage'
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
import { OwnerBar, TakeoverNotice } from './terminal-owner'
import { TerminalView } from './terminal-view'

// The two sides of a split panel; alone, the left one fills it.
const LEFT = 'terminal-left'
const RIGHT = 'terminal-right'
const SLOW_START_MS = 400

/**
 * The side panel's Terminal pane: a session's terminals, or New session's, with their tabs in its
 * head. They open in `projectPath`, the session's folder.
 */
export function TerminalPanel({
  projectPath,
  panel,
  maximized,
}: {
  projectPath: string
  panel: string
  maximized: boolean
}) {
  const { t } = useTranslation(['terminal', 'common'])
  const sheet = useRef<HTMLDivElement>(null)
  const list = useTerminalsStore(useShallow((s) => terminalsOf(s.byId, panel, s.order[panel])))
  const activeId = useTerminalsStore((s) => s.active[panel])
  const rightId = useTerminalsStore((s) => s.split[panel] ?? null)
  const side = useTerminalsStore((s) => s.focusedSide[panel] ?? 'left')
  const error = useTerminalsStore((s) => s.error)
  const [creating, setCreating] = useState(false)
  // Only a start that takes a while shows its Starting tab, so a quick one shows its tab at once.
  const [slowStart, setSlowStart] = useState(false)
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
    const slow = window.setTimeout(() => setSlowStart(true), SLOW_START_MS)
    await start()
    window.clearTimeout(slow)
    setCreating(false)
    setSlowStart(false)
  }
  const newTerminal = () => void starting(() => createTerminal(projectPath, panel))

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
    if (source.index !== source.initialIndex) moveTerminal(panel, id, source.index)
    // The sensor reads a press held for 200 ms as a drag and drops the click, so select here.
    else if (event.nativeEvent?.type.startsWith('pointer')) showTerminal(panel, id)
  }

  return (
    <PaneSheet ref={sheet} pane="terminal" maximized={maximized} data-terminal-panel="">
      <PaneHead
        panel={panel}
        pane="terminal"
        maximized={maximized}
        tools={
          <>
            {error && (
              <span className="kp-head__error" title={error}>
                {error}
              </span>
            )}
            <PanelButton
              label={split ? t('panel.unsplit') : t('panel.split')}
              pressed={split}
              disabled={creating || (!split && !active)}
              // Unsplitting starts nothing.
              onClick={() =>
                void (split
                  ? toggleSplit(projectPath, panel)
                  : starting(() => toggleSplit(projectPath, panel)))
              }
            >
              <PaneIcon icon={Layout2ColumnIcon} />
            </PanelButton>
          </>
        }
      >
        <DragDropProvider sensors={tabSensors} onDragEnd={dragEnded}>
          <div
            role="tablist"
            aria-label={t('panel.tabs')}
            aria-multiselectable={split || undefined}
            className="kp-head__tabs"
          >
            {list.map((terminal, index) => (
              <TerminalTab
                key={terminal.id}
                terminal={terminal}
                index={index}
                selected={terminal.id === active?.id || (split && terminal.id === right.id)}
                onSelect={() => showTerminal(panel, terminal.id)}
                onClose={() => close(terminal)}
              />
            ))}
            {slowStart && (
              <span className="kp-tab">
                <span className="kp-tab__btn">
                  <PaneSpinner className="kp-tab__icon" />
                  <span className="kp-tab__name">{t('panel.starting')}</span>
                </span>
              </span>
            )}
          </div>
        </DragDropProvider>
        <PanelButton
          label={t('panel.newTerminal')}
          shortcut={formatShortcut('Ctrl+Shift+`')}
          onClick={newTerminal}
        >
          <PaneIcon icon={PlusSignIcon} />
        </PanelButton>
      </PaneHead>
      <div className="kp-body">
        {active ? (
          <ResizablePanelGroup
            orientation="horizontal"
            defaultLayout={layout.defaultLayout}
            onLayoutChanged={layout.onLayoutChanged}
            className="min-h-0 flex-1"
          >
            <ResizablePanel id={LEFT} minSize="160px" className="min-w-0">
              <TerminalSideView
                panel={panel}
                terminal={active}
                side={split ? 'left' : null}
                focused={!split || side === 'left'}
              />
            </ResizablePanel>
            {split && (
              <>
                <ResizableHandle className="kp-split-handle" />
                <ResizablePanel id={RIGHT} defaultSize="50%" minSize="160px" className="min-w-0">
                  <TerminalSideView
                    panel={panel}
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
            <PaneEmpty
              icon={<PaneIcon icon={ComputerTerminal01Icon} size={20} />}
              title={t('panel.empty')}
            >
              <button type="button" className="kp-btn" onClick={newTerminal}>
                <PaneIcon icon={PlusSignIcon} size={13} />
                {t('panel.newTerminal')}
              </button>
            </PaneEmpty>
          )
        )}
      </div>
      <EndTerminal
        container={sheet}
        closing={closing}
        onCancel={() => setClosing(null)}
        onConfirm={() => {
          if (closing) void killTerminal(closing.id)
          setClosing(null)
        }}
      />
    </PaneSheet>
  )
}

/** "End this terminal?", asked over the pane before a running terminal's tab closes. */
function EndTerminal({
  container,
  closing,
  onCancel,
  onConfirm,
}: {
  container: RefObject<HTMLDivElement | null>
  closing: TerminalState | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation(['terminal', 'common'])
  return (
    <AlertDialog open={!!closing} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogPrimitive.Portal container={container}>
        <AlertDialogPrimitive.Backdrop className="kp-confirm" />
        <AlertDialogPrimitive.Popup className="kp-confirm__card" data-overlay-layer="">
          <AlertDialogPrimitive.Title>{t('closeDialog.title')}</AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description>
            <Trans
              t={t}
              i18nKey="closeDialog.body"
              components={{ title: <span className="kp-mono text-primary">{closing?.title}</span> }}
            />
          </AlertDialogPrimitive.Description>
          <span className="kp-confirm__acts">
            <AlertDialogPrimitive.Close className="kp-btn">
              {t('common:actions.cancel')}
            </AlertDialogPrimitive.Close>
            <button type="button" className="kp-btn kp-btn--danger" onClick={onConfirm}>
              {t('closeDialog.confirm')}
            </button>
          </span>
        </AlertDialogPrimitive.Popup>
      </AlertDialogPrimitive.Portal>
    </AlertDialog>
  )
}

/**
 * One terminal shown in the pane, under the strip of the agent that started it and over its notice
 * that typing takes it over. While split, a press or focus in it makes its side the focused one.
 */
function TerminalSideView({
  panel,
  terminal,
  side,
  focused,
}: {
  panel: string
  terminal: TerminalState
  side: TerminalSide | null
  focused: boolean
}) {
  const focus = side ? () => focusTerminalSide(panel, side) : undefined
  return (
    <div
      className="kp-tview"
      data-split={side ? '' : undefined}
      data-focused={focused || undefined}
      onPointerDownCapture={focus}
      onFocusCapture={focus}
    >
      {terminal.owner && <OwnerBar terminal={terminal} owner={terminal.owner} />}
      <div className="kp-tbox">
        <TerminalView key={terminal.id} terminal={terminal} focused={focused} />
        {terminal.owner && <TakeoverNotice terminal={terminal} owner={terminal.owner} />}
      </div>
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
  const ownerName = owner ? agentName(owner.agentId, hostOfPath(terminal.projectPath)) : null
  // New output waits on a tab out of view; a running one shows that it runs.
  const dot = terminal.activity && !selected ? 'output' : running ? 'running' : null

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
        className="kp-tab"
        data-selected={selected || undefined}
        data-dragging={isDragging || undefined}
        data-editing={editing || undefined}
        data-owned={owner ? '' : undefined}
      >
        {/* Stays mounted while renaming, hidden under the input, so the tab keeps its width. */}
        <button
          ref={setTab}
          type="button"
          role="tab"
          aria-selected={selected}
          // Who started it, and a renamed tab's process title, stay in reach.
          title={[terminal.name ? automatic : name, ownerName].filter(Boolean).join(' · ')}
          onClick={onSelect}
          onDoubleClick={() => setEditing(true)}
          onAuxClick={(e) => e.button === 1 && onClose()}
          className="kp-tab__btn"
          style={editing ? { visibility: 'hidden' } : undefined}
        >
          {owner && (
            <AgentMark
              agent={owner.agentId}
              size={13}
              className="kp-tab__icon kp-tab__icon--mark"
            />
          )}
          <span className="kp-tab__name">{name}</span>
          {exited && (
            <span className="kp-tab__code" data-failed={terminal.exitCode !== 0 || undefined}>
              {terminal.exitCode}
            </span>
          )}
          {dot && (
            <span
              role="img"
              aria-label={dot === 'output' ? t('tab.newOutput') : t('tab.running')}
              className="kp-tab__dot"
              data-dot={dot}
            />
          )}
        </button>
        {editing ? (
          <TabNameInput initial={name} label={t('tab.nameLabel')} onFinish={finishRename} />
        ) : (
          <PaneTabClose label={t('tab.close', { name })} onClick={onClose} />
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() => {
            renameAfterMenu.current = true
          }}
        >
          <PaneIcon icon={PencilEdit02Icon} size={16} />
          {t('tab.rename')}
        </ContextMenuItem>
        <ContextMenuItem onClick={onClose}>
          <PaneIcon icon={Cancel01Icon} size={16} />
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
    <div className="kp-tab__rename">
      <input
        autoFocus
        aria-label={label}
        defaultValue={initial}
        autoComplete="off"
        spellCheck={false}
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
