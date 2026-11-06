import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  MessageSquareIcon,
  Minimize2Icon,
  MinusIcon,
  MousePointer2Icon,
  PlusIcon,
  RotateCcwIcon,
  ScanIcon,
} from './icons'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import type { ArtifactSession } from '@shared/artifacts'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Kbd } from '@renderer/components/ui/kbd'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { longAgo } from '@renderer/lib/format'
import { fadeExit, glide } from '@renderer/lib/motion'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSessionWithArtifact } from '@renderer/stores/view'
import { atMaxZoom, atMinZoom } from './camera'
import { CanvasControls, useCanvasState } from './canvas-controls'
import { CanvasView, type PageActions } from './canvas-view'
import { useEditorState, type ArtifactEditor } from './editor'
import { daysLeft, presenceShown } from './model'
import { PageFrame } from './page-frame'
import { pageUrl, type Presence as PresenceState, type ShownVersion } from './use-artifact'

type Size = 'compact' | 'pane'

/**
 * A quiet icon button with its label, and its key, in a tooltip: `compact` in the top bar, `group`
 * inside one of its control groups, `pane` in a pane's header.
 */
export function BarButton({
  label,
  shortcut,
  size = 'compact',
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  size?: Size | 'group'
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="quiet"
            size={size === 'pane' ? 'icon-xs' : 'icon-sm'}
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className={cn(
              size === 'compact'
                ? 'size-7.5 rounded-tile text-secondary'
                : size === 'group'
                  ? 'text-secondary'
                  : 'text-foreground',
            )}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
}

/** A hairline between the bar's groups of controls. */
function Rule({ size }: { size: Size }) {
  return (
    <span
      aria-hidden
      // The top bar spaces its controls 8 px apart, the pane's header 2 px.
      className={cn(
        'w-(--hairline) shrink-0 bg-border',
        size === 'pane' ? 'mx-1.5 h-4' : 'mx-0.5 h-4.5',
      )}
    />
  )
}

/** Controls that go together in the bar, inside one hairline. */
function ControlGroup({
  label,
  size,
  children,
}: {
  label: string
  size: Size
  children: React.ReactNode
}) {
  return (
    <span
      role="group"
      aria-label={label}
      className={cn(
        'flex shrink-0 items-center rounded-lg shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]',
        size === 'pane' ? 'h-6' : 'h-7',
      )}
    >
      {children}
    </span>
  )
}

/**
 * The viewer's title: the artifact's, or on a focused page the page's name and then the
 * artifact's. The version shown has its own chip after it.
 */
export function ViewerTitle({
  title,
  controls,
  pageName,
}: {
  title: string
  controls: CanvasControls
  /** A canvas's page names; null for a single page. */
  pageName: ((index: number) => string) | null
}) {
  const { focused } = useCanvasState(controls)
  const page = focused !== null && pageName ? pageName(focused) : null
  if (page !== null) {
    return (
      <h1 className="mx-1 flex min-w-0 items-baseline gap-2">
        <span className="max-w-60 shrink-0 truncate text-subheading font-semibold">{page}</span>
        <span className="min-w-0 truncate text-small text-secondary">{title}</span>
      </h1>
    )
  }
  return title ? (
    <h1 className="mx-1 min-w-0 truncate text-subheading font-semibold">{title}</h1>
  ) : null
}

/** The version shown and how long ago it was made; it opens and closes the history. */
export function VersionChip({
  version,
  at,
  open,
  onClick,
}: {
  version: number
  at: number | null
  open: boolean
  onClick: () => void
}) {
  const { t } = useTranslation('artifacts')
  const now = useNow()
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={t('viewer.versionChip', { version })}
      onClick={onClick}
      className="flex h-6.5 shrink-0 items-center gap-1.25 rounded-tile bg-subtle px-2 text-hint whitespace-nowrap text-secondary outline-none transition-colors duration-(--duration-fast) hover:bg-selected focus-ring"
    >
      {t('viewer.version', { version })}
      {at !== null && <span className="text-tertiary">· {longAgo(at, now)}</span>}
      <ChevronDownIcon strokeWidth={1.75} className="size-3 text-tertiary" />
    </button>
  )
}

