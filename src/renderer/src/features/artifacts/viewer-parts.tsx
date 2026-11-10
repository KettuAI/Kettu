import type { ReactNode } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowShrink01Icon,
  Comment01Icon,
  Cursor01Icon,
  MinusSignIcon,
  PlusSignIcon,
  RotateLeft01Icon,
} from '@hugeicons/core-free-icons'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { SessionSummary } from '@shared/agent-host'
import type { ArtifactSession } from '@shared/artifacts'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { Kbd } from '@renderer/components/ui/kbd'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { longAgo } from '@renderer/lib/format'
import { fadeExit, glide } from '@renderer/lib/motion'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { openSessionWithArtifact } from '@renderer/stores/view'
import { atMaxZoom, atMinZoom } from './camera'
import { CanvasControls, useCanvasState } from './canvas-controls'
import { CanvasView, type PageActions } from './canvas-view'
import { useEditorState, type ArtifactEditor } from './editor'
import { daysLeft, presenceShown } from './model'
import { PageFrame } from './page-frame'
import { pageUrl, type Presence as PresenceState, type ShownVersion } from './use-artifact'
import './viewer.css'

type Size = 'compact' | 'pane'

const BUTTON = {
  compact: 'ui-as-icon-btn k-av-btn',
  group: 'ui-as-icon-btn k-av-btn k-av-btn--group',
  pane: 'kp-tool kp-tool--sm',
} as const
const GLYPH = { compact: 16, group: 15, pane: 14 } as const

/**
 * An icon button with its label, and its key, in a tooltip: `compact` in the top bar, `group`
 * inside one of its control groups or the tools at the foot, `pane` in a pane's head.
 */
