import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog'
import { DragDropProvider, type DragEndEvent } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import {
  ArrowDown01Icon,
  ArrowExpand01Icon,
  ArrowRight01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  GitCompareIcon,
  Layout2ColumnIcon,
  MessageAdd01Icon,
  PencilEdit02Icon,
  PinIcon,
  PlusSignIcon,
  ShapesIcon,
  SidebarRightIcon,
  Tick02Icon,
  UnavailableIcon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SurfaceControl } from '@shared/control'
import type { AgentId } from '@shared/thread'
import { SESSION_DEVICE_LIMIT, type DeviceInfo } from '@shared/device-host'
import { emitAppEvent, onAppEvent } from '@renderer/app/events'
import { NEW_SESSION_DRAFT } from '@renderer/features/session/composer/drafts'
import { surfaceMention } from '@renderer/features/session/composer/chips'
import { useThreadsStore } from '@renderer/stores/threads'
import { host } from '@renderer/lib/host'
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
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { KIND_ICON } from '@renderer/features/artifacts/kinds'
import { artifactKind } from '@renderer/features/artifacts/model'
import { mayLeave } from '@renderer/features/artifacts/unsaved'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { FileTypeIcon } from '@renderer/features/files/file-type-icon'
import { PluginTile } from '@renderer/features/plugin-views/plugin-tile'
import { languageText, surfaceTitle } from '@renderer/features/plugin-views/plugin-text'
import { useGonePluginPanes } from '@renderer/features/plugin-views/use-gone-panes'
import { folderOf, nameOf } from '@renderer/features/files/paths'
import { UnsavedPrompt } from '@renderer/features/files/unsaved-prompt'
import { useBoardActivity, useBoardNews } from '@renderer/features/board/use-board-activity'
import { addressText } from '@renderer/features/browser/address'
import { SiteMark } from '@renderer/features/browser/site-mark'
import { markOf, rowOf, statusOf, useAddable } from '@renderer/features/devices/device-marks'
import { DeviceRow } from '@renderer/features/devices/device-row'
import { useSessionView } from '@renderer/features/session/use-thread'
import { runSessionMenuAccelerator } from '@renderer/features/sidebar/session-menu-model'
import { hostOfPath } from '@renderer/lib/host-paths'
import { hasBand, isMac, isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { useArtifactsStore } from '@renderer/stores/artifacts'
import { restorePages, useBrowserStore } from '@renderer/stores/browser'
import {
  closeDevice,
  devicesOf,
  loadDevices,
  selectDevice,
  useDevicesStore,
} from '@renderer/stores/devices'
import { asksBeforeClose, closeFileDoc, notePanel, useFilesStore } from '@renderer/stores/files'
import { useTerminalAllowed } from '@renderer/stores/hosts'
import { usePluginSurfaces } from '@renderer/stores/plugin-surfaces'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSideChatNews } from '@renderer/stores/side-chat'
import {
  arrangeSurfaceKeys,
  foldSurface,
  isSurfaceKind,
  moveSurfaceTab,
  recordSurfaceOrder,
  surfaceKey,
  type TabKind,
} from '@renderer/stores/surface-tabs'
import {
  createTerminal,
  forgetTerminal,
  killTerminal,
  renameTerminal,
  showTerminal,
  terminalsOf,
  toggleSplit,
  useTerminalsStore,
  type TerminalState,
} from '@renderer/stores/terminals'
import {
  closeDoc,
  closeSidePanel,
  docKey,
  isDocKind,
  keepDoc,
  noteSelectedTab,
  panelSession,
  removeSideTab,
  selectDoc,
  toggleSidePane,
  toggleTerminal,
  useViewStore,
  type DocTab,
} from '@renderer/stores/view'
import { usePhoneWindow } from './narrow'
import { SurfaceList, SurfaceMenuItems } from './surface-list'
import {
  focusSurfaceList,
  startArtifact,
  startPluginPane,
  startSurface,
  SURFACE_ICON,
  useArtifactChoices,
  usePluginPaneChoices,
  useSurfaceRows,
  type SurfaceRowId,
} from './surface-rows'
import { PaneBody, PaneEmpty, PaneIcon, PaneSpinner, PanelButton } from './panel-button'
import { CornerControlsSpace } from './top-bar'

// The row of tabs at the top of a session's side panel: every terminal, page, device and pane the
// session has open there.

/** Below this width the tabs not selected keep only their icon. */
const MIN_TAB_PX = 72
/** Only a start that takes a while shows its Starting tab, so a quick one shows its tab at once. */
const SLOW_START_MS = 400

type Tone = 'fox' | 'live' | 'info' | 'warning' | 'neutral' | 'danger'

/** One tab of the row, whatever its kind. */
interface SurfaceItem {
  key: string
  kind: TabKind
  id: string
  name: string
  /** What tells two tabs of one name apart: the folder of a file. */
  note: string
  /** The preview tab, in italics, which the next single click in a list replaces. */
  preview: boolean
  /** What a file, diff or artifact tab shows. */
  doc: DocTab | null
  /** The tooltip: the name, then what the tab is doing or who uses it. */
  title: string
  selected: boolean
  /** Who uses it in the turn that runs, drawn on the whole tab. */
  control: Exclude<SurfaceControl['kind'], 'idle'> | null
  icon: ReactNode
  /** A mark after the name: new output, a password prompt, a run, a device's state. */
  dot: { tone: Tone; label: string } | null
  /** A terminal's exit code once its shell exited. */
  code: number | null
  /** How many of the board's sub-agents wait for the user. */
  needs: number
  /** A browser tab released to save memory. */
  dim: boolean
  terminal: TerminalState | null
  /** The session's agent, which a terminal or tab the user opened can be shared with. */
  agent: string
  /** A terminal or tab the user opened that the agent may use, which the menu can take back. */
  shared: boolean
}

