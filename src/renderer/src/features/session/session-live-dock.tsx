import { Fragment, memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowTurnBackwardIcon,
  ArrowUp01Icon,
  ComputerIcon,
  ComputerTerminal01Icon,
  Cursor02Icon,
  DashboardSquare01Icon,
  Globe02Icon,
  Key01Icon,
  KeyboardIcon,
  LockPasswordIcon,
  SmartPhone01Icon,
  StopCircleIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { activeBrowserControl } from '@shared/browser'
import { stopShortcutText } from '@shared/computer-use'
import type { ControlAgent, ControlAsk } from '@shared/control'
import type { AgentId, ComputerUseView } from '@shared/thread'
import { useControlAgent } from '@renderer/components/control/use-control-agent'
import { Spinner } from '@renderer/components/ui/spinner'
import { usePane } from '@renderer/features/split/pane-context'
import { errorMessage, host } from '@renderer/lib/host'
import { platform } from '@renderer/lib/platform'
import { useSeconds } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useBrowserStore } from '@renderer/stores/browser'
import { controlDevice, useDevicesStore } from '@renderer/stores/devices'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  handBackTerminal,
  orderTerminals,
  revealTerminal,
  takeOverTerminal,
  useTerminalsStore,
} from '@renderer/stores/terminals'
import { useThreadsStore } from '@renderer/stores/threads'
import { focusPane, toggleBoard } from '@renderer/stores/view'
import { useAppIcon } from './app-icon'
import {
  buildDockEntries,
  formatBackgroundDisplay,
  formatGroupPreview,
  isDockGroupEntry,
  reconcilePopoverState,
  selectScheduleHint,
  type BackgroundWork,
  type DockEntry,
  type DockGroupEntry,
  type DockGroupItem,
  type DockGroupKind,
  type DockPopoverMode,
  type ScheduleHint,
} from './live-dock-model'
import { TurnDots } from './turn-dots'

/** How far back from the thread's end a waiting computer app card is looked for. */
const WAITING_LOOKBACK = 40

/** The app's own icon as the system draws it, or a fallback window/computer glyph. */
function AppMark({ icon, app }: { icon: string | null; app: string | null }) {
  return (
    <span className="ctl-app-icon">
      {icon ? (
        <img src={icon} alt="" draggable={false} />
      ) : (
        <HugeiconsIcon
          icon={app ? DashboardSquare01Icon : ComputerIcon}
          strokeWidth={1.9}
          aria-hidden
          className="size-3.75"
        />
      )}
    </span>
  )
}

/** The name of the app a computer_app card in this session waits on the user to allow. */
function useWaitingApp(sessionId: string, enabled: boolean): string | null {
  return useThreadsStore((s) => {
    if (!enabled) return null
    const state = s.replicas[sessionId]?.state
    if (!state) return null
    const { order, byId } = state
    for (let i = order.length - 1; i >= Math.max(0, order.length - WAITING_LOOKBACK); i--) {
      const entry = byId[order[i]!]
      if (entry?.kind === 'computer_app' && entry.decision === null) return entry.appName
    }
    return null
  })
}

/**
 * Isolated second ticker mounted only while a single background timer needs live countdown updates,
 * keeping the rest of the dock free from per-second re-renders.
 */
function BackgroundCountdownRow({
  work,
  hint,
  onOpenBoard,
}: {
  work: BackgroundWork
  hint: ScheduleHint
  onOpenBoard: () => void
}) {
  const { t } = useTranslation('session')
  const now = useSeconds()
  const display = formatBackgroundDisplay(t, work, hint, now)
  return (
    <BackgroundRowView
      headline={display.headline}
      hint={display.hint}
      openBoardLabel={t('stillRunning.openBoard')}
      onOpenBoard={onOpenBoard}
    />
  )
}

function BackgroundCountdownSummary({
  work,
  hint,
  onOpenBoard,
}: {
  work: BackgroundWork
  hint: ScheduleHint
  onOpenBoard: () => void
}) {
  const { t } = useTranslation('session')
  const now = useSeconds()
  const display = formatBackgroundDisplay(t, work, hint, now)
  return (
    <button
      type="button"
      className="ks-dock__seg ks-dock__seg--action"
      data-segment="background"
      title={display.summary}
      onClick={(event) => {
        event.stopPropagation()
        onOpenBoard()
      }}
    >
      <span className="ks-dock__seg-dot ks-dock__seg-dot--fox" aria-hidden />
      <span className="truncate">{display.summary}</span>
    </button>
  )
}