export function BarButton({
  label,
  shortcut,
  size = 'compact',
  pressed,
  disabled,
  icon,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  size?: Size | 'group'
  pressed?: boolean
  disabled?: boolean
  icon: IconSvgElement
  onClick: () => void
  /** What sits over the glyph, such as a dot. */
  children?: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className={BUTTON[size]}
          />
        }
      >
        <Icon icon={icon} size={GLYPH[size]} />
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
export function Rule({ size = 'compact' }: { size?: Size }) {
  return <span aria-hidden className="k-av-rule" data-size={size} />
}

/** Controls that go together in a bar, inside one hairline. */
function ControlGroup({
  label,
  size,
  children,
}: {
  label: string
  size: Size
  children: ReactNode
}) {
  return (
    <span role="group" aria-label={label} className="k-av-group" data-size={size}>
      {children}
    </span>
  )
}

/**
 * The viewer's title in the bar's crumbs: the artifact's, or on a focused page the artifact's,
 * which leads back to the canvas, then the page's name.
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
  const { t } = useTranslation('artifacts')
  const { focused } = useCanvasState(controls)
  const page = focused !== null && pageName ? pageName(focused) : null
  if (page !== null) {
    return (
      <>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="k-av__crumb"
                onClick={() => controls.commands?.focus(null)}
              />
            }
          >
            {title}
          </TooltipTrigger>
          <TooltipContent>{t('canvas.backToCanvas')}</TooltipContent>
        </Tooltip>
        <i aria-hidden>/</i>
        <h1 className="k-av__title" title={page}>
          {page}
        </h1>
      </>
    )
  }
  return title ? (
    <h1 className="k-av__title" title={title}>
      {title}
    </h1>
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
      className="k-av-chip"
    >
      <span className="k-av-chip__num">{t('viewer.version', { version })}</span>
      {at !== null && <span className="k-av-chip__dim">{longAgo(at, now)}</span>}
      <Icon icon={ArrowDown01Icon} size={12} />
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
      className="k-av-dock"
      data-aside={aside || undefined}
    >
      {editor && (
        <>
          <ModeButton
            label={t('tools.select')}
            shortcut="V"
            icon={Cursor01Icon}
            pressed={mode === 'select'}
            onClick={() => editor.toggle('select')}
          />
          <ModeButton
            label={t('tools.comment')}
            shortcut="C"
            icon={Comment01Icon}
            pressed={mode === 'comment'}
            onClick={() => editor.toggle('comment')}
          />
        </>
      )}
      {controls && <ZoomTools controls={controls} divided={!!editor} />}
    </div>
  )
}

const IDLE_CONTROLS = new CanvasControls()

/** A mode the pages are in, on until it is pressed again or Esc goes back to the base one. */
export function ModeButton({
  label,
  shortcut,
  icon,
  pressed,
  onClick,
}: {
  label: string
  shortcut: string
  icon: IconSvgElement
  pressed: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      onClick={onClick}
      className="k-av-dock__mode"
    >
      <Icon icon={icon} size={15} />
      {label}
      <kbd aria-hidden>{shortcut}</kbd>
    </button>
  )
}

/** The overview's zoom: out, the percentage with its menu, and in. */
function ZoomTools({ controls, divided }: { controls: CanvasControls; divided: boolean }) {
  const { t } = useTranslation('artifacts')
  const state = useCanvasState(controls)
  const commands = controls.commands
  if (state.focused !== null) return null
  const percent = Math.round(state.zoom * 100)
  return (
    <>
      {divided && <Rule />}
      <BarButton
        label={t('canvas.zoomOut')}
        shortcut="−"
        size="group"
        icon={MinusSignIcon}
        disabled={atMinZoom(state.zoom)}
        onClick={() => commands?.zoomStep(-1)}
      />
      <Dropdown
        side="top"
        className="k-av-zoom"
        items={[
          { label: t('canvas.fitAll'), shortcut: '⇧1', onSelect: () => commands?.fitAll() },
          {
            label: t('canvas.fitSelection'),
            shortcut: '⇧2',
            onSelect: () => commands?.fitSelected(),
          },
          { label: t('canvas.actualSize'), shortcut: '⇧0', onSelect: () => commands?.actualSize() },
          {
            label: t('canvas.zoomIn'),
            shortcut: '+',
            divider: true,
            disabled: atMaxZoom(state.zoom),
            onSelect: () => commands?.zoomStep(1),
          },
          {
            label: t('canvas.zoomOut'),
            shortcut: '−',
            disabled: atMinZoom(state.zoom),
            onSelect: () => commands?.zoomStep(-1),
          },
        ]}
        trigger={({ open, toggle }) => (
          <button
            type="button"
            aria-label={t('canvas.zoomMenu', { percent })}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={toggle}
            className="k-av-dock__zoom"
          >
            {t('canvas.zoom', { percent })}
            <Icon icon={ArrowDown01Icon} size={12} />
          </button>
        )}
      />
      <BarButton
        label={t('canvas.zoomIn')}
        shortcut="+"
        size="group"
        icon={PlusSignIcon}
        disabled={atMaxZoom(state.zoom)}
        onClick={() => commands?.zoomStep(1)}
      />
    </>
  )
}

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
  const enter = reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.9 }

  return (
    <>
      {all.length > 0 && (
        <span role="group" aria-label={t('viewer.using')} className="k-av-people">
          <AnimatePresence initial={false}>
            {shown.map((session, i) => (
              <motion.span
                key={session.sessionId}
                initial={enter}
                animate={{ opacity: 1, scale: 1 }}
                exit={fadeExit}
                transition={glide}
                className="k-av-people__one"
                // The first avatar lies over the one after it.
                style={{ '--stack': shown.length - i + 1 } as React.CSSProperties}
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        aria-label={label(session)}
                        onClick={() => open(session.sessionId)}
                        className="k-av-avatar"
                      />
                    }
                  >
                    <AgentMark
                      agent={summaries[session.sessionId].agentId}
                      size={14}
                      hostId={hostOfSession(summaries[session.sessionId])}
                    />
                  </TooltipTrigger>
                  <TooltipContent>
                    <span className="flex flex-col items-start">
                      <span>{name(session.sessionId)}</span>
                      <span className="opacity-60">{state(session.editing)}</span>
                    </span>
                  </TooltipContent>
                </Tooltip>
                {session.editing && <Spinner aria-hidden className="k-av-avatar__spin" />}
              </motion.span>
            ))}
            {more > 0 && (
              <motion.span
                key="more"
                initial={enter}
                animate={{ opacity: 1, scale: 1 }}
                exit={fadeExit}
                transition={glide}
                className="k-av-people__one"
              >
                <Dropdown
                  align="end"
                  title={t('viewer.using')}
                  items={all.map((session) => ({
                    label: name(session.sessionId),
                    description: state(session.editing),
                    logo: (
                      <AgentMark
                        agent={summaries[session.sessionId].agentId}
                        size={14}
                        hostId={hostOfSession(summaries[session.sessionId])}
                      />
                    ),
                    onSelect: () => open(session.sessionId),
                  }))}
                  trigger={({ open: shownMenu, toggle }) => (
                    <button
                      type="button"
                      aria-label={t('viewer.moreSessions', { count: more })}
                      aria-haspopup="menu"
                      aria-expanded={shownMenu}
                      onClick={toggle}
                      className="k-av-avatar k-av-avatar--more"
                    >
                      {`+${more}`}
                    </button>
                  )}
                />
              </motion.span>
            )}
          </AnimatePresence>
        </span>
      )}
      {places > 1 && (
        <Tooltip>
          <TooltipTrigger render={<span className="k-av-places" />}>
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
 * A focused page's controls in a bar: the pages before and after it, and the way back to the
 * canvas. The top bar names the page in its crumbs; the pane's head, here.
 */
export function CanvasBarControls({
  controls,
  pageName,
  size = 'compact',
}: {
  controls: CanvasControls
  pageName: (index: number) => string
  size?: Size
}) {
  const { t } = useTranslation('artifacts')
  const state = useCanvasState(controls)
  const commands = controls.commands
  const inner = size === 'pane' ? 'pane' : 'group'
  if (state.focused === null) return null
  const focused = state.focused
  return (
    <>
      {size === 'pane' && <span className="k-av-pagename">{pageName(focused)}</span>}
      <ControlGroup label={t('canvas.pages')} size={size}>
        <BarButton
          label={t('canvas.previous')}
          shortcut="←"
          size={inner}
          icon={ArrowLeft01Icon}
          disabled={focused === 0}
          onClick={() => commands?.focus(focused - 1)}
        />
        <span className="k-av-group__count">
          {t('canvas.counter', { number: focused + 1, count: state.count })}
        </span>
        <BarButton
          label={t('canvas.next')}
          shortcut="→"
          size={inner}
          icon={ArrowRight01Icon}
          disabled={focused === state.count - 1}
          onClick={() => commands?.focus(focused + 1)}
        />
      </ControlGroup>
      <BarButton
        label={t('canvas.backToCanvas')}
        shortcut="Esc"
        size={size}
        icon={ArrowShrink01Icon}
        onClick={() => commands?.focus(null)}
      />
      {size === 'compact' && <Rule />}
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
  rest: ReactNode
  action: string
  onAction: () => void
}) {
  return (
    <div role="status" className="k-av-status">
      <span className="k-av-status__text">
        <b>{lead}</b>
        {rest}
      </span>
      <Button
        variant="secondary"
        size="sm"
        icon={<Icon icon={RotateLeft01Icon} size={14} />}
        onClick={onAction}
      >
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

/** The area's state when it shows no page: its mark, what happened and what can be done. */
export function ViewerEmpty({
  icon,
  danger = false,
  title,
  text,
  children,
}: {
  icon?: IconSvgElement
  danger?: boolean
  title: string
  text: string
  children?: ReactNode
}) {
  return (
    <div className="k-av-empty">
      <div className="ui-as-empty" data-bare="">
        {icon && (
          <span className={cn('ui-as-empty__icon', danger && 'k-av-empty__danger')}>
            <Icon icon={icon} size={18} />
          </span>
        )}
        <b className="ui-as-empty__title">{title}</b>
        <p className="ui-as-empty__text">{text}</p>
        {children && <div className="k-av-empty__acts">{children}</div>}
      </div>
    </div>
  )
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