// How far back from the thread's end a card asking for a tab is looked for: it waits at the end.
const ASKING_LOOKBACK = 60

/** The browser tabs a card in the thread asks the user to let the agent use, by id. */
function askedTabs(sessionId: string | null): string {
  if (!sessionId) return ''
  const state = useThreadsStore.getState().replicas[sessionId]?.state
  if (!state) return ''
  const ids: string[] = []
  for (const id of state.order.slice(-ASKING_LOOKBACK)) {
    const entry = state.byId[id]
    if (
      entry?.kind === 'surface_access' &&
      entry.surface === 'browser' &&
      entry.decision === null
    ) {
      ids.push(entry.targetId)
    }
  }
  return ids.join('\n')
}

const MENTION_OF = { terminal: 'terminal', browser: 'page', devices: 'device' } as const

/** Which kinds the session can open in the row. */
interface SurfaceKinds {
  terminal: boolean
  browser: boolean
  devices: boolean
}

function useSurfaceKinds(panel: string, projectPath: string): SurfaceKinds {
  const sessionId = panelSession(panel)
  const terminal = useTerminalAllowed(projectPath)
  const remote = hostOfPath(projectPath) !== null
  const devices = useDevicesStore(
    (s) =>
      !!sessionId &&
      (!s.environment ||
        s.environment.ios ||
        s.environment.android ||
        s.devices.some((device) => device.sessionId === sessionId)),
  )
  // The browser runs in the desktop app, for another host's agents too; a web page has none.
  return { terminal, browser: !isWeb && !!sessionId, devices: devices && !remote }
}

function controlOf(control: SurfaceControl | undefined): SurfaceItem['control'] {
  return control && control.kind !== 'idle' ? control.kind : null
}

const TONE_OF = {
  neutral: 'neutral',
  info: 'info',
  warning: 'warning',
  error: 'danger',
} as const

const NOT_A_DOC = { note: '', preview: false, doc: null } as const
const NO_DOCS: DocTab[] = []

/** The panel's file, diff and artifact tabs. */
function useDocItems(panel: string, projectPath: string, hostId: string | null): SurfaceItem[] {
  const { t, i18n } = useTranslation(['shell', 'files'])
  const surfaces = usePluginSurfaces(hostId)
  const docs = useViewStore((s) => s.sideDocs[panel] ?? NO_DOCS)
  const shown = useViewStore((s) => (isDocKind(s.sidePane[panel]) ? s.sideDoc[panel] : undefined))
  const files = useFilesStore((s) => s.open[projectPath])
  const artifacts = useArtifactsStore((s) => s.list)
  const sessionId = panelSession(panel)
  const sessionAgent = useSessionsStore((s) => (sessionId ? s.byId[sessionId]?.agentId : null))

  return useMemo(() => {
    const agent = sessionAgent ? agentName(sessionAgent, hostId) : ''
    // Two tabs of one kind and one name tell themselves apart by their folder.
    const fileOf = (tab: DocTab) => (tab.kind === 'diff' ? tab.path : tab.id)
    const names = new Map<string, number>()
    for (const tab of docs) {
      if (tab.kind === 'artifact' || tab.kind === 'plugin') continue
      const name = `${tab.kind}:${nameOf(fileOf(tab))}`
      names.set(name, (names.get(name) ?? 0) + 1)
    }
    return docs.map((tab): SurfaceItem => {
      const key = docKey(tab)
      const item = {
        key,
        kind: tab.kind,
        id: tab.id,
        preview: tab.preview,
        doc: tab,
        selected: shown === key,
        control: null,
        code: null,
        needs: 0,
        dim: false,
        terminal: null,
        agent,
        shared: false,
      }
      if (tab.kind === 'artifact') {
        const artifact = artifacts?.find((other) => other.id === tab.id)
        const kind = artifact ? artifactKind(artifact) : null
        const name = artifact?.title || t('shell:surfaces.list.artifact')
        return {
          ...item,
          name,
          note: '',
          title: name,
          icon: <PaneIcon icon={kind ? KIND_ICON[kind] : ShapesIcon} size={14} />,
          dot: null,
        }
      }
      if (tab.kind === 'plugin') {
        // A plugin that is gone has no name to give, so the tab goes by its view's id.
        const surface = surfaces.plugins.find((plugin) => plugin.pluginId === tab.pluginId)
        const pane = surface?.panes.find((view) => view.id === tab.viewId)
        const name = (pane && languageText(pane.title, i18n.language)) || tab.viewId
        return {
          ...item,
          name,
          note: '',
          title: surface ? `${name} \u00b7 ${surfaceTitle(surface, i18n.language)}` : name,
          icon: (
            <PluginTile
              name={surface?.name ?? tab.pluginId}
              icon={surface?.icon ?? null}
              size={14}
            />
          ),
          dot: null,
        }
      }
      const path = fileOf(tab)
      const name = nameOf(path)
      const note = names.get(`${tab.kind}:${name}`)! > 1 ? nameOf(folderOf(path)) : ''
      if (tab.kind === 'diff') {
        return {
          ...item,
          name,
          note,
          title: [
            tab.oldPath ? `${tab.oldPath} \u2192 ${path}` : path,
            tab.ref ? tab.ref.slice(0, 7) : t('shell:surfaces.uncommitted'),
          ].join(' \u00b7 '),
          icon: <PaneIcon icon={GitCompareIcon} size={14} />,
          dot: null,
        }
      }
      // A file of the agent's own folder carries the agent's mark, and says whose it is.
      const owner = tab.agent ? agentName(tab.agent.agentId, hostId) : null
      const dirty = !!files?.some((file) => file.path === tab.id && file.dirty)
      return {
        ...item,
        name,
        note,
        title: owner ? `${path}\n${t('files:tabs.agentFile', { agent: owner })}` : path,
        icon: tab.agent ? (
          <AgentMark agent={tab.agent.agentId} hostId={hostId} size={14} dot={null} />
        ) : (
          <FileTypeIcon path={path} className="size-3.5 shrink-0" />
        ),
        dot: dirty ? { tone: 'neutral', label: t('files:preview.unsaved') } : null,
      }
    })
  }, [t, i18n.language, docs, shown, files, artifacts, surfaces.plugins, sessionAgent, hostId])
}

