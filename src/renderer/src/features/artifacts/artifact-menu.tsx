import { Fragment } from 'react'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@renderer/components/ui/dropdown-menu'
import { useEntries, type MenuOptions, type MenuTarget } from './menu-entries'

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
