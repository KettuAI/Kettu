import { MoreHorizontalIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { PluginListContent, PluginViewRow } from '@shared/plugin-views'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@renderer/components/ui/empty'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'
import { Badges, FootActions, ViewGlyph } from './parts'
import { VIEW_ICONS } from './icons'
import { busyKey, type ActionHandle } from './use-plugin-view'

function RowMenu({ row, handle }: { row: PluginViewRow; handle: ActionHandle }) {
  const { t } = useTranslation('plugin-views')
  const actions = row.actions ?? []
  return (
    <div className="kpv-row__more">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="quiet"
              size="icon-sm"
              aria-label={t('moreFor', { title: row.title })}
              title={t('more')}
            />
          }
        >
          <Glyph icon={MoreHorizontalIcon} size={15} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {actions.map((action) => (
            <DropdownMenuItem
              key={action.id}
              variant={action.destructive ? 'destructive' : 'default'}
              disabled={action.disabled || handle.busy !== null}
              onClick={() => handle.run(action, { row: row.id })}
            >
              {action.icon && <MenuGlyph icon={VIEW_ICONS[action.icon]} />}
              {action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function ListRow({ row, handle }: { row: PluginViewRow; handle: ActionHandle }) {
  const first = row.actions?.[0]
  const text = (
    <>
      <ViewGlyph icon={row.icon} />
      <span className="kpv-row__text">
        <span className="kpv-row__title">
          <span title={row.title}>{row.title}</span>
          <Badges badges={row.badges} />
        </span>
        {row.subtitle && (
          <span
            className="kpv-row__sub"
            data-mono={row.mono || undefined}
            data-lines={row.subtitle.includes('\n') || undefined}
            title={row.subtitle}
          >
            {row.subtitle}
          </span>
        )}
      </span>
      {row.end && <span className="kpv-row__end">{row.end}</span>}
    </>
  )
  return (
    <li className="kpv-row">
      {first ? (
        <button
          type="button"
          className="kpv-row__main focus-ring"
          disabled={first.disabled || handle.busy !== null}
          aria-busy={handle.busy === busyKey(first, { row: row.id }) || undefined}
          onClick={() => handle.run(first, { row: row.id })}
        >
          {text}
        </button>
      ) : (
        <div className="kpv-row__main">{text}</div>
      )}
      {(row.actions?.length ?? 0) > 1 && <RowMenu row={row} handle={handle} />}
    </li>
  )
}

/** Rows with a hairline between them; the first action of a row runs when it is clicked. */
export function ListBody({ view, handle }: { view: PluginListContent; handle: ActionHandle }) {
  const { t } = useTranslation('plugin-views')
  return (
    <>
      {view.rows.length === 0 ? (
        <Empty className="kpv-state">
          <EmptyHeader>
            <EmptyTitle>{view.empty?.title ?? t('empty')}</EmptyTitle>
            {view.empty?.description && (
              <EmptyDescription>{view.empty.description}</EmptyDescription>
            )}
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="kpv-list">
          {view.rows.map((row) => (
            <ListRow key={row.id} row={row} handle={handle} />
          ))}
        </ul>
      )}
      {view.truncated && <p className="kpv-note">{t('truncated', { count: view.rows.length })}</p>}
      <FootActions actions={view.actions} handle={handle} />
    </>
  )
}