/** The tabs of the kinds a session has one of, in the order they opened. */
function useSingleItems(panel: string, hostId: string | null): SurfaceItem[] {
  const { t } = useTranslation(['shell', 'board', 'browser'])
  const { t: tb } = useTranslation('browser')
  const sessionId = panelSession(panel)
  const shown = useViewStore((s) => s.sidePane[panel])
  const tabs = useViewStore((s) => s.sideTabs[panel])
  const activity = useBoardActivity(sessionId ?? '')
  const boardNews = useBoardNews(sessionId)
  const chatNews = useSideChatNews(sessionId)
  const computer = useSessionView(sessionId ?? '')?.computer?.control
  const sessionAgent = useSessionsStore((s) => (sessionId ? s.byId[sessionId]?.agentId : null))

  return useMemo(() => {
    const agent = sessionAgent ? agentName(sessionAgent, hostId) : ''
    return (tabs ?? []).map((kind): SurfaceItem => {
      const selected = shown === kind
      const name = t(`shell:surfaces.list.${kind}`)
      const dot: SurfaceItem['dot'] =
        kind === 'board' && boardNews === 'news' && activity.needs === 0
          ? { tone: 'fox', label: t('shell:surfaces.news') }
          : kind === 'sideChat' && chatNews
            ? { tone: 'fox', label: t('shell:headerTools.sideChatNews') }
            : null
      const control: SurfaceItem['control'] =
        kind === 'computer' && computer ? (computer === 'you' ? 'you' : 'agent') : null
      const needs = kind === 'board' && !selected ? activity.needs : 0
      return {
        key: surfaceKey(kind),
        kind,
        id: '',
        name,
        ...NOT_A_DOC,
        title: [
          name,
          control ? tb(CONTROL_NOTE[control], { agent }) : dot?.label,
          needs > 0 ? t('board:summary.needs', { count: needs }) : null,
        ]
          .filter(Boolean)
          .join(' \u00b7 '),
        selected,
        control,
        icon: <PaneIcon icon={SURFACE_ICON[kind]} size={14} />,
        dot,
        code: null,
        needs,
        dim: false,
        terminal: null,
        agent,
        shared: false,
      }
    })
  }, [t, tb, tabs, shown, activity.needs, boardNews, chatNews, computer, sessionAgent, hostId])
}