/**
 * The tools floating over the foot of the page or canvas: Select and Comment, then on a canvas's
 * overview its zoom, whose percentage opens the zoom menu.
 */
export function EditToolbar({
  editor,
  controls,
  aside = false,
}: {
  /** Null where nothing is edited, such as an earlier version. */
  editor: ArtifactEditor | null
  /** A canvas's; null for a single page. */
  controls: CanvasControls | null
  /** At the foot's left, as a type's viewer keeps the middle for its own controls. */
  aside?: boolean
}) {
  const { t } = useTranslation('artifacts')
  const { mode } = useEditorState(editor)
  const focused = useCanvasState(controls ?? IDLE_CONTROLS).focused
  if (!editor && (!controls || focused !== null)) return null
  return (
    <div
      role="toolbar"
      aria-label={t('tools.label')}
      className={cn(
        'absolute bottom-5 z-10 flex h-10 items-center gap-0.5 rounded-2xl bg-surface px-1 shadow-menu',
        aside ? 'left-5' : 'left-1/2 -translate-x-1/2',
      )}
    >
      {editor && (
        <>
          <ToolButton
            label={t('tools.select')}
            shortcut="V"
            pressed={mode === 'select'}
            onClick={() => editor.toggle('select')}
          >
            <MousePointer2Icon />
          </ToolButton>
          <ToolButton
            label={t('tools.comment')}
            shortcut="C"
            pressed={mode === 'comment'}
            onClick={() => editor.toggle('comment')}
          >
            <MessageSquareIcon />
          </ToolButton>
        </>
      )}
      {controls && <ZoomTools controls={controls} divided={!!editor} />}
    </div>
  )
}

const IDLE_CONTROLS = new CanvasControls()

function ToolButton({
  label,
  shortcut,
  pressed,
  onClick,
  children,
}: {
  label: string
  shortcut: string
  pressed: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Button
      variant="quiet"
      size="sm"
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      onClick={onClick}
      className="h-8 gap-1.5 rounded-xl px-2.5 text-control font-normal text-secondary aria-pressed:bg-selected aria-pressed:text-foreground"
    >
      {children}
      {label}
      <span aria-hidden className="text-hint text-tertiary">
        {shortcut}
      </span>
    </Button>
  )
}

/** The overview's zoom: out, the percentage with its menu, and in. */
function ZoomTools({ controls, divided }: { controls: CanvasControls; divided: boolean }) {
  const { t } = useTranslation('artifacts')
  const state = useCanvasState(controls)
  const commands = controls.commands
  if (state.focused !== null) return null
  return (
    <>
      {divided && <span aria-hidden className="mx-1 h-4.5 w-(--hairline) bg-border" />}
      <BarButton
        label={t('canvas.zoomOut')}
        shortcut="−"
        size="group"
        disabled={atMinZoom(state.zoom)}
        onClick={() => commands?.zoomStep(-1)}
      >
        <MinusIcon className="size-3.75" />
      </BarButton>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="quiet"
              size="sm"
              aria-label={t('canvas.zoomMenu', { percent: Math.round(state.zoom * 100) })}
              className="h-8 min-w-16 gap-1 rounded-xl px-2 text-control font-normal text-secondary tabular-nums"
            />
          }
        >
          {t('canvas.zoom', { percent: Math.round(state.zoom * 100) })}
          <ChevronDownIcon strokeWidth={1.75} className="size-3 text-tertiary" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="center" sideOffset={10} className="min-w-50">
          <DropdownMenuGroup>
            <DropdownMenuItem onClick={() => commands?.fitAll()}>
              {t('canvas.fitAll')}
              <DropdownMenuShortcut>⇧1</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => commands?.fitSelected()}>
              {t('canvas.fitSelection')}
              <DropdownMenuShortcut>⇧2</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => commands?.actualSize()}>
              {t('canvas.actualSize')}
              <DropdownMenuShortcut>⇧0</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuItem
              disabled={atMaxZoom(state.zoom)}
              onClick={() => commands?.zoomStep(1)}
            >
              {t('canvas.zoomIn')}
              <DropdownMenuShortcut>+</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={atMinZoom(state.zoom)}
              onClick={() => commands?.zoomStep(-1)}
            >
              {t('canvas.zoomOut')}
              <DropdownMenuShortcut>−</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <BarButton
        label={t('canvas.zoomIn')}
        shortcut="+"
        size="group"
        disabled={atMaxZoom(state.zoom)}
        onClick={() => commands?.zoomStep(1)}
      >
        <PlusIcon className="size-3.75" />
      </BarButton>
    </>
  )
}

