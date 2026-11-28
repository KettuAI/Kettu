import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react'
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog'
import { DragDropProvider, type DragEndEvent } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  ComputerTerminal01Icon,
  Layout2ColumnIcon,
  LayoutRightIcon,
  MessageAdd01Icon,
  PencilEdit02Icon,
  PlusSignIcon,
  Tick02Icon,
  UnavailableIcon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SurfaceControl } from '@shared/control'
import type { AgentId } from '@shared/thread'
import { emitAppEvent, onAppEvent } from '@renderer/app/events'
import { tabSensors } from '@renderer/components/tab-sensors'
import { AlertDialog } from '@renderer/components/ui/alert-dialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { LinkSessionContext } from '@renderer/features/session/open-link'
import { NEW_SESSION_DRAFT } from '@renderer/features/session/composer/drafts'
import { surfaceMention } from '@renderer/features/session/composer/chips'
import { moveTerminalPlacement } from '@renderer/features/shell/open-surfaces'
import { PaneIcon, PaneSpinner, PanelButton } from '@renderer/features/shell/panel-button'
import { SHEET } from '@renderer/features/shell/sheet'
import { host } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { formatShortcut } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import {
  bottomHeightBounds,
  clampBottomTerminalHeight,
  dragBottomTerminalHeight,
  resetBottomTerminalHeight,
  setBottomTerminalHeight,
  stepBottomTerminalHeight,
  useBottomTerminalHeight,
} from '@renderer/stores/terminal-dock'
import {
  createTerminal,
  forgetTerminal,
  isRunningTerminal,
  killTerminal,
  moveTerminal,
  renameTerminal,
  showTerminal,
  terminalsOf,
  toggleSplit,
  useTerminalsStore,
  type TerminalState,
} from '@renderer/stores/terminals'
import { closeBottomTerminal, panelSession } from '@renderer/stores/view'
import { requestCloseAllTerminals } from './close-all-terminals-model'
import { TerminalPanel } from './terminal-panel'

const MIN_TAB_PX = 72
const SLOW_START_MS = 400

type Tone = 'fox' | 'live'

interface TerminalTabItem {
  id: string
  name: string
  title: string
  selected: boolean
  control: Exclude<SurfaceControl['kind'], 'idle'> | null
  dot: { tone: Tone; label: string } | null
  code: number | null
  terminal: TerminalState
  agent: string
  shared: boolean
}

const CONTROL_NOTE = {
  agent: 'tabs.agentUsing',
  you: 'tabs.agentWaiting',
  asks: 'tabs.agentAsks',
} as const

function controlOf(control: SurfaceControl | undefined): TerminalTabItem['control'] {
  return control && control.kind !== 'idle' ? control.kind : null
}

/**
 * The bottom-docked terminal below the session main area: a vertical resize handle, a compact tab
 * bar with Move to side and Hide controls, and the live `TerminalPanel`.
 */
