import { Fragment, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@renderer/components/ui/dropdown-menu'
import { cn } from '@renderer/lib/utils'
import { PaneIcon } from './panel-button'
import {
  MENU_ITEM,
  takePendingSurfaceListFocus,
  useSurfaceRows,
  type SurfaceRow,
  type SurfaceRowId,
} from './surface-rows'

/** The rows in their two groups. */
function grouped(rows: SurfaceRow[]): SurfaceRow[][] {
  return [rows.filter((row) => row.group === 0), rows.filter((row) => row.group === 1)]
}

/**
 * The list laid out as a menu card: an icon, a name and the picking letter in each row, with a
 * line between the groups. A row that does not apply says why in the letter's place.
 */
export function SurfaceList({
  panel,
  projectPath,
  onPick,
}: {
  panel: string
  projectPath: string
  onPick: (id: SurfaceRowId) => void
}) {
  const { t } = useTranslation('shell')
  const rows = useSurfaceRows(panel, projectPath)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => takePendingSurfaceListFocus(panel), [panel])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? [])]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const at = items.indexOf(document.activeElement as HTMLElement)
      const step = event.key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length]?.focus()
      return
    }
    const row = rows.find((other) => other.key.toLowerCase() === event.key.toLowerCase())
    if (row && !row.off) {
      event.preventDefault()
      onPick(row.id)
    }
  }

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('surfaces.empty.title')}
      data-surface-list={panel}
      onKeyDown={onKeyDown}
      className="w-75 rounded-xl bg-popover p-1.25 text-menu shadow-menu"
    >
      {grouped(rows).map((group, index) => (
        <div
          key={index}
          role="group"
          className={cn(index > 0 && 'mt-1.25 border-t border-(--border-default) pt-1.25')}
        >
          {group.map((row) => (
            <button
              key={row.id}
              type="button"
              role="menuitem"
              aria-disabled={row.off ? true : undefined}
              tabIndex={row.off ? -1 : 0}
              onClick={row.off ? undefined : () => onPick(row.id)}
              className={cn(
                'flex h-8.5 w-full items-center gap-2.5 rounded-lg px-2.25 text-left outline-hidden',
                'focus-visible:outline-solid focus-visible:outline-offset-[-2px]',
                row.off ? 'cursor-default' : 'hover:bg-(--bg-hover) focus-visible:bg-(--bg-hover)',
              )}
            >
              <span className={cn('grid shrink-0 text-(--icon-default)', row.off && 'opacity-45')}>
                <PaneIcon icon={row.icon} size={16} />
              </span>
              <span className={cn('flex-1 truncate', row.off && 'shrink-0 flex-none opacity-45')}>
                {row.label}
              </span>
              {row.off ? (
                <span
                  title={row.off}
                  className="min-w-0 flex-1 truncate text-right text-small text-(--text-disabled)"
                >
                  {row.off}
                </span>
              ) : (
                <>
                  {row.live && (
                    <span className="shrink-0 rounded-full bg-[color-mix(in_srgb,var(--attention-dot)_14%,transparent)] px-1.75 text-small text-(--attention)">
                      {t('surfaces.list.live')}
                    </span>
                  )}
                  <kbd className="grid h-4.75 min-w-4.75 shrink-0 place-items-center rounded-[5px] bg-(--bg-selected) px-1.25 text-hint text-secondary">
                    {row.key}
                  </kbd>
                </>
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * The same rows as a dropdown's items, with the picking letters `runSessionMenuAccelerator` reads
 * and the pane that shows ticked. `devices` replaces the Mobile device row with a submenu.
 */
export function SurfaceMenuItems({
  rows,
  current,
  onPick,
  devices,
}: {
  rows: SurfaceRow[]
  current?: SurfaceRowId
  onPick: (id: SurfaceRowId) => void
  devices?: (row: SurfaceRow, item: ReactNode) => ReactNode
}) {
  return grouped(rows).map((group, index) => (
    <Fragment key={index}>
      {index > 0 && <DropdownMenuSeparator />}
      <DropdownMenuGroup>
        {group.map((row) => {
          const item = (
            <>
              <PaneIcon icon={row.icon} size={16} />
              {row.label}
              {row.off ? (
                <span className="ml-auto pl-3 text-small text-(--text-disabled)">{row.off}</span>
              ) : row.id === current ? (
                <PaneIcon icon={Tick02Icon} size={14} className="ml-auto" />
              ) : (
                <DropdownMenuShortcut>{row.key}</DropdownMenuShortcut>
              )}
            </>
          )
          if (row.id === 'devices' && !row.off && devices) return devices(row, item)
          return (
            <DropdownMenuItem
              key={row.id}
              disabled={!!row.off}
              data-accelerator={row.key}
              onClick={() => onPick(row.id)}
            >
              {item}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuGroup>
    </Fragment>
  ))
}
