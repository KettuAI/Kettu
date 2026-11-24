import type { PluginViewAction, PluginViewBadge, PluginViewIcon } from '@shared/plugin-views'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'
import { Glyph } from '@renderer/features/shell/glyph'
import { VIEW_ICONS } from './icons'
import { busyKey, type ActionExtra, type ActionHandle } from './use-plugin-view'

export function ViewGlyph({ icon, size = 16 }: { icon?: PluginViewIcon; size?: number }) {
  if (!icon) return null
  return (
    <span className="kpv-icon">
      <Glyph icon={VIEW_ICONS[icon]} size={size} />
    </span>
  )
}

const TONES = {
  neutral: 'neutral',
  info: 'info',
  success: 'success',
  warning: 'warning',
  danger: 'error',
} as const

export function Badges({ badges }: { badges?: PluginViewBadge[] }) {
  if (!badges || badges.length === 0) return null
  return (
    <>
      {badges.map((badge, i) => (
        <Badge key={i} variant={TONES[badge.tone ?? 'neutral']}>
          {badge.text}
        </Badge>
      ))}
    </>
  )
}

/** One of a view's buttons: the primary one in the blue tint, a destructive one in red. */
export function ActionButton({
  action,
  handle,
  extra,
}: {
  action: PluginViewAction
  handle: ActionHandle
  extra?: ActionExtra
}) {
  const running = handle.busy === busyKey(action, extra)
  return (
    <Button
      size="sm"
      variant={action.destructive ? 'destructive-outline' : action.primary ? 'default' : 'outline'}
      title={action.description}
      disabled={action.disabled || handle.busy !== null}
      onClick={() => handle.run(action, extra)}
    >
      {running ? <Spinner className="size-3.5" /> : <ViewGlyphInline icon={action.icon} />}
      {action.label}
    </Button>
  )
}

function ViewGlyphInline({ icon }: { icon?: PluginViewIcon }) {
  if (!icon) return null
  return <Glyph icon={VIEW_ICONS[icon]} size={14} data-icon="inline-start" />
}

/** A view's buttons, one after the other. */
export function ActionButtons({
  actions,
  handle,
  extra,
}: {
  actions?: PluginViewAction[]
  handle: ActionHandle
  extra?: ActionExtra
}) {
  return (
    <>
      {actions?.map((action) => (
        <ActionButton
          key={action.id}
          action={action}
          handle={handle}
          {...(extra ? { extra } : {})}
        />
      ))}
    </>
  )
}

/** The buttons at the foot of a view. */
export function FootActions({
  actions,
  handle,
}: {
  actions?: PluginViewAction[]
  handle: ActionHandle
}) {
  if (!actions || actions.length === 0) return null
  return (
    <div className="kpv-foot">
      <ActionButtons actions={actions} handle={handle} />
    </div>
  )
}