export function TerminalBottomDock({
  panel,
  projectPath,
  containerRef,
}: {
  panel: string
  projectPath: string
  containerRef: RefObject<HTMLDivElement | null>
}) {
  const { t } = useTranslation('terminal')
  const preferredHeight = useBottomTerminalHeight((s) => s.height)
  const [availableHeight, setAvailableHeight] = useState(0)
  const [dragging, setDragging] = useState(false)
  const dockRef = useRef<HTMLDivElement>(null)
  const resizerRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => {
      const gap = resizerRef.current?.offsetHeight ?? 0
      setAvailableHeight(Math.max(0, container.clientHeight - gap))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef])

  const bounds = bottomHeightBounds(availableHeight)
  const height =
    availableHeight > 0
      ? clampBottomTerminalHeight(preferredHeight, availableHeight)
      : preferredHeight

  const onResizePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || availableHeight <= 0) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const startY = event.clientY
    const startHeight = height
    const room = availableHeight
    setDragging(true)

    const onMove = (moveEvent: PointerEvent) => {
      const next = dragBottomTerminalHeight(startHeight, room, moveEvent.clientY - startY)
      setBottomTerminalHeight(next)
    }
    const onEnd = () => {
      setDragging(false)
      handle.removeEventListener('pointermove', onMove)
      handle.removeEventListener('pointerup', onEnd)
      handle.removeEventListener('pointercancel', onEnd)
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId)
      }
    }
    handle.addEventListener('pointermove', onMove)
    handle.addEventListener('pointerup', onEnd)
    handle.addEventListener('pointercancel', onEnd)
  }

  const onResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (availableHeight <= 0) return
    const next = stepBottomTerminalHeight(height, availableHeight, event.key, event.shiftKey)
    if (next === undefined) return
    event.preventDefault()
    if (next === null) resetBottomTerminalHeight()
    else setBottomTerminalHeight(next)
  }

  return (
    <>
      <div
        ref={resizerRef}
        role="separator"
        tabIndex={0}
        aria-orientation="horizontal"
        aria-label={t('panel.resize')}
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={height}
        title={t('panel.resizeHint')}
        data-separator={dragging ? 'active' : undefined}
        className="kp-dock-resizer app-region-no-drag"
        onPointerDown={onResizePointerDown}
        onDoubleClick={resetBottomTerminalHeight}
        onKeyDown={onResizeKeyDown}
      >
        <div className="kp-dock-resizer__grip" />
      </div>
      <div
        ref={dockRef}
        data-bottom-terminal={panel}
        className={cn('kp-pane kp-bottom-dock', SHEET)}
        style={{ height }}
      >
        <LinkSessionContext value={panelSession(panel)}>
          <TerminalBottomHeader panel={panel} projectPath={projectPath} dockRef={dockRef} />
          <TerminalPanel projectPath={projectPath} panel={panel} />
        </LinkSessionContext>
      </div>
    </>
  )
}

function useTerminalTabItems(panel: string, projectPath: string): TerminalTabItem[] {
  const { t } = useTranslation(['terminal', 'browser', 'shell'])
  const { t: tb } = useTranslation('browser')
  const sessionId = panelSession(panel)
  const hostId = hostOfPath(projectPath)
  const terminals = useTerminalsStore(useShallow((s) => terminalsOf(s.byId, panel, s.order[panel])))
  const activeId = useTerminalsStore((s) => s.active[panel])
  const rightId = useTerminalsStore((s) => s.split[panel] ?? null)
  const controls = useTerminalsStore((s) => s.controls)
  const sessionAgent = useSessionsStore((s) => (sessionId ? s.byId[sessionId]?.agentId : null))

  return useMemo(() => {
    const agent = (id: AgentId | null | undefined) => (id ? agentName(id, hostId) : '')
    const note = (control: NonNullable<TerminalTabItem['control']>, name: string) =>
      tb(CONTROL_NOTE[control], { agent: name })
    const right = terminals.find((terminal) => terminal.id === rightId) ?? null
    const active =
      terminals.find((terminal) => terminal.id === activeId) ??
      terminals.filter((terminal) => terminal.id !== right?.id).at(-1)
    return terminals.map((terminal): TerminalTabItem => {
      const selected = terminal.id === active?.id || (!!right && terminal.id === right.id)
      const exited = terminal.exitCode !== null
      const dot: TerminalTabItem['dot'] =
        terminal.waiting === 'password' && !terminal.stale
          ? { tone: 'fox', label: t('terminal:tab.password') }
          : terminal.activity && !selected
            ? { tone: 'fox', label: t('terminal:tab.newOutput') }
            : terminal.busy && !exited
              ? { tone: 'live', label: t('terminal:tab.running') }
              : null
      const control = controlOf(controls[terminal.id]) ?? (terminal.agentAsks ? 'asks' : null)
      const automatic = terminal.title || terminal.shell
      const name = terminal.name ?? automatic
      const owner = terminal.owner ? agent(terminal.owner.agentId) : null
      const shared =
        !terminal.owner && terminal.agentAllowed
          ? t('shell:surfaces.shared', { agent: agent(sessionAgent) })
          : null
      return {
        id: terminal.id,
        name,
        title: [
          terminal.name ? automatic : name,
          control ? note(control, owner ?? agent(sessionAgent)) : (owner ?? shared),
          dot?.label,
        ]
          .filter(Boolean)
          .join(' · '),
        selected,
        control,
        dot,
        code: exited ? terminal.exitCode : null,
        terminal,
        agent: agent(sessionAgent),
        shared: !terminal.owner && terminal.agentAllowed,
      }
    })
  }, [t, tb, hostId, sessionAgent, terminals, activeId, rightId, controls])
}