function BackgroundRowView({
  headline,
  hint,
  openBoardLabel,
  onOpenBoard,
}: {
  headline: string
  hint: string | null
  openBoardLabel: string
  onOpenBoard: () => void
}) {
  const fullTitle = hint ? `${headline} · ${hint}` : headline
  return (
    <button
      type="button"
      className="ks-dock__row ks-dock__row--clickable"
      data-entry-key="background"
      data-priority="5"
      data-tone="neutral"
      title={fullTitle}
      onClick={onOpenBoard}
    >
      <span className="ks-dock__mark" aria-hidden>
        <TurnDots phase="working" slower={1.5} className="ks-dock__dots" />
      </span>
      <span className="ks-dock__text">
        <b className="ks-dock__bg-head">{headline}</b>
        {hint && (
          <>
            <i aria-hidden>·</i>
            <span className="ks-dock__sub">{hint}</span>
          </>
        )}
      </span>
      <span className="ks-dock__board-pill" aria-hidden>
        <span>{openBoardLabel}</span>
        <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-3" />
      </span>
    </button>
  )
}

function AskText({
  ask,
  agentName,
  fallback,
}: {
  ask: ControlAsk
  agentName: string
  fallback: string
}) {
  const { t } = useTranslation('control')
  return (
    <Trans
      t={t}
      i18nKey={ask.target ? `label.asks.${ask.step}` : `label.asksHere.${ask.step}`}
      values={{ agent: agentName, target: ask.target ?? fallback }}
      components={{ b: <b dir="auto" /> }}
    />
  )
}

interface DockHandlers {
  agent: ControlAgent | null
  computerIcon: string | null
  stopTitle: string
  scheduleHint: ScheduleHint
  onComputerTakeOver: () => void
  onComputerHandBack: () => void
  onComputerStop: () => void
  onBrowserTakeOver: () => void
  onBrowserHandBack: () => void
  onBrowserDone: () => void
  onDeviceTakeOver: (id: string) => void
  onDeviceHandBack: (id: string) => void
  onTerminalTakeOver: (id: string) => void
  onTerminalHandBack: (id: string) => void
  onTerminalPassword: (id: string) => void
  onOpenBoard: () => void
}

function GroupSubList({
  entry,
  solo,
  handlers,
}: {
  entry: DockGroupEntry
  solo?: boolean
  handlers: DockHandlers
}) {
  const { t } = useTranslation('control')
  const isTerminal = entry.groupKind === 'terminals'
  const takeOver = (item: DockGroupItem) => {
    if (item.surface === 'terminal') handlers.onTerminalTakeOver(item.id)
    else handlers.onDeviceTakeOver(item.id)
  }

  return (
    <div
      className="ks-dock__sublist"
      data-group-list={entry.groupKind}
      data-solo-group={solo ? '' : undefined}
      role="list"
    >
      {entry.items.map((item) => (
        <div
          key={item.id}
          role="listitem"
          className="ks-dock__subitem"
          data-item-id={item.id}
          data-acting={item.acting ? '' : undefined}
        >
          <span className="ks-dock__subdot" aria-hidden />
          <span
            className={cn('ks-dock__subname', isTerminal && 'font-mono')}
            title={item.name}
            dir="auto"
          >
            {item.name}
          </span>
          <button type="button" className="ks-dock__subaction" onClick={() => takeOver(item)}>
            {t('actions.takeOver')}
          </button>
        </div>
      ))}
    </div>
  )
}

