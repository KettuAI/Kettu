import { Fragment } from 'react'
import { MoreHorizontalIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useArtifactMenu, useEntries, type MenuOptions, type MenuTarget } from './menu-entries'

/** The menu behind a More button: the top bar's, or in a pane's head the pane's own tool. */
export function ArtifactMoreButton({
  target,
  pane = false,
  ...options
}: { target: MenuTarget; pane?: boolean } & MenuOptions) {
  const { t } = useTranslation('artifacts')
  const items = useArtifactMenu(target, options)
  return (
    <Dropdown
      align={pane ? 'end' : 'start'}
      className="k-av-more"
      items={items}
      trigger={({ open, toggle }) => (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={t('viewer.more')}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
                className={pane ? 'kp-tool' : 'ui-as-icon-btn k-av-btn'}
              />
            }
          >
            <Icon icon={MoreHorizontalIcon} size={16} />
          </TooltipTrigger>
          <TooltipContent>{t('viewer.more')}</TooltipContent>
        </Tooltip>
      )}
    />
  )
}

/** The same menu as a context menu's items. */
export function ArtifactMenuItems({ target, ...options }: { target: MenuTarget } & MenuOptions) {
  const entries = useEntries(target, options).flatMap((entry) =>
    entry.submenu
      ? entry.submenu.map((sub, i) => ({ ...sub, divider: i === 0 && entry.divider }))
      : [entry],
  )
  return (
    <>
      {entries.map((entry, i) => (
        <Fragment key={entry.key}>
          {entry.divider && i > 0 && <DropdownMenuSeparator />}
          {entry.checked === undefined ? (
            <DropdownMenuItem
              variant={entry.danger ? 'destructive' : undefined}
              disabled={entry.disabled}
              onClick={entry.run}
            >
              <Icon icon={entry.icon!} size={15} />
              {entry.note ? (
                <span className="flex min-w-0 flex-col">
                  {entry.label}
                  <span className="text-xs text-tertiary">{entry.note}</span>
                </span>
              ) : (
                entry.label
              )}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuCheckboxItem
              checked={entry.checked}
              onCheckedChange={entry.run}
              closeOnClick
            >
              <Icon icon={entry.icon!} size={15} />
              {entry.label}
            </DropdownMenuCheckboxItem>
          )}
        </Fragment>
      ))}
    </>
  )
}