function useDockRowFit(signature: string): {
  stripRef: RefObject<HTMLDivElement | null>
  tight: boolean
} {
  const stripRef = useRef<HTMLDivElement>(null)
  const [tight, setTight] = useState(false)
  useLayoutEffect(() => {
    const row = stripRef.current
    const head = row?.parentElement
    if (!row || !head) return
    const measure = (): void => {
      row.dataset.measuring = ''
      const tabs = [...row.querySelectorAll<HTMLElement>(':scope > .kp-stab')]
      const widths = tabs.map((tab) => tab.offsetWidth)
      delete row.dataset.measuring
      const selected = tabs.findIndex((tab) => tab.dataset.selected !== undefined)
      const others = [...head.children].filter(
        (child) => child !== row && !child.classList.contains('kp-tabcount'),
      )
      const othersWidth = others.reduce((sum, child) => sum + (child as HTMLElement).offsetWidth, 0)
      const headGap = parseFloat(getComputedStyle(head).columnGap) || 0
      const rowGap = parseFloat(getComputedStyle(row).columnGap) || 0
      const room =
        head.clientWidth -
        othersWidth -
        headGap * others.length -
        rowGap * Math.max(0, tabs.length - 1) -
        (selected >= 0 ? widths[selected]! : 0)
      const rest = widths.filter((_, index) => index !== selected).sort((a, b) => a - b)
      let left = room
      let cap = Number.POSITIVE_INFINITY
      for (let index = 0; index < rest.length; index++) {
        const count = rest.length - index
        if (rest[index]! * count <= left) left -= rest[index]!
        else {
          cap = left / count
          break
        }
      }
      const narrow = cap < MIN_TAB_PX
      if (narrow || cap === Number.POSITIVE_INFINITY) row.style.removeProperty('--stab-cap')
      else row.style.setProperty('--stab-cap', `${Math.floor(cap)}px`)
      setTight(narrow)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(head)
    return () => observer.disconnect()
  }, [signature])
  return { stripRef, tight }
}

function TerminalBottomHeader({
  panel,
  projectPath,
  dockRef,
}: {
  panel: string
  projectPath: string
  dockRef: RefObject<HTMLDivElement | null>
}) {
  const { t } = useTranslation(['terminal', 'shell', 'browser', 'common'])
  const items = useTerminalTabItems(panel, projectPath)
  const split = useTerminalsStore((s) => !!s.split[panel])
  const [closing, setClosing] = useState<TerminalTabItem[]>([])
  const [starting, setStarting] = useState(false)
  const signature = items
    .map((item) => `${item.id}|${item.name}|${item.selected}|${item.dot?.tone}|${item.code}`)
    .join('\n')
  const { stripRef, tight } = useDockRowFit(`${signature}|${starting}`)

  const drop = useCallback((item: TerminalTabItem) => {
    if (item.terminal.stale) forgetTerminal(item.id)
    else void killTerminal(item.id)
  }, [])

  const close = useCallback(
    (item: TerminalTabItem) => {
      if (items.length <= 1) closeBottomTerminal(panel)
      drop(item)
    },
    [items.length, panel, drop],
  )

  const requestClose = useCallback(
    (item: TerminalTabItem) => {
      if (isRunningTerminal(item.terminal)) setClosing((waiting) => [...waiting, item])
      else close(item)
    },
    [close],
  )

  const closeMany = useCallback(
    (targets: TerminalTabItem[], keep: TerminalTabItem) => {
      if (targets.some((item) => item.selected)) showTerminal(panel, keep.id)
      for (const item of targets.filter((other) => !isRunningTerminal(other.terminal))) {
        drop(item)
      }
      setClosing((waiting) => [
        ...waiting,
        ...targets.filter((other) => isRunningTerminal(other.terminal)),
      ])
    },
    [panel, drop],
  )

  // Mod+W while the bottom terminal dock was used last closes the focused terminal tab.
  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.kind !== 'close-bottom-terminal-tab') return
        const terminals = useTerminalsStore.getState()
        const right = terminals.split[panel] ?? null
        const focused = terminals.focusedSide[panel] === 'right' && right ? right : null
        const target = items.find(
          (item) => item.selected && (focused ? item.id === focused : item.id !== right),
        )
        if (target) requestClose(target)
        else closeBottomTerminal(panel)
      }),
    [items, requestClose, panel],
  )

  const newTerminal = () => {
    const slow = window.setTimeout(() => setStarting(true), SLOW_START_MS)
    void createTerminal(projectPath, panel).finally(() => {
      window.clearTimeout(slow)
      setStarting(false)
    })
  }

  const dragEnded = (event: DragEndEvent) => {
    if (event.canceled) return
    const source = event.operation.source ?? null
    if (!isSortable(source)) return
    const id = String(source.id)
    if (source.index !== source.initialIndex) {
      moveTerminal(panel, id, source.index)
      return
    }
    if (event.nativeEvent?.type.startsWith('pointer')) showTerminal(panel, id)
  }

  const asked = closing[0] ?? null

  return (
    <div className="kp-head kp-head--dock">
      <div className="kp-head__main">
        <DragDropProvider sensors={tabSensors} onDragEnd={dragEnded}>
          <div
            ref={stripRef}
            role="tablist"
            aria-label={t('terminal:panel.tabs')}
            className="kp-stabs"
            data-tight={tight || undefined}
          >
            {items.map((item, index) => (
              <BottomTerminalTab
                key={item.id}
                panel={panel}
                projectPath={projectPath}
                item={item}
                index={index}
                split={split}
                onSelect={() => showTerminal(panel, item.id)}
                onClose={() => requestClose(item)}
                onCloseOthers={
                  items.length > 1
                    ? () =>
                        closeMany(
                          items.filter((other) => other.id !== item.id),
                          item,
                        )
                    : null
                }
                onCloseRight={
                  index < items.length - 1 ? () => closeMany(items.slice(index + 1), item) : null
                }
                onCloseAll={() => void requestCloseAllTerminals(panel)}
              />
            ))}
            {starting && (
              <span className="kp-stab">
                <span className="kp-stab__btn">
                  <span className="kp-stab__icon">
                    <PaneSpinner />
                  </span>
                  <span className="kp-stab__name">{t('terminal:panel.starting')}</span>
                </span>
              </span>
            )}
          </div>
        </DragDropProvider>
        <PanelButton
          label={t('terminal:panel.newTerminal')}
          shortcut={formatShortcut('Ctrl+Shift+`')}
          size="icon-xs"
          onClick={newTerminal}
        >
          <PaneIcon icon={PlusSignIcon} size={14} />
        </PanelButton>
      </div>
      <div className="kp-head__tools app-region-no-drag">
        {tight && <DockCountMenu items={items} onSelect={(item) => showTerminal(panel, item.id)} />}
        {items.length > 0 && (
          <PanelButton
            label={split ? t('terminal:panel.unsplit') : t('terminal:panel.split')}
            pressed={split}
            size="icon-xs"
            onClick={() => void toggleSplit(projectPath, panel)}
          >
            <PaneIcon icon={Layout2ColumnIcon} size={15} />
          </PanelButton>
        )}
        <PanelButton
          label={t('terminal:panel.moveToSide')}
          size="icon-xs"
          onClick={() => moveTerminalPlacement('side', panel)}
        >
          <PaneIcon icon={LayoutRightIcon} size={15} />
        </PanelButton>
        <PanelButton
          label={t('terminal:panel.hide')}
          shortcut={formatShortcut('Ctrl+`')}
          size="icon-xs"
          onClick={() => closeBottomTerminal(panel)}
        >
          <PaneIcon icon={Cancel01Icon} size={15} />
        </PanelButton>
      </div>
      <EndBottomTerminal
        container={dockRef}
        closing={asked}
        onCancel={() => setClosing((waiting) => waiting.slice(1))}
        onConfirm={() => {
          const item = asked && items.find((other) => other.id === asked.id)
          if (item) close(item)
          setClosing((waiting) => waiting.slice(1))
        }}
      />
    </div>
  )
}