/** The panel's tabs in the row's order, with what each shows and who uses it. */
function useSurfaceItems(panel: string, projectPath: string, kinds: SurfaceKinds): SurfaceItem[] {
  const { t } = useTranslation(['terminal', 'browser', 'devices', 'shell'])
  const { t: td } = useTranslation('devices')
  const { t: tb } = useTranslation('browser')
  const sessionId = panelSession(panel)
  const hostId = hostOfPath(projectPath)
  const shown = useViewStore((s) => s.sidePane[panel])
  const terminals = useTerminalsStore(
    useShallow((s) => (kinds.terminal ? terminalsOf(s.byId, panel, s.order[panel]) : [])),
  )
  const activeId = useTerminalsStore((s) => s.active[panel])
  const rightId = useTerminalsStore((s) => s.split[panel] ?? null)
  const controls = useTerminalsStore((s) => s.controls)
  const browser = useBrowserStore((s) =>
    kinds.browser && sessionId ? s.bySession[sessionId] : undefined,
  )
  const devices = useDevicesStore((s) => s.devices)
  const deviceId = useDevicesStore((s) => (sessionId ? s.selected[sessionId] : undefined))
  const opening = useDevicesStore((s) => (sessionId ? s.opening[sessionId] : undefined))
  const streams = useDevicesStore((s) => s.streams)
  const recording = useDevicesStore((s) => s.recording?.deviceId ?? null)
  const sessionAgent = useSessionsStore((s) => (sessionId ? s.byId[sessionId]?.agentId : null))
  // Read on each thread change from the end only, where a card that waits sits.
  const askingTabs = useThreadsStore(() => askedTabs(sessionId))
  const order = useViewStore((s) => s.sideOrder[panel])
  const singles = useSingleItems(panel, hostId)
  const docs = useDocItems(panel, projectPath, hostId)

  const items = useMemo(() => {
    const agent = (id: AgentId | null | undefined) => (id ? agentName(id, hostId) : '')
    const note = (control: NonNullable<SurfaceItem['control']>, name: string) =>
      tb(CONTROL_NOTE[control], { agent: name })
    const list: SurfaceItem[] = []
    // A split shows two terminals; alone, the left one is the active one or the newest.
    const right = terminals.find((terminal) => terminal.id === rightId) ?? null
    const active =
      terminals.find((terminal) => terminal.id === activeId) ??
      terminals.filter((terminal) => terminal.id !== right?.id).at(-1)
    for (const terminal of terminals) {
      const selected =
        shown === 'terminal' &&
        (terminal.id === active?.id || (!!right && terminal.id === right.id))
      const exited = terminal.exitCode !== null
      const dot: SurfaceItem['dot'] =
        terminal.waiting === 'password' && !terminal.stale
          ? { tone: 'fox', label: t('terminal:tab.password') }
          : terminal.activity && !selected
            ? { tone: 'fox', label: t('terminal:tab.newOutput') }
            : terminal.busy && !exited
              ? { tone: 'live', label: t('terminal:tab.running') }
              : null
      // While a card asks whether the agent may use it, the tab breathes as for a step it asks.
      const control = controlOf(controls[terminal.id]) ?? (terminal.agentAsks ? 'asks' : null)
      const automatic = terminal.title || terminal.shell
      const name = terminal.name ?? automatic
      const owner = terminal.owner ? agent(terminal.owner.agentId) : null
      const shared =
        !terminal.owner && terminal.agentAllowed
          ? t('shell:surfaces.shared', { agent: agent(sessionAgent) })
          : null
      list.push({
        key: surfaceKey('terminal', terminal.id),
        kind: 'terminal',
        id: terminal.id,
        name,
        ...NOT_A_DOC,
        title: [
          terminal.name ? automatic : name,
          control ? note(control, owner ?? agent(sessionAgent)) : (owner ?? shared),
          dot?.label,
        ]
          .filter(Boolean)
          .join(' · '),
        selected,
        control,
        icon: <PaneIcon icon={SURFACE_ICON.terminal} size={14} />,
        dot,
        code: exited ? terminal.exitCode : null,
        needs: 0,
        dim: false,
        terminal,
        agent: agent(sessionAgent),
        shared: !terminal.owner && terminal.agentAllowed,
      })
    }
    const asking = new Set(askingTabs.split('\n'))
    for (const tab of browser?.tabs ?? []) {
      const control =
        tab.id === browser?.agentTab
          ? controlOf(browser.control)
          : asking.has(tab.id)
            ? ('asks' as const)
            : null
      const shared = tab.by === 'user' && tab.allowed
      const name =
        tab.title || (tab.url ? (addressText(tab.url) ?? tab.url) : t('browser:tabs.blank'))
      list.push({
        key: surfaceKey('browser', tab.id),
        kind: 'browser',
        id: tab.id,
        name,
        ...NOT_A_DOC,
        title: [
          name,
          control
            ? note(control, agent(sessionAgent))
            : tab.released
              ? t('browser:tabs.releasedNote')
              : tab.url,
          shared ? t('shell:surfaces.shared', { agent: agent(sessionAgent) }) : null,
        ]
          .filter(Boolean)
          .join(' · '),
        selected: shown === 'browser' && tab.id === browser?.selected,
        control,
        icon: tab.loading ? <PaneSpinner /> : <SiteMark url={tab.url} />,
        dot: null,
        code: null,
        needs: 0,
        dim: tab.released,
        terminal: null,
        agent: agent(sessionAgent),
        shared,
      })
    }
    if (kinds.devices) {
      const held = devicesOf(devices, sessionId)
      const chosen = held.find((device) => device.id === deviceId) ?? held[0] ?? null
      for (const device of held) {
        const selected = shown === 'devices' && device.id === chosen?.id
        const status = statusOf(
          td,
          device,
          device.id === chosen?.id ? streams[device.id] : undefined,
          device.id === opening,
        )
        const control = controlOf(device.operator?.control)
        const dot: SurfaceItem['dot'] =
          recording === device.id
            ? { tone: 'danger', label: t('shell:surfaces.recording') }
            : status
              ? { tone: TONE_OF[status.variant], label: status.label }
              : null
        list.push({
          key: surfaceKey('devices', device.id),
          kind: 'devices',
          id: device.id,
          name: device.name,
          ...NOT_A_DOC,
          title: [device.name, control ? note(control, agent(sessionAgent)) : dot?.label]
            .filter(Boolean)
            .join(' · '),
          selected,
          control,
          icon: <PaneIcon icon={markOf(device)} size={14} />,
          dot,
          code: null,
          needs: 0,
          dim: false,
          terminal: null,
          agent: agent(sessionAgent),
          shared: false,
        })
      }
    }
    list.push(...singles, ...docs)
    const byKey = new Map(list.map((item) => [item.key, item]))
    return arrangeSurfaceKeys(
      order,
      list.map((item) => item.key),
    ).map((key) => byKey.get(key)!)
  }, [
    t,
    td,
    tb,
    hostId,
    sessionId,
    sessionAgent,
    shown,
    terminals,
    activeId,
    rightId,
    controls,
    browser,
    kinds.devices,
    devices,
    deviceId,
    opening,
    streams,
    recording,
    order,
    askingTabs,
    singles,
    docs,
  ])

  // The row remembers where each tab is, so the next one opens after them all.
  const keys = items.map((item) => item.key).join('\n')
  useEffect(() => {
    recordSurfaceOrder(panel, keys ? keys.split('\n') : [])
  }, [panel, keys])

  // A tab opened from a list in the panel goes right after the selected one.
  const selected = items.find((item) => item.selected)?.key ?? null
  useEffect(() => {
    noteSelectedTab(panel, selected)
  }, [panel, selected])

  return items
}

/** What a tab's tooltip says about who uses it. */
const CONTROL_NOTE = {
  agent: 'tabs.agentUsing',
  you: 'tabs.agentWaiting',
  asks: 'tabs.agentAsks',
} as const

/** Shows a tab: its kind in the panel, and the tab within a kind of several. */
function selectSurface(panel: string, item: Pick<SurfaceItem, 'kind' | 'id' | 'key'>): void {
  const sessionId = panelSession(panel)
  if (isDocKind(item.kind)) return selectDoc(panel, item.key)
  toggleSidePane(panel, item.kind, true)
  if (item.kind === 'terminal') showTerminal(panel, item.id)
  else if (item.kind === 'browser') {
    if (sessionId) void window.kettu.browser.selectTab(sessionId, item.id)
  } else if (sessionId) selectDevice(sessionId, item.id)
}

