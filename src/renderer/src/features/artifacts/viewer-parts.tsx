import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Minimize2Icon,
  MinusIcon,
  PlusIcon,
  ScanIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { longAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSessionWithArtifact } from '@renderer/stores/view'
import { useCanvasState, type CanvasControls } from './canvas-controls'
import { CanvasView } from './canvas-view'
import { daysLeft } from './model'
import { PageFrame } from './page-frame'
import { pageUrl, type Presence as PresenceState, type ShownVersion } from './use-artifact'

type Size = 'compact' | 'pane'

/** A quiet icon button with its label, and its key, in a tooltip. */
export function BarButton({
  label,
  shortcut,
  size = 'compact',
  disabled,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  size?: Size
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
            size={size === 'pane' ? 'icon-xs' : 'icon-compact'}
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="text-foreground"
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label} {shortcut && <span className="opacity-60">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Who else is at the artifact: the session whose running turn changes it, which opens that
 * session with the artifact beside it, and how many places in OverBench show it.
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
  const editorId = deleted ? undefined : presence?.editing[0]
  const editor = useSessionsStore((s) => (editorId ? s.byId[editorId] : undefined))
  const places = presence?.viewers ?? 1
  if (!editor && places < 2) return null
  const name = editor ? (editor.title ?? t('common:untitledSession')) : ''
  return (
    <>
      {editor && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="quiet"
                size={size === 'pane' ? 'xs' : 'compact'}
                aria-label={t('viewer.editingLabel', { session: name })}
                onClick={() => openSessionWithArtifact(editor.id, editor.projectPath, id)}
                className="max-w-80 min-w-0 gap-1.5 px-2 text-xs font-normal text-secondary"
              />
            }
          >
            <Spinner className="size-3" />
            <span className="truncate">{t('viewer.editing', { session: name })}</span>
          </TooltipTrigger>
          <TooltipContent>{t('page.openSession')}</TooltipContent>
        </Tooltip>
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
      <span aria-hidden className="mx-1.5 h-4 w-(--hairline) shrink-0 bg-border" />
    </>
  )
}

/** The canvas's controls in a bar: the zoom and Zoom to fit, or a focused page's own. */
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
  if (state.focused === null && !zoom) return null
  if (state.focused !== null) {
    return (
      <>
        <span className="max-w-60 truncate px-1.5 text-ui font-medium">
          {pageName(state.focused)}
        </span>
        <BarButton
          label={t('canvas.previous')}
          shortcut="←"
          size={size}
          disabled={state.focused === 0}
          onClick={() => commands?.focus(state.focused! - 1)}
        >
          <ChevronLeftIcon />
        </BarButton>
        <span className="min-w-10 text-center text-xs text-secondary tabular-nums">
          {t('canvas.counter', { number: state.focused + 1, count: state.count })}
        </span>
        <BarButton
          label={t('canvas.next')}
          shortcut="→"
          size={size}
          disabled={state.focused === state.count - 1}
          onClick={() => commands?.focus(state.focused! + 1)}
        >
          <ChevronRightIcon />
        </BarButton>
        <BarButton
          label={t('canvas.backToCanvas')}
          shortcut="Esc"
          size={size}
          onClick={() => commands?.focus(null)}
        >
          <Minimize2Icon />
        </BarButton>
      </>
    )
  }
  return (
    <>
      <span
        className={cn(
          'flex shrink-0 items-center rounded-lg bg-subtle p-0.5',
          size === 'pane' ? 'h-6' : 'h-7',
        )}
      >
        <BarButton
          label={t('canvas.zoomOut')}
          shortcut="−"
          size="pane"
          onClick={() => commands?.zoomStep(-1)}
        >
          <MinusIcon />
        </BarButton>
        <span className="min-w-12 text-center text-xs text-secondary tabular-nums">
          {t('canvas.zoom', { percent: Math.round(state.zoom * 100) })}
        </span>
        <BarButton
          label={t('canvas.zoomIn')}
          shortcut="+"
          size="pane"
          onClick={() => commands?.zoomStep(1)}
        >
          <PlusIcon />
        </BarButton>
      </span>
      <BarButton
        label={t('canvas.zoomToFit')}
        shortcut="⇧1"
        size={size}
        onClick={() => commands?.fitAll()}
      >
        <ScanIcon />
      </BarButton>
    </>
  )
}

/** A bar over the top of the page: what shows instead of the latest, and how to restore it. */
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
      className="absolute inset-x-3 top-2.5 z-10 flex min-h-11 items-center gap-2.5 rounded-2xl bg-popover py-1.5 pr-1.5 pl-3.5 text-ui shadow-menu"
    >
      <span className="min-w-0 flex-1 truncate text-secondary">
        <span className="font-medium text-foreground">{lead}</span>
        {rest}
      </span>
      <Button variant="outline" size="compact" onClick={onAction}>
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
  onEscape,
}: {
  url: string
  shown: ShownVersion
  title: string
  reloads: number
  since: number
  controls: CanvasControls
  top: number
  onEscape?: () => void
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
        onEscape={onEscape}
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
      />
    </div>
  )
}
