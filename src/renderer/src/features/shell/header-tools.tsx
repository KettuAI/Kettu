import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import { Cancel01Icon, MoreHorizontalIcon, SidebarRightIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { summaryParts } from '@renderer/features/board/board-model'
import { useBoardActivity, useBoardNews } from '@renderer/features/board/use-board-activity'
import { usePane } from '@renderer/features/split/pane-context'
import {
  DeleteSessionDialog,
  SessionMenuHeader,
  SessionMenuItems,
} from '@renderer/features/sidebar/session-menu'
import { runSessionMenuAccelerator } from '@renderer/features/sidebar/session-menu-model'
import { isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useDevicesStore } from '@renderer/stores/devices'
import { useBrowserStore } from '@renderer/stores/browser'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useSideChatNews } from '@renderer/stores/side-chat'
import {
  closeSplitPane,
  focusPane,
  panelSession,
  shownPanel,
  toggleSidePane,
  useViewStore,
} from '@renderer/stores/view'
import { reopenSidePanel } from './open-surfaces'
import { requestSurfaceListFocus, SURFACE_ICON } from './surface-rows'
import { PaneIcon } from './panel-button'
import { NoDrag } from './top-bar'

/**
 * 会话顶栏右侧工具区：常驻看板和文件快捷按钮，分屏时显示关闭窗格按钮，
 * 面板收起时最右为侧边面板开关（展开后该开关移至面板标签行最右以保持同坐标）。
 */
export function HeaderTools({
  projectPath,
  panel,
  summary,
  session,
  onRename,
  onNewSubSession,
  menu,
}: {
  projectPath: string
  /** 当前会话对应的侧边面板标识，或新建会话时的面板标识。 */
  panel: string
  /** 所属会话摘要；传入 `onRename` 时额外渲染会话更多菜单。 */
  summary?: SessionSummary
  session?: SessionView
  onRename?: () => void
  onNewSubSession?: () => void
  /** 关闭会话菜单后的焦点移交配置。 */
  menu?: { finalFocus: () => boolean; onOpenChangeComplete: (open: boolean) => void }
}) {
  const sessionId = panelSession(panel)
  const pane = usePane()
  const panelOpen = useViewStore((s) => shownPanel(s) === panel && !!s.sidePane[panel])
  // 仅主会话拥有看板；新建会话尚未创建，子 Agent 页面展示父会话工作。
  const board = useSessionsStore((s) => {
    const origin = sessionId ? s.byId[sessionId]?.origin : undefined
    return origin !== undefined && origin !== 'subagent'
  })
  const ref = useRef<HTMLDivElement>(null)
  const fixedSlots = (pane?.split ? 1 : 0) + (panelOpen ? 0 : 1)
  const slots = useToolSlots(ref, fixedSlots)
  const tools = useBarTools({ panel, sessionId, board })
  const buttons = tools.slice(0, slots)
  const hidden = tools.filter((tool) => !buttons.includes(tool))
  return (
    <NoDrag ref={ref} className="kp-bar-tools">
      {summary && onRename && onNewSubSession && (
        <SessionMoreMenu
          summary={summary}
          session={session}
          onRename={onRename}
          onNewSubSession={onNewSubSession}
          menu={menu}
        />
      )}
      {buttons.map((tool) => (
        <BarButton key={tool.id} label={tool.label} pressed={tool.open} onClick={tool.onSelect}>
          <PaneIcon icon={tool.icon} size={16} />
          {tool.dot && <span aria-hidden className={dotClass(tool.dot)} />}
        </BarButton>
      ))}
      <ClosePaneButton />
      <SidePanelButton panel={panel} projectPath={projectPath} hiddenTools={hidden} />
    </NoDrag>
  )
}

/** 顶栏快捷按钮定义，对应侧边面板中的常用标签。 */
interface Tool {
  id: 'board' | 'files'
  /** 悬停提示文案，必要时附带运行与待处理摘要。 */
  label: string
  icon: IconSvgElement
  /** 对应标签当前正在侧边面板展示。 */
  open: boolean
  dot?: 'news' | 'needs'
  onSelect: () => void
}

/** 单个快捷按钮占位宽度及为标题保留的最小宽度。 */
const TOOL_SLOT = 30
const BAR_RESERVE = 150

