import type { ReactNode } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import { Icon } from '@renderer/components/affect/app-shell'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import type { CanvasControls } from './canvas-controls'
import { CanvasView, type PageActions } from './canvas-view'
import type { ArtifactEditor } from './editor'
import { PageFrame } from './page-frame'
import { framePageUrl, type ShownVersion } from './use-artifact'
import './viewer.css'

/** An icon button with its label, and its key, in a tooltip, as a canvas page's actions show. */
export function BarButton({
  label,
  shortcut,
  pressed,
  disabled,
  icon,
  onClick,
  children,
}: {
  label: string
  shortcut?: string
  size?: 'pane'
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
            className="kp-tool kp-tool--sm"
          />
        }
      >
        <Icon icon={icon} size={14} />
        {children}
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  )
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
        loadFrom={shown.loadFrom}
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
        src={framePageUrl(url, shown)}
        title={title}
        reloads={reloads}
        since={since}
        editor={editor}
      />
    </div>
  )
}