function BottomTerminalTab({
  panel,
  projectPath,
  item,
  index,
  split,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseRight,
  onCloseAll,
}: {
  panel: string
  projectPath: string
  item: TerminalTabItem
  index: number
  split: boolean
  onSelect: () => void
  onClose: () => void
  onCloseOthers: (() => void) | null
  onCloseRight: (() => void) | null
  onCloseAll: () => void
}) {
  const { t } = useTranslation(['terminal', 'shell', 'browser', 'common'])
  const [editing, setEditing] = useState(false)
  const button = useRef<HTMLButtonElement | null>(null)
  const refocus = useRef(false)
  const renameAfterMenu = useRef(false)
  const { ref, handleRef, isDragging } = useSortable({ id: item.id, index, disabled: editing })
  const setButton = useCallback(
    (element: HTMLButtonElement | null) => {
      button.current = element
      handleRef(element)
    },
    [handleRef],
  )

  useEffect(() => {
    if (item.selected) button.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [item.selected])

  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    button.current?.focus()
  }, [editing])

  const finishRename = (value: string | null, restoreFocus: boolean) => {
    if (value !== null) void renameTerminal(item.id, value)
    refocus.current = restoreFocus
    setEditing(false)
  }

  const closeLabel = t('terminal:tab.close', { name: item.name })

  return (
    <ContextMenu
      disabled={editing}
      onOpenChangeComplete={(open) => {
        if (open || !renameAfterMenu.current) return
        renameAfterMenu.current = false
        setEditing(true)
      }}
    >
      <ContextMenuTrigger
        ref={ref}
        className="kp-stab"
        data-kind="terminal"
        data-selected={item.selected || undefined}
        data-control={item.control ?? undefined}
        data-dragging={isDragging || undefined}
        data-editing={editing || undefined}
      >
        <button
          ref={setButton}
          type="button"
          role="tab"
          aria-selected={item.selected}
          title={item.title}
          onClick={onSelect}
          onDoubleClick={() => setEditing(true)}
          onAuxClick={(event) => event.button === 1 && onClose()}
          className="kp-stab__btn"
          style={editing ? { visibility: 'hidden' } : undefined}
        >
          <span className="kp-stab__icon">
            <PaneIcon icon={ComputerTerminal01Icon} size={14} />
            {item.dot && <span aria-hidden className="kp-stab__badge" data-tone={item.dot.tone} />}
          </span>
          <span className="kp-stab__name">{item.name}</span>
          {item.code !== null && (
            <span className="kp-stab__code" data-failed={item.code !== 0 || undefined}>
              {item.code}
            </span>
          )}
          {item.dot && (
            <span
              role="img"
              aria-label={item.dot.label}
              className="kp-stab__dot"
              data-tone={item.dot.tone}
            />
          )}
        </button>
        {editing ? (
          <DockTabNameInput
            initial={item.name}
            label={t('terminal:tab.nameLabel')}
            onFinish={finishRename}
          />
        ) : (
          <button
            type="button"
            aria-label={closeLabel}
            title={closeLabel}
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
            className="kp-stab__x"
          >
            <PaneIcon icon={Cancel01Icon} size={12} />
          </button>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          onClick={() => {
            renameAfterMenu.current = true
          }}
        >
          <PaneIcon icon={PencilEdit02Icon} size={16} />
          {t('terminal:tab.rename')}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => {
            if (!split) onSelect()
            void toggleSplit(projectPath, panel)
          }}
        >
          <PaneIcon icon={Layout2ColumnIcon} size={16} />
          {split ? t('terminal:panel.unsplit') : t('terminal:panel.split')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => moveTerminalPlacement('side', panel)}>
          <PaneIcon icon={LayoutRightIcon} size={16} />
          {t('terminal:panel.moveToSide')}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            emitAppEvent({
              kind: 'mention-into-composer',
              draft: panelSession(panel) ?? NEW_SESSION_DRAFT,
              mention: surfaceMention('terminal', item.id),
            })
          }
        >
          <PaneIcon icon={MessageAdd01Icon} size={16} />
          {t('shell:surfaces.reference')}
        </ContextMenuItem>
        {item.shared && (
          <ContextMenuItem
            onClick={() => {
              const sessionId = item.terminal.sessionId ?? panelSession(panel)
              if (!sessionId) return
              void host('terminals.revokeAccess', { sessionId, terminalId: item.id })
            }}
          >
            <PaneIcon icon={UnavailableIcon} size={16} />
            {t('shell:surfaces.stopSharing', { agent: item.agent })}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={onClose}>
          <PaneIcon icon={Cancel01Icon} size={16} />
          {t('common:actions.close')}
        </ContextMenuItem>
        <ContextMenuItem disabled={!onCloseOthers} onClick={() => onCloseOthers?.()}>
          <PaneIcon icon={CancelCircleIcon} size={16} />
          {t('shell:surfaces.closeOthers')}
        </ContextMenuItem>
        <ContextMenuItem disabled={!onCloseRight} onClick={() => onCloseRight?.()}>
          <PaneIcon icon={ArrowRight01Icon} size={16} />
          {t('shell:surfaces.closeRight')}
        </ContextMenuItem>
        <ContextMenuItem onClick={onCloseAll}>
          <PaneIcon icon={CancelCircleIcon} size={16} />
          {t('terminal:tab.closeAll')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

function DockTabNameInput({
  initial,
  label,
  onFinish,
}: {
  initial: string
  label: string
  onFinish: (value: string | null, restoreFocus: boolean) => void
}) {
  const finished = useRef(false)
  const finish = (value: string | null, restoreFocus: boolean) => {
    if (finished.current) return
    finished.current = true
    onFinish(value, restoreFocus)
  }
  return (
    <div className="kp-stab__rename">
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

function DockCountMenu({
  items,
  onSelect,
}: {
  items: TerminalTabItem[]
  onSelect: (item: TerminalTabItem) => void
}) {
  const { t } = useTranslation(['terminal', 'browser'])
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t('browser:tabs.all')}
                  className="kp-tool kp-tool--sm kp-tabcount app-region-no-drag"
                />
              }
            />
          }
        >
          <span>{items.length}</span>
          <PaneIcon icon={ArrowDown01Icon} size={12} />
        </TooltipTrigger>
        <TooltipContent>{t('browser:tabs.all')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="kp-tablist">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('terminal:panel.tabs')}</DropdownMenuLabel>
          {items.map((item) => (
            <DropdownMenuItem key={item.id} onClick={() => onSelect(item)}>
              <span className="kp-tablist__mark">
                <PaneIcon icon={ComputerTerminal01Icon} size={14} />
              </span>
              <span className="kp-tablist__text">
                <span className="kp-tablist__name">{item.name}</span>
              </span>
              {item.selected && (
                <PaneIcon icon={Tick02Icon} size={14} className="kp-tablist__check" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function EndBottomTerminal({
  container,
  closing,
  onCancel,
  onConfirm,
}: {
  container: RefObject<HTMLElement | null>
  closing: TerminalTabItem | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation(['terminal', 'common'])
  return (
    <AlertDialog open={!!closing} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogPrimitive.Portal container={container}>
        <AlertDialogPrimitive.Backdrop className="kp-confirm app-region-no-drag" />
        <AlertDialogPrimitive.Popup className="kp-confirm__card" data-overlay-layer="">
          <AlertDialogPrimitive.Title>{t('closeDialog.title')}</AlertDialogPrimitive.Title>
          <AlertDialogPrimitive.Description>
            <Trans
              t={t}
              i18nKey="closeDialog.body"
              components={{
                title: <span className="kp-mono text-primary">{closing?.terminal.title}</span>,
              }}
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