/** 计算顶栏在保证标题可读的前提下最多可容纳的快捷按钮数量。 */
function useToolSlots(ref: RefObject<HTMLElement | null>, fixedSlots: number): number {
  const [slots, setSlots] = useState(Number.POSITIVE_INFINITY)
  useLayoutEffect(() => {
    const bar = ref.current?.closest('header')
    if (!bar) return
    const measure = () => {
      const style = getComputedStyle(bar)
      const room =
        bar.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight) -
        BAR_RESERVE
      setSlots(Math.max(0, Math.floor(room / TOOL_SLOT) - fixedSlots))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [ref, fixedSlots])
  return slots
}

/** 顶栏快捷按钮列表：依次为看板和文件。 */
function useBarTools({
  panel,
  sessionId,
  board,
}: {
  panel: string
  sessionId: string | null
  board: boolean
}): Tool[] {
  const { t } = useTranslation('shell')
  const { t: tb } = useTranslation('board')
  const context = usePane()
  const shownPane = useViewStore((s) => (shownPanel(s) === panel ? s.sidePane[panel] : undefined))
  const activity = useBoardActivity(sessionId ?? '')
  const boardNews = useBoardNews(sessionId)
  // 选中标签并打开面板；非焦点分屏点击时先聚焦该分屏。
  const select = (id: Tool['id']) => () => {
    if (context && !context.focused) focusPane(context.paneId)
    toggleSidePane(panel, id, true)
  }
  const tools: Tool[] = []
  if (board && sessionId) {
    const parts = summaryParts(tb, activity)
    tools.push({
      id: 'board',
      label: [t('headerTools.board'), parts.running, parts.needs].filter(Boolean).join(' \u00b7 '),
      icon: SURFACE_ICON.board,
      open: shownPane === 'board',
      dot: boardNews,
      onSelect: select('board'),
    })
  }
  tools.push({
    id: 'files',
    label: t('headerTools.files'),
    icon: SURFACE_ICON.files,
    open: shownPane === 'files',
    onSelect: select('files'),
  })
  return tools
}

function dotClass(dot: 'news' | 'needs'): string {
  return dot === 'needs' ? 'kp-bar-dot kp-bar-dot--needs' : 'kp-bar-dot'
}

/** 分屏关闭按钮：仅在多窗格分屏时显示，单窗格不显示 ×。 */
export function ClosePaneButton() {
  const { t } = useTranslation('shell')
  const pane = usePane()
  if (!pane?.split) return null
  return (
    <BarButton
      label={t('headerTools.closePane')}
      onClick={() => closeSplitPane(pane.paneId, pane.focused)}
    >
      <PaneIcon icon={Cancel01Icon} size={16} />
    </BarButton>
  )
}

/** 顶栏 28px 图标按钮，悬停展示提示。 */
function BarButton({
  label,
  notices,
  pressed,
  onClick,
  children,
}: {
  label: string
  notices?: readonly string[]
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}) {
  const hasNotices = !!notices && notices.length > 0
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            onClick={onClick}
            className="kp-tool"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent className={cn(hasNotices && 'flex-col items-start gap-0.5')}>
        <span>{label}</span>
        {notices?.map((notice) => (
          <span key={notice} className="opacity-60">
            {notice}
          </span>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * 面板收起时位于顶栏最右的侧边面板开关：打开上次标签或空面板列表，
 * 并聚合面板内不可见的提醒（侧聊新回答、Agent 新开页/设备、窄窗格折起的看板提醒）。
 */
function SidePanelButton({
  panel,
  projectPath,
  hiddenTools = [],
}: {
  panel: string
  projectPath: string
  hiddenTools?: readonly Tool[]
}) {
  const { t } = useTranslation(['common', 'shell'])
  const context = usePane()
  const sessionId = panelSession(panel)
  const shown = useViewStore((s) => shownPanel(s) === panel && !!s.sidePane[panel])
  const pageNews = useBrowserStore((s) => (sessionId ? !!s.unseen[sessionId] : false))
  const deviceNews = useDevicesStore((s) => (sessionId ? !!s.unseen[sessionId] : false))
  const chatNews = useSideChatNews(sessionId)
  if (shown) return null
  const hiddenDot = hiddenTools.some((tool) => tool.dot === 'needs')
    ? 'needs'
    : hiddenTools.some((tool) => tool.dot)
      ? 'news'
      : undefined
  const mark: 'news' | 'needs' | undefined =
    hiddenDot === 'needs'
      ? 'needs'
      : hiddenDot || chatNews || pageNews || deviceNews
        ? 'news'
        : undefined
  const notices: string[] = []
  for (const tool of hiddenTools) {
    if (tool.dot) notices.push(tool.label)
  }
  if (chatNews) {
    notices.push(
      `${t('shell:surfaces.list.sideChat')} \u00b7 ${t('shell:headerTools.sideChatNews')}`,
    )
  }
  if (pageNews || deviceNews) notices.push(t('shell:surfaces.news'))
  return (
    <BarButton
      label={t('common:pane.open')}
      notices={notices}
      onClick={() => {
        if (context && !context.focused) focusPane(context.paneId)
        if (reopenSidePanel(panel, projectPath)) requestSurfaceListFocus(panel)
      }}
    >
      <PaneIcon icon={SidebarRightIcon} size={16} />
      {mark && <span aria-hidden className={dotClass(mark)} />}
    </BarButton>
  )
}

/**
 * The session's More menu: who runs it, then what can be done with it from here, as the sidebar
 * row's menu does with what a row needs.
 */
export function SessionMoreMenu({
  summary,
  session,
  onRename,
  onNewSubSession,
  menu,
}: {
  summary: SessionSummary
  session: SessionView | undefined
  onRename: () => void
  onNewSubSession: () => void
  menu?: { finalFocus: () => boolean; onOpenChangeComplete: (open: boolean) => void }
}) {
  const { t } = useTranslation('sidebar')
  const [deleting, setDeleting] = useState(false)
  return (
    <>
      <DropdownMenu onOpenChangeComplete={menu?.onOpenChangeComplete}>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<button type="button" aria-label={t('row.more')} className="kp-tool" />}
              />
            }
          >
            <PaneIcon icon={MoreHorizontalIcon} size={16} />
          </TooltipTrigger>
          <TooltipContent>{t('row.more')}</TooltipContent>
        </Tooltip>
        <DropdownMenuContent
          align="start"
          className="w-68"
          finalFocus={menu?.finalFocus}
          onKeyDown={(event) => runSessionMenuAccelerator(event, isMac)}
        >
          <SessionMenuHeader summary={summary} session={session} />
          <SessionMenuItems
            summary={summary}
            place="more"
            onRename={onRename}
            onNewSubSession={onNewSubSession}
            onDelete={() => setDeleting(true)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteSessionDialog
        sessionId={summary.id}
        title={sessionTitle(summary)}
        open={deleting}
        onOpenChange={setDeleting}
      />
    </>
  )
}