function DockEntryRow({
  entry,
  handlers,
  asPrimary,
  groupExpanded,
  popoverId,
  onToggleGroup,
}: {
  entry: DockEntry
  handlers: DockHandlers
  asPrimary?: boolean
  groupExpanded?: boolean
  popoverId?: string
  onToggleGroup?: () => void
}) {
  const { t: tControl } = useTranslation('control')
  const { t: tSession } = useTranslation('session')
  const { t: tTerminal } = useTranslation('terminal')
  const textId = useId()
  const agentName = handlers.agent?.name ?? tControl('agent')
  const b = <b dir="auto" />

  if (entry.kind === 'background') {
    const needsCountdown = entry.work.scheduled === 1 && handlers.scheduleHint.fireAt !== null
    if (needsCountdown) {
      return (
        <BackgroundCountdownRow
          work={entry.work}
          hint={handlers.scheduleHint}
          onOpenBoard={handlers.onOpenBoard}
        />
      )
    }
    const display = formatBackgroundDisplay(tSession, entry.work, handlers.scheduleHint)
    return (
      <BackgroundRowView
        headline={display.headline}
        hint={display.hint}
        openBoardLabel={tSession('stillRunning.openBoard')}
        onOpenBoard={handlers.onOpenBoard}
      />
    )
  }

  if (isDockGroupEntry(entry)) {
    const preview = formatGroupPreview(tControl, entry.items)
    const isTerminals = entry.groupKind === 'terminals'
    const count = entry.items.length
    const titleKey = isTerminals ? 'dock.groupTerminals' : 'dock.groupDevices'
    const icon = isTerminals ? ComputerTerminal01Icon : SmartPhone01Icon
    const expanded = groupExpanded === true
    return (
      <button
        type="button"
        className={cn('ks-dock__row ks-dock__row--clickable', !asPrimary && 'ks-dock__group-head')}
        data-entry-key={entry.key}
        data-priority={entry.priority}
        data-tone={entry.tone}
        data-group={entry.groupKind}
        aria-expanded={expanded}
        aria-controls={popoverId}
        title={preview}
        onClick={onToggleGroup}
      >
        <span className="ks-dock__mark" aria-hidden>
          <HugeiconsIcon icon={icon} strokeWidth={1.9} className="size-3.5" />
        </span>
        <span className="ks-dock__text">
          <Trans t={tControl} i18nKey={titleKey} values={{ count }} components={{ b }} />
          <i aria-hidden>·</i>
          <span className={cn('ks-dock__sub', isTerminals && 'font-mono')}>{preview}</span>
        </span>
        <span className="ks-dock__group-meta" aria-hidden>
          <span className="ks-dock__count">{count}</span>
          <HugeiconsIcon
            icon={asPrimary ? ArrowUp01Icon : ArrowDown01Icon}
            strokeWidth={2}
            className={cn('ks-dock__chev size-3.5', expanded && 'ks-dock__chev--open')}
          />
        </span>
      </button>
    )
  }

  let mark: React.ReactNode
  let text: React.ReactNode
  let title: string
  let actions: React.ReactNode = null

  switch (entry.kind) {
    case 'computer-waiting':
      mark = <HugeiconsIcon icon={DashboardSquare01Icon} strokeWidth={1.9} className="size-3.75" />
      title = entry.app
      text = (
        <Trans
          t={tSession}
          i18nKey="computerBar.waiting"
          values={{ app: entry.app }}
          components={{ app: b }}
        />
      )
      break

    case 'terminal-password':
      mark = <HugeiconsIcon icon={LockPasswordIcon} strokeWidth={1.9} className="size-3.5" />
      title = entry.name
      text = (
        <Trans
          t={tTerminal}
          i18nKey="password.label"
          values={{ agent: agentName, terminal: entry.name }}
          components={{ b }}
        />
      )
      actions = (
        <button
          type="button"
          className="ks-dock__btn ks-dock__btn--amber"
          aria-describedby={textId}
          onClick={() => handlers.onTerminalPassword(entry.id)}
        >
          <HugeiconsIcon icon={KeyboardIcon} strokeWidth={1.9} className="size-3.5" aria-hidden />
          {tTerminal('password.go')}
        </button>
      )
      break

    case 'browser-asks':
      mark = <HugeiconsIcon icon={Key01Icon} strokeWidth={1.9} className="size-3.5" />
      title = entry.ask.target ?? tControl('target.browser')
      text = <AskText ask={entry.ask} agentName={agentName} fallback={tControl('target.browser')} />
      actions = (
        <button
          type="button"
          className="ks-dock__btn ks-dock__btn--amber"
          aria-describedby={textId}
          onClick={handlers.onBrowserDone}
        >
          {tControl('actions.done')}
        </button>
      )
      break

    case 'device-asks':
      mark = <HugeiconsIcon icon={Key01Icon} strokeWidth={1.9} className="size-3.5" />
      title = entry.ask.target ?? entry.name
      text = <AskText ask={entry.ask} agentName={agentName} fallback={entry.name} />
      actions = (
        <button
          type="button"
          className="ks-dock__btn ks-dock__btn--amber"
          aria-describedby={textId}
          onClick={() => handlers.onDeviceHandBack(entry.id)}
        >
          {tControl('actions.done')}
        </button>
      )
      break

    case 'terminal-asks':
      mark = <HugeiconsIcon icon={Key01Icon} strokeWidth={1.9} className="size-3.5" />
      title = entry.ask.target ?? entry.name
      text = <AskText ask={entry.ask} agentName={agentName} fallback={entry.name} />
      actions = (
        <button
          type="button"
          className="ks-dock__btn ks-dock__btn--amber"
          aria-describedby={textId}
          onClick={() => handlers.onTerminalHandBack(entry.id)}
        >
          {tControl('actions.done')}
        </button>
      )
      break

    case 'computer-stopping':
      mark = <Spinner className="size-3.5" />
      title = tSession('computerBar.stopping')
      text = tSession('computerBar.stopping')
      break

    case 'computer-agent': {
      const target = entry.app ?? tControl('target.computer')
      mark = <AppMark icon={handlers.computerIcon} app={entry.app} />
      title = target
      text = (
        <Trans
          t={tControl}
          i18nKey={entry.looking ? 'label.computer.looking' : 'label.computer.agent'}
          values={{ agent: agentName, target }}
          components={{ b }}
        />
      )
      actions = (
        <>
          <button
            type="button"
            className="ks-dock__btn ks-dock__btn--on-fox"
            aria-describedby={textId}
            onClick={handlers.onComputerTakeOver}
          >
            {tControl('actions.takeOver')}
          </button>
          <button
            type="button"
            className="ks-dock__btn ks-dock__btn--on-fox-quiet"
            title={handlers.stopTitle}
            aria-describedby={textId}
            onClick={handlers.onComputerStop}
          >
            <HugeiconsIcon
              icon={StopCircleIcon}
              strokeWidth={1.9}
              className="size-3.5"
              aria-hidden
            />
            {tControl('actions.stop')}
          </button>
        </>
      )
      break
    }

    case 'computer-you': {
      const held = entry.app ?? tControl('held.computer')
      mark = <HugeiconsIcon icon={Cursor02Icon} strokeWidth={1.9} className="size-3.5" />
      title = held
      text = (
        <Trans
          t={tControl}
          i18nKey="label.computer.you"
          values={{ agent: agentName, held }}
          components={{ b, i: <i aria-hidden /> }}
        />
      )
      actions = (
        <button
          type="button"
          className="ks-dock__btn ks-dock__btn--handback"
          aria-describedby={textId}
          onClick={handlers.onComputerHandBack}
        >
          <HugeiconsIcon
            icon={ArrowTurnBackwardIcon}
            strokeWidth={1.9}
            className="size-3.5"
            aria-hidden
          />
          {tControl('actions.handBack')}
        </button>
      )
      break
    }

    case 'browser-you': {
      const held = tControl('held.tab')
      mark = <HugeiconsIcon icon={Cursor02Icon} strokeWidth={1.9} className="size-3.5" />
      title = held
      text = (
        <Trans
          t={tControl}
          i18nKey="label.you"
          values={{ agent: agentName, held }}
          components={{ b, i: <i aria-hidden /> }}
        />
      )
      actions = (
        <button
          type="button"
          className="ks-dock__btn ks-dock__btn--handback"
          aria-describedby={textId}
          onClick={handlers.onBrowserHandBack}
        >
          <HugeiconsIcon
            icon={ArrowTurnBackwardIcon}
            strokeWidth={1.9}
            className="size-3.5"
            aria-hidden
          />
          {tControl('actions.handBack')}
        </button>
      )
      break
    }

    case 'device-you':
      mark = <HugeiconsIcon icon={Cursor02Icon} strokeWidth={1.9} className="size-3.5" />
      title = entry.name
      text = (
        <Trans
          t={tControl}
          i18nKey="label.you"
          values={{ agent: agentName, held: entry.name }}
          components={{ b, i: <i aria-hidden /> }}
        />
      )
      actions = (
        <button
          type="button"
          className="ks-dock__btn ks-dock__btn--handback"
          aria-describedby={textId}
          onClick={() => handlers.onDeviceHandBack(entry.id)}
        >
          <HugeiconsIcon
            icon={ArrowTurnBackwardIcon}
            strokeWidth={1.9}
            className="size-3.5"
            aria-hidden
          />
          {tControl('actions.handBack')}
        </button>
      )
      break

    case 'terminal-you':
      mark = <HugeiconsIcon icon={Cursor02Icon} strokeWidth={1.9} className="size-3.5" />
      title = entry.name
      text = (
        <Trans
          t={tControl}
          i18nKey="label.you"
          values={{ agent: agentName, held: entry.name }}
          components={{ b, i: <i aria-hidden /> }}
        />
      )
      actions = (
        <button
          type="button"
          className="ks-dock__btn ks-dock__btn--handback"
          aria-describedby={textId}
          onClick={() => handlers.onTerminalHandBack(entry.id)}
        >
          <HugeiconsIcon
            icon={ArrowTurnBackwardIcon}
            strokeWidth={1.9}
            className="size-3.5"
            aria-hidden
          />
          {tControl('actions.handBack')}
        </button>
      )
      break

    case 'browser-agent': {
      const target = tControl('target.browser')
      mark = <HugeiconsIcon icon={Globe02Icon} strokeWidth={1.9} className="size-3.5" />
      title = target
      text = (
        <Trans
          t={tControl}
          i18nKey="label.agent"
          values={{ agent: agentName, target }}
          components={{ b }}
        />
      )
      actions = (
        <button
          type="button"
          className="ks-dock__btn ks-dock__btn--takeover"
          aria-describedby={textId}
          onClick={handlers.onBrowserTakeOver}
        >
          {tControl('actions.takeOver')}
        </button>
      )
      break
    }

    case 'device-agent':
      mark = <HugeiconsIcon icon={SmartPhone01Icon} strokeWidth={1.9} className="size-3.5" />
      title = entry.name
      text = (
        <Trans
          t={tControl}
          i18nKey="label.agent"
          values={{ agent: agentName, target: entry.name }}
          components={{ b }}
        />
      )
      actions = (
        <button
          type="button"
          className="ks-dock__btn ks-dock__btn--takeover"
          aria-describedby={textId}
          onClick={() => handlers.onDeviceTakeOver(entry.id)}
        >
          {tControl('actions.takeOver')}
        </button>
      )
      break

    case 'terminal-agent':
      mark = <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={1.9} className="size-3.5" />
      title = entry.name
      text = (
        <Trans
          t={tControl}
          i18nKey="label.agent"
          values={{ agent: agentName, target: entry.name }}
          components={{ b }}
        />
      )
      actions = (
        <button
          type="button"
          className="ks-dock__btn ks-dock__btn--takeover"
          aria-describedby={textId}
          onClick={() => handlers.onTerminalTakeOver(entry.id)}
        >
          {tControl('actions.takeOver')}
        </button>
      )
      break
  }

  return (
    <div
      className="ks-dock__row"
      data-entry-key={entry.key}
      data-priority={entry.priority}
      data-tone={entry.tone}
    >
      <span className="ks-dock__mark" aria-hidden>
        {mark}
      </span>
      <span id={textId} role="status" className="ks-dock__text" title={title}>
        {text}
      </span>
      {actions && <div className="ks-dock__actions">{actions}</div>}
    </div>
  )
}