/** Whether the row's measure of its tabs says only icons fit, and how wide the others may be. */
function useRowFit(signature: string): {
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
      // Every tab at its full width once, the selected one included, which always keeps it.
      row.dataset.measuring = ''
      const tabs = [...row.querySelectorAll<HTMLElement>(':scope > .kp-stab')]
      const widths = tabs.map((tab) => tab.offsetWidth)
      delete row.dataset.measuring
      const selected = tabs.findIndex((tab) => tab.dataset.selected !== undefined)
      // The count shows only while icons alone fit, so it must not keep the row that way.
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
      // Long names give way first: the others share what is left, each up to its own width.
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

/** Whether closing the tab ends something that runs, which asks first. */
function endsRun(item: SurfaceItem): boolean {
  const terminal = item.terminal
  return !!terminal && !terminal.stale && terminal.busy && terminal.exitCode === null
}

/**
 * The side panel's head: the row of every tab the session has open, then **+**, and at its right
 * end the count that lists them all while only icons fit, Maximize and the side panel's button.
 * It is as tall as the session's top bar and continues its line.
 */
export function SurfaceTabs({
  panel,
  projectPath,
  maximized,
}: {
  panel: string
  projectPath: string
  maximized: boolean
}) {
  const { t } = useTranslation(['shell', 'terminal', 'browser', 'devices', 'common'])
  const sessionId = panelSession(panel)
  const kinds = useSurfaceKinds(panel, projectPath)
  const items = useSurfaceItems(panel, projectPath, kinds)
  useGonePluginPanes(panel, hostOfPath(projectPath))
  const browserTabs = useBrowserStore((s) => (sessionId ? s.bySession[sessionId]?.tabs.length : 0))
  // Tabs whose close waits for the user's answer, the first one asked about.
  const [closing, setClosing] = useState<SurfaceItem[]>([])
  const [starting, setStarting] = useState(false)
  const sheetRef = useRef<HTMLElement | null>(null)
  const signature = items
    .map(
      (item) =>
        `${item.key}|${item.name}|${item.note}|${item.selected}|${item.dot?.tone}|${item.code}|${item.needs}`,
    )
    .join('\n')
  const { stripRef, tight } = useRowFit(`${signature}|${starting}`)
  const shown = useViewStore((s) => s.sidePane[panel])
  const pages = items.filter((item) => item.kind === 'browser').length
  const devices = items.filter((item) => item.kind === 'devices').length
  const before = useRef({ pages, devices })
  // On macOS, maximized with the sidebar collapsed, the head is the window's top left corner; on a
  // phone the panel always covers the area and the corner always holds the sidebar's toggle.
  const phone = usePhoneWindow()
  const cornered = (useViewStore((s) => s.sidebarCollapsed) || phone) && maximized && !hasBand

  // Files are read and kept by project; the row says which project its panel's tabs are of.
  useEffect(() => notePanel(panel, projectPath), [panel, projectPath])

  // The pages an earlier run left open come back once their row shows.
  useEffect(() => {
    if (sessionId && kinds.browser) void restorePages(sessionId)
  }, [sessionId, kinds.browser])

  // A page or device kind that loses its last tab some other way, such as the agent closing the
  // page or the device leaving, gives way to the row's other tabs. The terminals' store does this
  // for its own; a kind still opening its first tab has had none, so it stays.
  useEffect(() => {
    const was = before.current
    before.current = { pages, devices }
    if (shown === 'browser' && was.pages > 0 && pages === 0) foldSurface(panel, 'browser')
    if (shown === 'devices' && was.devices > 0 && devices === 0) foldSurface(panel, 'devices')
  }, [shown, pages, devices, panel])

  // Ends what the tab holds, or for a kind of one only takes its tab off the row.
  const drop = useCallback(
    (item: SurfaceItem, pagesLeft: number) => {
      if (item.kind === 'terminal') {
        if (!item.terminal) return
        if (item.terminal.stale) forgetTerminal(item.id)
        else void killTerminal(item.id)
      } else if (item.kind === 'browser') {
        if (!sessionId) return
        // The last tab closes the page with it.
        if (pagesLeft > 1) void window.kettu.browser.closeTab(sessionId, item.id)
        else void window.kettu.browser.close(sessionId)
      } else if (item.kind === 'devices') {
        if (sessionId) void closeDevice(sessionId, item.id)
      } else if (item.doc?.kind === 'artifact' || item.doc?.kind === 'plugin') {
        closeDoc(panel, item.key)
      } else if (item.doc) closeFileDoc(panel, projectPath, item.doc)
      else if (!isDocKind(item.kind)) removeSideTab(panel, item.kind)
    },
    [panel, projectPath, sessionId],
  )

  // The selected tab hands the panel to its neighbour, of any kind; the last one to the list.
  const close = useCallback(
    (item: SurfaceItem) => {
      if (item.selected) {
        const index = items.findIndex((other) => other.key === item.key)
        const neighbor = [...items.slice(index + 1), ...items.slice(0, index).reverse()].find(
          (other) => !other.selected,
        )
        if (neighbor) selectSurface(panel, neighbor)
        else toggleSidePane(panel, 'surfaces', true)
      }
      drop(item, browserTabs ?? 0)
    },
    [items, panel, browserTabs, drop],
  )

  // A shell still running asks first, as do a file with unsaved edits and an artifact with
  // comments not sent yet.
  const requestClose = useCallback(
    (item: SurfaceItem) => {
      if (endsRun(item)) setClosing((waiting) => [...waiting, item])
      else if (item.kind === 'file' && asksBeforeClose(panel, projectPath, item.id)) return
      else if (item.kind !== 'artifact' || mayLeave(item.id)) close(item)
    },
    [close, panel, projectPath],
  )

  // Close others and Close to the right: `keep` takes the panel when the selected tab goes.
  const closeMany = useCallback(
    (targets: SurfaceItem[], keep: SurfaceItem) => {
      // Files with unsaved edits stay; each is closed on its own, which asks about it.
      const going = targets.filter((item) =>
        item.kind === 'artifact' ? mayLeave(item.id) : !(item.kind === 'file' && item.dot),
      )
      if (going.some((item) => item.selected)) selectSurface(panel, keep)
      let pagesLeft = browserTabs ?? 0
      for (const item of going.filter((other) => !endsRun(other))) {
        drop(item, pagesLeft)
        if (item.kind === 'browser') pagesLeft -= 1
      }
      setClosing((waiting) => [...waiting, ...going.filter(endsRun)])
    },
    [panel, browserTabs, drop],
  )

  // Mod+W closes the selected tab; in a split the focused side's terminal goes.
  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.kind !== 'close-side-tab') return
        const terminals = useTerminalsStore.getState()
        const right = terminals.split[panel] ?? null
        const focused = terminals.focusedSide[panel] === 'right' && right ? right : null
        const target = items.find(
          (item) =>
            item.selected &&
            (item.kind !== 'terminal' || (focused ? item.id === focused : item.id !== right)),
        )
        if (target) requestClose(target)
        else toggleSidePane(panel, 'surfaces', true)
      }),
    [items, requestClose, panel],
  )

  const newTerminal = () => {
    toggleTerminal(panel, true)
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
    const key = String(source.id)
    if (source.index !== source.initialIndex) {
      // Dragging the preview tab keeps it.
      keepDoc(panel, key)
      moveSurfaceTab(
        panel,
        items.map((item) => item.key),
        key,
        source.index,
      )
      return
    }
    // The sensor reads a press held for 200 ms as a drag and drops the click, so select here.
    const item = items.find((other) => other.key === key)
    if (item && event.nativeEvent?.type.startsWith('pointer')) selectSurface(panel, item)
  }

  const asked = closing[0] ?? null
  return (
    <div className={cn('kp-head app-region-drag', cornered && 'kp-head--cornered')}>
      {cornered && <CornerControlsSpace className="mr-1" />}
      <div className="kp-head__main">
        <DragDropProvider sensors={tabSensors} onDragEnd={dragEnded}>
          <div
            ref={(element) => {
              stripRef.current = element
              sheetRef.current = element?.closest<HTMLElement>('.kp-pane') ?? null
            }}
            role="tablist"
            aria-label={t('shell:surfaces.tabs')}
            className="kp-stabs"
            data-tight={tight || undefined}
          >
            {items.map((item, index) => (
              <SurfaceTab
                key={item.key}
                panel={panel}
                projectPath={projectPath}
                item={item}
                index={index}
                onSelect={() => selectSurface(panel, item)}
                onClose={() => requestClose(item)}
                onCloseOthers={
                  items.length > 1
                    ? () =>
                        closeMany(
                          items.filter((other) => other.key !== item.key),
                          item,
                        )
                    : null
                }
                onCloseRight={
                  index < items.length - 1 ? () => closeMany(items.slice(index + 1), item) : null
                }
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
        <AddMenu
          panel={panel}
          projectPath={projectPath}
          listShown={shown === 'surfaces'}
          onTerminal={newTerminal}
        />
      </div>
      <div className="kp-head__tools app-region-no-drag">
        {tight && <CountMenu items={items} onSelect={(item) => selectSurface(panel, item)} />}
        {!phone && (
          <PanelButton
            label={maximized ? t('common:pane.restore') : t('common:pane.maximize')}
            onClick={() => useViewStore.setState({ sidePaneMaximized: !maximized })}
          >
            <PaneIcon icon={maximized ? ArrowShrink01Icon : ArrowExpand01Icon} />
          </PanelButton>
        )}
        <PanelButton
          label={t('common:pane.collapse')}
          pressed
          className="kp-head__toggle"
          onClick={() => closeSidePanel(panel)}
        >
          <PaneIcon icon={SidebarRightIcon} size={16} />
        </PanelButton>
      </div>
      <UnsavedPrompt
        panel={panel}
        onClose={(path) => {
          const item = items.find((other) => other.kind === 'file' && other.id === path)
          if (item) close(item)
        }}
      />
      <EndTerminal
        container={sheetRef}
        closing={asked}
        onCancel={() => setClosing((waiting) => waiting.slice(1))}
        onConfirm={() => {
          // Its place in the row as it is now: a tab closed meanwhile leaves nothing to end.
          const item = asked && items.find((other) => other.key === asked.key)
          if (item) close(item)
          setClosing((waiting) => waiting.slice(1))
        }}
      />
    </div>
  )
}

/**
 * One tab: its kind's icon, which turns into the close button on hover or focus, the name, a
 * mark after it, and who uses it drawn on the whole tab. A terminal's is renamed in place.
 */
function SurfaceTab({
  panel,
  projectPath,
  item,
  index,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseRight,
}: {
  panel: string
  projectPath: string
  item: SurfaceItem
  index: number
  onSelect: () => void
  onClose: () => void
  /** Null where the row has no other tab, or none after this one. */
  onCloseOthers: (() => void) | null
  onCloseRight: (() => void) | null
}) {
  const { t } = useTranslation(['terminal', 'browser', 'devices', 'common', 'shell'])
  const [editing, setEditing] = useState(false)
  const button = useRef<HTMLButtonElement | null>(null)
  const refocus = useRef(false)
  const renameAfterMenu = useRef(false)
  const { ref, handleRef, isDragging } = useSortable({ id: item.key, index, disabled: editing })
  // The tab's button is the drag handle, so a press on the close button never starts a drag.
  const setButton = useCallback(
    (element: HTMLButtonElement | null) => {
      button.current = element
      handleRef(element)
    },
    [handleRef],
  )
  const terminal = item.terminal
  const split = useTerminalsStore((s) => (terminal ? !!s.split[panel] : false))

  // A full row scrolls; a tab selected out of sight, such as one an agent opens, comes into view.
  useEffect(() => {
    if (item.selected) button.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [item.selected])

  useEffect(() => {
    if (editing || !refocus.current) return
    refocus.current = false
    button.current?.focus()
  }, [editing])

  const finishRename = (value: string | null, restoreFocus: boolean) => {
    if (value !== null && terminal) void renameTerminal(terminal.id, value)
    refocus.current = restoreFocus
    setEditing(false)
  }

  const closeLabel =
    item.kind === 'devices'
      ? t('devices:actions.disconnect', { name: item.name })
      : t('browser:actions.closeTab', { name: item.name })
  const mention = isSurfaceKind(item.kind) ? MENTION_OF[item.kind] : null

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
        className="kp-stab"
        data-kind={item.kind}
        data-selected={item.selected || undefined}
        data-control={item.control ?? undefined}
        data-dragging={isDragging || undefined}
        data-editing={editing || undefined}
        data-dim={item.dim || undefined}
        data-preview={item.preview || undefined}
      >
        {/* Stays mounted while renaming, hidden under the input, so the tab keeps its width. */}
        <button
          ref={setButton}
          type="button"
          role="tab"
          aria-selected={item.selected}
          title={item.title}
          onClick={onSelect}
          onDoubleClick={() => (terminal ? setEditing(true) : keepDoc(panel, item.key))}
          onAuxClick={(event) => event.button === 1 && onClose()}
          className="kp-stab__btn"
          style={editing ? { visibility: 'hidden' } : undefined}
        >
          <span className="kp-stab__icon">
            {item.icon}
            {(item.dot || item.needs > 0) && (
              <span aria-hidden className="kp-stab__badge" data-tone={item.dot?.tone ?? 'fox'} />
            )}
          </span>
          <span className="kp-stab__name">
            {item.name}
            {item.note && <span className="kp-stab__note"> {item.note}</span>}
          </span>
          {item.code !== null && (
            <span className="kp-stab__code" data-failed={item.code !== 0 || undefined}>
              {item.code}
            </span>
          )}
          {item.needs > 0 && <span className="kp-stab__needs">{item.needs}</span>}
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
          <TabNameInput
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
        {terminal && (
          <>
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
                // Splitting sets a new terminal beside this one; unsplitting starts nothing.
                if (!split) onSelect()
                void toggleSplit(projectPath, panel)
              }}
            >
              <PaneIcon icon={Layout2ColumnIcon} size={16} />
              {split ? t('terminal:panel.unsplit') : t('terminal:panel.split')}
            </ContextMenuItem>
          </>
        )}
        {mention && (
          <ContextMenuItem
            onClick={() =>
              emitAppEvent({
                kind: 'mention-into-composer',
                draft: panelSession(panel) ?? NEW_SESSION_DRAFT,
                mention: surfaceMention(mention, item.id),
              })
            }
          >
            <PaneIcon icon={MessageAdd01Icon} size={16} />
            {t('shell:surfaces.reference')}
          </ContextMenuItem>
        )}
        {item.shared && (
          <ContextMenuItem
            onClick={() => {
              const sessionId = terminal?.sessionId ?? panelSession(panel)
              if (!sessionId) return
              if (terminal) {
                void host('terminals.revokeAccess', { sessionId, terminalId: terminal.id })
              } else if (item.kind === 'browser') {
                void window.kettu.browser.revokeTab(sessionId, item.id)
              }
            }}
          >
            <PaneIcon icon={UnavailableIcon} size={16} />
            {t('shell:surfaces.stopSharing', { agent: item.agent })}
          </ContextMenuItem>
        )}
        {item.preview && (
          <ContextMenuItem onClick={() => keepDoc(panel, item.key)}>
            <PaneIcon icon={PinIcon} size={16} />
            {t('shell:surfaces.keep')}
          </ContextMenuItem>
        )}
        {(terminal || mention || item.shared || item.preview) && <ContextMenuSeparator />}
        <ContextMenuItem onClick={onClose}>
          <PaneIcon icon={Cancel01Icon} size={16} />
          {item.kind === 'devices' ? closeLabel : t('common:actions.close')}
        </ContextMenuItem>
        <ContextMenuItem disabled={!onCloseOthers} onClick={() => onCloseOthers?.()}>
          <PaneIcon icon={CancelCircleIcon} size={16} />
          {t('shell:surfaces.closeOthers')}
        </ContextMenuItem>
        <ContextMenuItem disabled={!onCloseRight} onClick={() => onCloseRight?.()}>
          <PaneIcon icon={ArrowRight01Icon} size={16} />
          {t('shell:surfaces.closeRight')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** A terminal tab's label as a text field over the tab. Enter or a blur accepts; Esc cancels. */
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

/** 侧边面板 + 菜单项列表，含本机移动设备子菜单。 */
function SurfaceMenu({
  panel,
  projectPath,
  onTerminal,
}: {
  panel: string
  projectPath: string
  /** Starts a terminal in the list's place, where the row shows one that takes a while. */
  onTerminal?: () => void
}) {
  const sessionId = panelSession(panel)
  const rows = useSurfaceRows(panel, projectPath)
  const artifacts = useArtifactChoices(panel)
  const panes = usePluginPaneChoices(panel, projectPath)
  const open = useDevicesStore((s) => devicesOf(s.devices, sessionId).length)
  const full = open >= SESSION_DEVICE_LIMIT
  const devicesOn = rows.some((row) => row.id === 'devices' && !row.off)
  // The menu mounts as it opens: the host's devices are read for its Mobile device submenu.
  useEffect(() => {
    if (devicesOn) void loadDevices()
  }, [devicesOn])
  return (
    <SurfaceMenuItems
      rows={rows}
      artifacts={artifacts}
      panes={panes}
      onPick={(id: SurfaceRowId) =>
        id === 'terminal' && onTerminal ? onTerminal() : startSurface(panel, projectPath, id)
      }
      onArtifact={(id) => startArtifact(panel, id)}
      onPane={(pane) => startPluginPane(panel, pane)}
      devices={(row) =>
        sessionId && (
          <DropdownMenuSub key={row.id}>
            <DropdownMenuSubTrigger data-accelerator={row.key ?? undefined}>
              <PaneIcon icon={row.icon} size={16} />
              {row.label}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-64">
              <DeviceItems sessionId={sessionId} open={open} full={full} panel={panel} />
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )
      }
    />
  )
}

/** **+**: the side panel's list. While the panel shows the list, **+** only takes the focus to it. */
function AddMenu({
  panel,
  projectPath,
  listShown,
  onTerminal,
}: {
  panel: string
  projectPath: string
  /** The panel shows the list itself, with the same rows. */
  listShown: boolean
  onTerminal: () => void
}) {
  const { t } = useTranslation('shell')
  const trigger = (
    <button
      type="button"
      aria-label={t('surfaces.add')}
      className="kp-tool kp-tool--sm app-region-no-drag"
      onClick={listShown ? () => focusSurfaceList(panel) : undefined}
    />
  )
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger render={listShown ? trigger : <DropdownMenuTrigger render={trigger} />}>
          <PaneIcon icon={PlusSignIcon} size={14} />
        </TooltipTrigger>
        <TooltipContent>{t('surfaces.add')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        className="w-68"
        onKeyDown={(event) => runSessionMenuAccelerator(event, isMac)}
      >
        <SurfaceMenu panel={panel} projectPath={projectPath} onTerminal={onTerminal} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function DeviceItems({
  panel,
  sessionId,
  open,
  full,
}: {
  panel: string
  sessionId: string
  open: number
  full: boolean
}) {
  const { t } = useTranslation('devices')
  const groups = useAddable(sessionId)
  const pick = (device: DeviceInfo) => {
    toggleSidePane(panel, 'devices', true)
    void rowOf(device).act(sessionId)
  }
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>
          {t('add.title', { open, limit: SESSION_DEVICE_LIMIT })}
        </DropdownMenuLabel>
      </DropdownMenuGroup>
      {groups.length === 0 && (
        <div className="px-2 py-1.5 text-hint text-secondary">{t('picker.none')}</div>
      )}
      {groups.map((group) => (
        <DropdownMenuGroup key={group.title}>
          <DropdownMenuLabel>{group.title}</DropdownMenuLabel>
          {group.devices.map((device) => (
            <DropdownMenuItem key={device.id} disabled={full} onClick={() => pick(device)}>
              <DeviceRow device={device} />
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      ))}
    </>
  )
}

const KIND_ORDER = ['terminal', 'browser', 'devices', 'panes'] as const

/** The count at the row's end while only icons fit: every tab by kind, the shown one checked. */
function CountMenu({
  items,
  onSelect,
}: {
  items: SurfaceItem[]
  onSelect: (item: SurfaceItem) => void
}) {
  const { t } = useTranslation(['shell', 'browser'])
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t('browser:tabs.all')}
            title={t('browser:tabs.all')}
            className="kp-tool kp-tabcount app-region-no-drag"
          />
        }
      >
        <span>{items.length}</span>
        <PaneIcon icon={ArrowDown01Icon} size={12} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="kp-tablist">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('browser:tabs.count', { count: items.length })}</DropdownMenuLabel>
        </DropdownMenuGroup>
        {KIND_ORDER.map((kind) => {
          const own = items.filter((item) =>
            kind === 'panes' ? !isSurfaceKind(item.kind) : item.kind === kind,
          )
          if (own.length === 0) return null
          return (
            <DropdownMenuGroup key={kind}>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>{t(`shell:surfaces.kinds.${kind}`)}</DropdownMenuLabel>
              {own.map((item) => (
                <DropdownMenuItem key={item.key} onClick={() => onSelect(item)}>
                  <span className="kp-tablist__mark">{item.icon}</span>
                  <span className="kp-tablist__text">
                    <span className="kp-tablist__name">{item.name}</span>
                  </span>
                  {item.selected && (
                    <PaneIcon icon={Tick02Icon} size={14} className="kp-tablist__check" />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** "End this terminal?", asked over the panel before a running terminal's tab closes. */
function EndTerminal({
  container,
  closing,
  onCancel,
  onConfirm,
}: {
  container: RefObject<HTMLElement | null>
  closing: SurfaceItem | null
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
              components={{
                title: <span className="kp-mono text-primary">{closing?.terminal?.title}</span>,
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

/** The side panel's list in the panel itself, while its row has no tab selected. */
export function SurfacesPane({ panel, projectPath }: { panel: string; projectPath: string }) {
  const { t } = useTranslation(['shell'])
  return (
    <PaneBody>
      <div className="kp-body">
        <PaneEmpty
          icon={<PaneIcon icon={SidebarRightIcon} size={20} />}
          title={t('shell:surfaces.empty.title')}
          text={t('shell:surfaces.empty.text')}
        >
          <div className="mt-4">
            <SurfaceList panel={panel} projectPath={projectPath} />
          </div>
        </PaneEmpty>
      </div>
    </PaneBody>
  )
}
