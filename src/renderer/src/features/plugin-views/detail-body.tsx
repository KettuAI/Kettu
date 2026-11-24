import { Fragment } from 'react'
import type { PluginDetailContent } from '@shared/plugin-views'
import { Markdown } from '@renderer/features/session/markdown'
import { Badges, FootActions, ViewGlyph } from './parts'
import type { ActionHandle } from './use-plugin-view'

/** A heading, its facts and a body of plain Markdown, drawn as a reply is. */
export function DetailBody({ view, handle }: { view: PluginDetailContent; handle: ActionHandle }) {
  const heading = view.title || view.subtitle || view.icon || view.badges
  return (
    <>
      <div className="kpv-detail">
        {heading && (
          <div className="kpv-detail__head">
            <ViewGlyph icon={view.icon} size={18} />
            <div className="kpv-detail__text">
              {(view.title || view.badges) && (
                <h2 className="kpv-detail__title">
                  {view.title}
                  <Badges badges={view.badges} />
                </h2>
              )}
              {view.subtitle && <div className="kpv-detail__sub">{view.subtitle}</div>}
            </div>
          </div>
        )}
        {view.fields && view.fields.length > 0 && (
          <dl className="kpv-facts">
            {view.fields.map((field, i) => (
              <Fragment key={i}>
                <dt>{field.label}</dt>
                <dd data-mono={field.mono || undefined}>{field.value}</dd>
              </Fragment>
            ))}
          </dl>
        )}
        {view.body && <Markdown markdown={view.body} className="kpv-prose" />}
      </div>
      <FootActions actions={view.actions} handle={handle} />
    </>
  )
}