/** The avatars' stacking, the first of them over the one after it. */
const STACK = ['z-3', 'z-2', 'z-1'] as const

/** A 24 px round avatar on the tile, with its hairline ring and the sheet's 2 px ring around it. */
const AVATAR =
  'grid size-6 shrink-0 place-items-center rounded-full bg-tile text-icon shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle),0_0_0_2px_var(--bg-app)] outline-none transition-shadow duration-(--duration-fast) hover:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong),0_0_0_2px_var(--bg-app)] focus-visible:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong),0_0_0_2px_var(--bg-app)] focus-ring'

/**
 * Who is at the artifact: every session using it now, the editing ones first, as avatars that
 * open their session with the artifact beside it, and how many places in Kettu show it.
 */
export function Presence({
  id,
  presence,
  deleted,
  size = 'compact',
}: {
  id: string
  presence: PresenceState | null
  deleted: boolean
  size?: Size
}) {
  const { t } = useTranslation(['artifacts', 'common'])
  const reduceMotion = useReducedMotion()
  const sessions = deleted ? [] : (presence?.sessions ?? [])
  // The sessions the window knows, which are the ones it can draw a mark for and open.
  const summaries = useSessionsStore(
    useShallow((s) => {
      const known: Record<string, SessionSummary> = {}
      for (const session of sessions) {
        const summary = s.byId[session.sessionId]
        if (summary) known[session.sessionId] = summary
      }
      return known
    }),
  )
  const { all, shown, more } = presenceShown(sessions.filter((s) => summaries[s.sessionId]))
  const places = presence?.viewers ?? 1
  if (all.length === 0 && places < 2) return null

  const name = (sessionId: string) => summaries[sessionId].title ?? t('common:untitledSession')
  const state = (editing: boolean) => t(editing ? 'viewer.stateEditing' : 'viewer.stateReading')
  const open = (sessionId: string) => {
    const summary = summaries[sessionId]
    openSessionWithArtifact(summary.id, summary.projectPath, id)
  }
  const label = (session: ArtifactSession) =>
    t(session.editing ? 'viewer.editingLabel' : 'viewer.readingLabel', {
      session: name(session.sessionId),
    })

  return (
    <>
      {all.length > 0 && (
        <span role="group" aria-label={t('viewer.using')} className="flex shrink-0 items-center">
          <AnimatePresence initial={false}>
            {shown.map((session, i) => (
              <motion.span
                key={session.sessionId}
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={fadeExit}
                transition={glide}
                className={cn(
                  'relative flex hover:z-10 has-focus-visible:z-10',
                  i > 0 && '-ml-1.5',
                  STACK[i] ?? 'z-0',
                )}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={label(session)}
                        onClick={() => open(session.sessionId)}
                        className={AVATAR}
                      />
                    }
                  >
                    <AgentMark agent={summaries[session.sessionId].agentId} size={14} />
                  </TooltipTrigger>
                  <TooltipContent>
                    <span className="flex flex-col items-start">
                      <span>{name(session.sessionId)}</span>
                      <span className="opacity-60">{state(session.editing)}</span>
                    </span>
                  </TooltipContent>
                </Tooltip>
                {session.editing && (
                  <Spinner
                    aria-hidden
                    className="pointer-events-none absolute -inset-1 z-10 m-auto size-8 text-info"
                  />
                )}
              </motion.span>
            ))}
            {more > 0 && (
              <motion.span
                key="more"
                initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={fadeExit}
                transition={glide}
                className={cn('relative -ml-1.5 flex z-0 hover:z-10 has-focus-visible:z-10')}
              >
                <DropdownMenu>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <DropdownMenuTrigger
                          render={
                            <button
                              type="button"
                              aria-label={t('viewer.moreSessions', { count: more })}
                              className={cn(
                                AVATAR,
                                'text-xs font-medium text-secondary tabular-nums hover:text-primary',
                              )}
                            />
                          }
                        />
                      }
                    >
                      {`+${more}`}
                    </TooltipTrigger>
                    <TooltipContent>{t('viewer.moreSessions', { count: more })}</TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent align="end" className="min-w-55">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{t('viewer.using')}</DropdownMenuLabel>
                      {all.map((session) => (
                        <DropdownMenuItem
                          key={session.sessionId}
                          onClick={() => open(session.sessionId)}
                        >
                          <AgentMark agent={summaries[session.sessionId].agentId} size={14} />
                          <span className="min-w-0 flex-1 truncate">{name(session.sessionId)}</span>
                          <span className="shrink-0 text-muted-foreground">
                            {state(session.editing)}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      )}
      {places > 1 && (
        <Tooltip>
          <TooltipTrigger
            render={<span className="shrink-0 px-2 text-xs whitespace-nowrap text-tertiary" />}
          >
            {t('viewer.places', { count: places })}
          </TooltipTrigger>
          <TooltipContent>{t('viewer.placesTip', { count: places })}</TooltipContent>
        </Tooltip>
      )}
      <Rule size={size} />
    </>
  )
}

/**
 * The canvas's controls in a bar: the zoom and Zoom to fit, or a focused page's own. The top bar
 * names a focused page in its title; the pane's header, here.
 */
export function CanvasBarControls({
  controls,
  pageName,
  size = 'compact',
  zoom = true,
}: {
  controls: CanvasControls
  pageName: (index: number) => string
  size?: Size
  /** Whether the overview shows the zoom; the pane's header has no room for it. */
  zoom?: boolean
}) {
  const { t } = useTranslation('artifacts')
  const state = useCanvasState(controls)
  const commands = controls.commands
  const inner = size === 'pane' ? 'pane' : 'group'
  if (state.focused === null && !zoom) return null
  if (state.focused !== null) {
    return (
      <>
        {size === 'pane' && (
          <span className="max-w-60 truncate px-1.5 text-ui font-medium">
            {pageName(state.focused)}
          </span>
        )}
        <ControlGroup label={t('canvas.pages')} size={size}>
          <BarButton
            label={t('canvas.previous')}
            shortcut="←"
            size={inner}
            disabled={state.focused === 0}
            onClick={() => commands?.focus(state.focused! - 1)}
          >
            <ChevronLeftIcon />
          </BarButton>
          <span className="min-w-11.5 text-center text-xs text-secondary tabular-nums">
            {t('canvas.counter', { number: state.focused + 1, count: state.count })}
          </span>
          <BarButton
            label={t('canvas.next')}
            shortcut="→"
            size={inner}
            disabled={state.focused === state.count - 1}
            onClick={() => commands?.focus(state.focused! + 1)}
          >
            <ChevronRightIcon />
          </BarButton>
        </ControlGroup>
        <BarButton
          label={t('canvas.backToCanvas')}
          shortcut="Esc"
          size={inner}
          onClick={() => commands?.focus(null)}
        >
          <Minimize2Icon />
        </BarButton>
        {size === 'compact' && <Rule size={size} />}
      </>
    )
  }
  return (
    <>
      <ControlGroup label={t('canvas.zoomGroup')} size={size}>
        <BarButton
          label={t('canvas.zoomOut')}
          shortcut="−"
          size={inner}
          disabled={atMinZoom(state.zoom)}
          onClick={() => commands?.zoomStep(-1)}
        >
          <MinusIcon />
        </BarButton>
        <span className="min-w-11.5 text-center text-xs text-secondary tabular-nums">
          {t('canvas.zoom', { percent: Math.round(state.zoom * 100) })}
        </span>
        <BarButton
          label={t('canvas.zoomIn')}
          shortcut="+"
          size={inner}
          disabled={atMaxZoom(state.zoom)}
          onClick={() => commands?.zoomStep(1)}
        >
          <PlusIcon />
        </BarButton>
      </ControlGroup>
      <BarButton
        label={t('canvas.zoomToFit')}
        shortcut="⇧1"
        size={inner}
        pressed={state.fitted}
        onClick={() => commands?.fitAll()}
      >
        <ScanIcon />
      </BarButton>
      {size === 'compact' && <Rule size={size} />}
    </>
  )
}

/** A bar over the top of the area: what shows instead of the latest, and how to restore it. */
export function StatusBar({
  lead,
  rest,
  action,
  onAction,
}: {
  lead: string
  rest: React.ReactNode
  action: string
  onAction: () => void
}) {
  return (
    <div
      role="status"
      className="absolute top-3.5 left-1/2 z-10 flex h-10 max-w-[calc(100%-24px)] -translate-x-1/2 animate-in items-center gap-3.5 rounded-xl bg-surface pr-1.5 pl-3.5 text-small whitespace-nowrap text-secondary shadow-menu fade-in slide-in-from-top-1 duration-(--duration-fast)"
    >
      <span className="min-w-0 truncate">
        <span className="font-medium text-foreground">{lead}</span>
        {rest}
      </span>
      <Button variant="outline" size="sm" onClick={onAction}>
        <RotateCcwIcon data-icon="inline-start" />
        {action}
      </Button>
    </div>
  )
}

/** " · 52 min ago · Three onboarding directions", after "Version 1 of 3". */
export function EarlierDetails({ createdAt, note }: { createdAt: number; note: string | null }) {
  const now = useNow()
  return (
    <>
      {' · '}
      {longAgo(createdAt, now)}
      {note && ` · ${note}`}
    </>
  )
}

/** " · 29 days left", after "In Recently deleted". */
export function DaysLeft({ deletedAt }: { deletedAt: number }) {
  const { t } = useTranslation('artifacts')
  const now = useNow()
  return <>{t('viewer.daysLeft', { count: daysLeft(deletedAt, now) })}</>
}

/** The version on screen: a canvas of its pages, or the single page at the area's size. */
export function ArtifactSurface({
  url,
  shown,
  title,
  reloads,
  since,
  controls,
  top,
  bottom,
  onEscape,
  editor,
  actions,
  onPageChosen,
}: {
  url: string
  shown: ShownVersion
  title: string
  reloads: number
  since: number
  controls: CanvasControls
  top: number
  /** Room the toolbar over a canvas takes at the bottom. */
  bottom?: number
  onEscape?: () => void
  editor?: ArtifactEditor
  actions?: PageActions
  onPageChosen?: (index: number) => void
}) {
  if (shown.canvas) {
    return (
      <CanvasView
        key={url}
        url={url}
        version={shown.version}
        title={title}
        layout={shown.canvas}
        reloads={reloads}
        controls={controls}
        top={top}
        bottom={bottom}
        onEscape={onEscape}
        editor={editor}
        actions={actions}
        onPageChosen={onPageChosen}
      />
    )
  }
  // A page is laid out below the bar, so the bar never covers its top.
  return (
    <div className="absolute inset-x-0 bottom-0" style={{ top }}>
      <PageFrame
        key={url}
        url={url}
        src={pageUrl(url, shown.version)}
        title={title}
        reloads={reloads}
        since={since}
        editor={editor}
      />
    </div>
  )
}