function SummarySegment({
  entry,
  scheduleHint,
  onOpenBoard,
  onOpenGroup,
}: {
  entry: DockEntry
  scheduleHint: ScheduleHint
  onOpenBoard: () => void
  onOpenGroup: (group: DockGroupKind) => void
}) {
  const { t: tControl } = useTranslation('control')
  const { t: tSession } = useTranslation('session')

  if (entry.kind === 'background') {
    if (entry.work.scheduled === 1 && scheduleHint.fireAt !== null) {
      return (
        <BackgroundCountdownSummary
          work={entry.work}
          hint={scheduleHint}
          onOpenBoard={onOpenBoard}
        />
      )
    }
    const display = formatBackgroundDisplay(tSession, entry.work, scheduleHint)
    return (
      <button
        type="button"
        className="ks-dock__seg ks-dock__seg--action"
        data-segment="background"
        title={display.summary}
        onClick={(event) => {
          event.stopPropagation()
          onOpenBoard()
        }}
      >
        <span className="ks-dock__seg-dot ks-dock__seg-dot--fox" aria-hidden />
        <span className="truncate">{display.summary}</span>
      </button>
    )
  }

  if (isDockGroupEntry(entry)) {
    const label =
      entry.groupKind === 'terminals'
        ? tControl('dock.terminals', { count: entry.items.length })
        : tControl('dock.devices', { count: entry.items.length })
    return (
      <button
        type="button"
        className="ks-dock__seg ks-dock__seg--action"
        data-segment={entry.groupKind}
        title={label}
        onClick={(event) => {
          event.stopPropagation()
          onOpenGroup(entry.groupKind)
        }}
      >
        <span className="truncate">{label}</span>
      </button>
    )
  }

  let label: string
  switch (entry.kind) {
    case 'computer-waiting':
      label = tControl('dock.summary.computerWaiting', { app: entry.app })
      break
    case 'computer-stopping':
      label = tControl('dock.summary.computerStopping')
      break
    case 'computer-agent':
      label = entry.app
        ? tControl('dock.summary.computerAgent', { app: entry.app })
        : tControl('dock.summary.computerActive')
      break
    case 'computer-you':
      label = tControl('dock.summary.computerYou')
      break
    case 'browser-asks':
      label = tControl('dock.summary.browserAsks')
      break
    case 'browser-you':
      label = tControl('dock.summary.browserYou')
      break
    case 'browser-agent':
      label = tControl('dock.summary.browserAgent')
      break
    case 'device-asks':
      label = tControl('dock.summary.deviceAsks', { name: entry.name })
      break
    case 'device-you':
      label = tControl('dock.summary.deviceYou', { name: entry.name })
      break
    case 'device-agent':
      label = tControl('dock.devices', { count: 1 })
      break
    case 'terminal-password':
      label = tControl('dock.summary.terminalPassword', { name: entry.name })
      break
    case 'terminal-asks':
      label = tControl('dock.summary.terminalAsks', { name: entry.name })
      break
    case 'terminal-you':
      label = tControl('dock.summary.terminalYou', { name: entry.name })
      break
    case 'terminal-agent':
      label = tControl('dock.summary.terminalAgent', { name: entry.name })
      break
  }

  return (
    <span
      className="ks-dock__seg"
      data-tone={entry.tone === 'neutral' ? undefined : entry.tone}
      title={label}
    >
      {entry.tone === 'amber' && (
        <span className="ks-dock__seg-dot ks-dock__seg-dot--amber" aria-hidden />
      )}
      {entry.tone === 'computer' && (
        <span className="ks-dock__seg-dot ks-dock__seg-dot--fox" aria-hidden />
      )}
      <span className="truncate">{label}</span>
    </span>
  )
}

