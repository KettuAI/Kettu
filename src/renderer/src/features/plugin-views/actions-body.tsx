import type { PluginActionsContent } from '@shared/plugin-views'
import { Spinner } from '@renderer/components/ui/spinner'
import { ViewGlyph } from './parts'
import { busyKey, type ActionHandle } from './use-plugin-view'

/** The buttons of a view that is only buttons, a line each with what it does under it. */
export function ActionsBody({
  view,
  handle,
}: {
  view: PluginActionsContent
  handle: ActionHandle
}) {
  return (
    <div className="kpv-actions">
      {view.text && <p className="kpv-actions__text">{view.text}</p>}
      {view.actions.map((action) => (
        <button
          key={action.id}
          type="button"
          className="kpv-arow focus-ring"
          data-primary={action.primary || undefined}
          data-danger={action.destructive || undefined}
          disabled={action.disabled || handle.busy !== null}
          onClick={() => handle.run(action)}
        >
          {handle.busy === busyKey(action) ? (
            <Spinner className="mt-0.5 size-4" />
          ) : (
            <ViewGlyph icon={action.icon} />
          )}
          <span className="kpv-arow__text">
            <b>{action.label}</b>
            {action.description && <small>{action.description}</small>}
          </span>
        </button>
      ))}
    </div>
  )
}