/**
 * Unified composer-anchored live status dock (U4 x U1): combines Computer Use, Browser, Devices,
 * Terminals and background still-running tasks into a full-width floating card capped at two tiers
 * (36px primary + 29px summary strip) with an in-place upward popover for concurrent controls.
 */
export const SessionLiveDock = memo(function SessionLiveDock({
  sessionId,
  agentId,
  hostId,
  computerView,
  showSurfaces,
  showBackground,
  onError,
}: {
  sessionId: string
  agentId: AgentId
  hostId: string | null
  /** Active computer use view when computer controls may render; null otherwise. */
  computerView: ComputerUseView | null
  /** Whether browser, device and terminal controls may render (user session, online, unarchived). */
  showSurfaces: boolean
  /** Whether background still-running tasks may render (idle/waiting_background, online, unarchived). */
  showBackground: boolean
  onError: (message: string | null) => void
}) {
  const { t: tControl } = useTranslation('control')
  const { t: tSession } = useTranslation('session')
  const pane = usePane()
  const rootRef = useRef<HTMLDivElement>(null)
  const popoverId = useId()

  const [stopping, setStopping] = useState(false)
  const [popoverState, setPopoverState] = useState<{
    sessionId: string
    mode: DockPopoverMode
    expandedGroups: Set<DockGroupKind>
  }>(() => ({ sessionId, mode: null, expandedGroups: new Set() }))

  // Reset computer stopping indicator once the computer hold ends.
  if (!computerView && stopping) setStopping(false)

  const agent = useControlAgent(agentId, hostId)
  const computerIcon = useAppIcon(computerView?.appPath ?? null)
  const waitingApp = useWaitingApp(sessionId, !!computerView)
  const stopShortcut = useSettingsStore((s) => s.settings.computerUse.stopShortcut)

  const browser = useBrowserStore((s) =>
    showSurfaces ? activeBrowserControl(s.bySession[sessionId]) : null,
  )
  const rawDevices = useDevicesStore(
    useShallow((s) =>
      showSurfaces
        ? s.devices.filter((device) => device.sessionId === sessionId && device.operator !== null)
        : [],
    ),
  )
  const rawTerminals = useTerminalsStore(
    useShallow((s) => {
      if (!showSurfaces) return []
      const active = Object.values(s.byId).filter(
        (terminal) =>
          !terminal.stale &&
          (terminal.owner?.sessionId ?? terminal.sessionId) === sessionId &&
          (terminal.control.kind !== 'idle' || terminal.waiting === 'password'),
      )
      return orderTerminals(active, s.order[sessionId])
    }),
  )
  const background = useSessionsStore(
    useShallow((s): BackgroundWork | null => {
      if (!showBackground) return null
      const still = s.byId[sessionId]?.stillRunning
      return still
        ? {
            commands: still.commands,
            subagents: still.subagents,
            monitors: still.monitors ?? 0,
            scheduled: still.scheduled ?? 0,
            reportsBack: still.reportsBack,
            unnamed: still.unnamed === true,
          }
        : null
    }),
  )
  const scheduleHint = useThreadsStore(
    useShallow((s) =>
      showBackground
        ? selectScheduleHint(s.replicas[sessionId]?.state?.session.background)
        : { fireAt: null, cron: null },
    ),
  )

  const devices = useMemo(
    () =>
      rawDevices.flatMap((device) =>
        device.operator
          ? [{ id: device.id, name: device.name, control: device.operator.control }]
          : [],
      ),
    [rawDevices],
  )
  const terminals = useMemo(
    () =>
      rawTerminals.map((terminal) => ({
        id: terminal.id,
        name: terminal.name ?? (terminal.title || terminal.shell),
        control: terminal.control,
        waiting: terminal.waiting,
      })),
    [rawTerminals],
  )

  const entries = useMemo(
    () =>
      buildDockEntries({
        computer: computerView,
        computerWaitingApp: waitingApp,
        computerStopping: stopping,
        browser,
        devices,
        terminals,
        background,
        hasAgent: agent !== null,
      }),
    [computerView, waitingApp, stopping, browser, devices, terminals, background, agent],
  )

  const reconciled = useMemo(() => {
    const scopedMode = popoverState.sessionId === sessionId ? popoverState.mode : null
    const scopedExpanded =
      popoverState.sessionId === sessionId ? popoverState.expandedGroups : new Set<DockGroupKind>()
    return reconcilePopoverState(scopedMode, scopedExpanded, entries)
  }, [popoverState, sessionId, entries])
  const effectiveMode = reconciled.mode
  const expandedGroups = reconciled.expandedGroups

  const closePopover = useCallback(() => {
    setPopoverState({ sessionId, mode: null, expandedGroups: new Set() })
  }, [sessionId])

  const toggleRestPopover = useCallback(() => {
    setPopoverState((prev) => {
      const currentMode = prev.sessionId === sessionId ? prev.mode : null
      if (currentMode === 'rest') {
        return { sessionId, mode: null, expandedGroups: new Set() }
      }
      return { sessionId, mode: 'rest', expandedGroups: new Set() }
    })
  }, [sessionId])

  const togglePrimaryGroupPopover = useCallback(() => {
    setPopoverState((prev) => {
      const currentMode = prev.sessionId === sessionId ? prev.mode : null
      if (currentMode === 'primary-group') {
        return { sessionId, mode: null, expandedGroups: new Set() }
      }
      return { sessionId, mode: 'primary-group', expandedGroups: new Set() }
    })
  }, [sessionId])

  const openRestWithGroup = useCallback(
    (group: DockGroupKind) => {
      setPopoverState({
        sessionId,
        mode: 'rest',
        expandedGroups: new Set([group]),
      })
    },
    [sessionId],
  )

  const toggleRestGroup = useCallback(
    (group: DockGroupKind) => {
      setPopoverState((prev) => {
        const base =
          prev.sessionId === sessionId && prev.mode === 'rest'
            ? new Set(prev.expandedGroups)
            : new Set<DockGroupKind>()
        if (base.has(group)) base.delete(group)
        else base.add(group)
        return { sessionId, mode: 'rest', expandedGroups: base }
      })
    },
    [sessionId],
  )

  useEffect(() => {
    if (!effectiveMode) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target && rootRef.current?.contains(target as Node)) return
      closePopover()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.repeat) return
      event.preventDefault()
      event.stopPropagation()
      closePopover()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [effectiveMode, closePopover])

  const openBoard = useCallback(() => {
    closePopover()
    if (pane && !pane.focused) focusPane(pane.paneId)
    toggleBoard(sessionId, true)
  }, [closePopover, pane, sessionId])

  const stopTitle =
    hostId === null
      ? `${tSession('computerBar.stopLabel')}  ${stopShortcutText(stopShortcut, platform)}`
      : tSession('computerBar.stopLabel')

  const browserFailed = useCallback((error: unknown) => {
    console.error('Could not reach the page', error)
  }, [])

  const onComputerStop = useCallback(async () => {
    setStopping(true)
    onError(null)
    try {
      await host('computer.stop', { sessionId })
    } catch (caught) {
      onError(errorMessage(caught))
      setStopping(false)
    }
  }, [onError, sessionId])

  const onComputerControl = useCallback(
    (method: 'computer.takeOver' | 'computer.handBack') => {
      onError(null)
      host(method, { sessionId }).catch((caught: unknown) => onError(errorMessage(caught)))
    },
    [onError, sessionId],
  )

  const handlers: DockHandlers = useMemo(
    () => ({
      agent,
      computerIcon,
      stopTitle,
      scheduleHint,
      onComputerTakeOver: () => onComputerControl('computer.takeOver'),
      onComputerHandBack: () => onComputerControl('computer.handBack'),
      onComputerStop: () => void onComputerStop(),
      onBrowserTakeOver: () => void window.kettu.browser.takeOver(sessionId).catch(browserFailed),
      onBrowserHandBack: () => void window.kettu.browser.handBack(sessionId).catch(browserFailed),
      onBrowserDone: () =>
        void window.kettu.browser.answerAsk(sessionId, 'done').catch(browserFailed),
      onDeviceTakeOver: (id) => controlDevice('devices.takeOver', id, sessionId),
      onDeviceHandBack: (id) => controlDevice('devices.handBack', id, sessionId),
      onTerminalTakeOver: (id) => takeOverTerminal(id),
      onTerminalHandBack: (id) => handBackTerminal(id),
      onTerminalPassword: (id) => {
        closePopover()
        revealTerminal(id)
      },
      onOpenBoard: openBoard,
    }),
    [
      agent,
      browserFailed,
      closePopover,
      computerIcon,
      onComputerControl,
      onComputerStop,
      openBoard,
      scheduleHint,
      sessionId,
      stopTitle,
    ],
  )

  if (entries.length === 0) return null

  const primary = entries[0]!
  const rest = entries.slice(1)
  const hasRest = rest.length > 0

  return (
    <div
      ref={rootRef}
      className="ks-dock"
      role="region"
      aria-label={tControl('label.group')}
      data-tier={hasRest ? 'capped' : 'solo'}
      data-open={effectiveMode ? '' : undefined}
    >
      {effectiveMode !== null && (
        <div
          id={popoverId}
          role="dialog"
          aria-label={tControl('dock.popoverLabel')}
          className="ks-dock__popover"
          data-popover-mode={effectiveMode}
        >
          {effectiveMode === 'primary-group' && isDockGroupEntry(primary) ? (
            <GroupSubList entry={primary} solo handlers={handlers} />
          ) : (
            <div className="ks-dock__popover-list">
              {rest.map((entry) => {
                if (isDockGroupEntry(entry)) {
                  const isExpanded = expandedGroups.has(entry.groupKind)
                  return (
                    <div
                      key={entry.key}
                      className="ks-dock__group"
                      data-open={isExpanded ? '' : undefined}
                    >
                      <DockEntryRow
                        entry={entry}
                        handlers={handlers}
                        groupExpanded={isExpanded}
                        onToggleGroup={() => toggleRestGroup(entry.groupKind)}
                      />
                      {isExpanded && <GroupSubList entry={entry} handlers={handlers} />}
                    </div>
                  )
                }
                return (
                  <div key={entry.key} className="ks-dock__popover-item">
                    <DockEntryRow entry={entry} handlers={handlers} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      <div className="ks-dock__card">
        <div className="ks-dock__primary">
          <DockEntryRow
            entry={primary}
            handlers={handlers}
            asPrimary
            groupExpanded={effectiveMode === 'primary-group'}
            popoverId={isDockGroupEntry(primary) ? popoverId : undefined}
            onToggleGroup={isDockGroupEntry(primary) ? togglePrimaryGroupPopover : undefined}
          />
        </div>

        {hasRest && (
          <div className="ks-dock__summary" onClick={toggleRestPopover}>
            <div className="ks-dock__segments">
              {rest.map((entry, index) => (
                <Fragment key={entry.key}>
                  {index > 0 && (
                    <span className="ks-dock__sep" aria-hidden>
                      ·
                    </span>
                  )}
                  <SummarySegment
                    entry={entry}
                    scheduleHint={scheduleHint}
                    onOpenBoard={openBoard}
                    onOpenGroup={openRestWithGroup}
                  />
                </Fragment>
              ))}
            </div>
            <button
              type="button"
              className="ks-dock__toggle"
              aria-expanded={effectiveMode === 'rest'}
              aria-controls={popoverId}
              onClick={(event) => {
                event.stopPropagation()
                toggleRestPopover()
              }}
            >
              <span>{tControl(effectiveMode === 'rest' ? 'dock.hide' : 'dock.manage')}</span>
              <HugeiconsIcon
                icon={ArrowUp01Icon}
                strokeWidth={2}
                aria-hidden
                className={cn(
                  'ks-dock__chev size-3',
                  effectiveMode === 'rest' && 'ks-dock__chev--open',
                )}
              />
            </button>
          </div>
        )}
      </div>
    </div>
  )
})
