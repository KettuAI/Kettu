import { Fragment, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
} from '@renderer/components/ui/dropdown-menu'
import { PluginTile } from '@renderer/features/plugin-views/plugin-tile'
import { cn } from '@renderer/lib/utils'
import { PaneIcon } from './panel-button'
import {
  MENU_ITEM,
  startArtifact,
  startPluginPane,
  startSurface,
  takePendingSurfaceListFocus,
  useArtifactChoices,
  usePluginPaneChoices,
  useSurfaceRows,
  type ArtifactChoice,
  type PluginPaneChoice,
  type SurfaceRow,
  type SurfaceRowId,
} from './surface-rows'

/** The rows in their two groups. */
function grouped(rows: SurfaceRow[]): SurfaceRow[][] {
  return [rows.filter((row) => row.group === 0), rows.filter((row) => row.group === 1)]
}

const ROW =
  'flex h-8.5 w-full items-center gap-2.5 rounded-lg px-2.25 text-left outline-hidden focus-visible:outline-solid focus-visible:outline-offset-[-2px]'
const ROW_ON = 'hover:bg-(--bg-hover) focus-visible:bg-(--bg-hover)'
const GROUP = 'mt-1.25 border-t border-(--border-default) pt-1.25'

/**
 * The list laid out as a menu card: an icon, a name and the picking letter in each row, with a
 * line between the groups, then the session's artifacts. A row that does not apply says why in
 * the letter's place, and a tab the row already holds says it is open.
 */
export function SurfaceList({ panel, projectPath }: { panel: string; projectPath: string }) {
  const { t } = useTranslation('shell')
  const rows = useSurfaceRows(panel, projectPath)
  const artifacts = useArtifactChoices(panel)
  const panes = usePluginPaneChoices(panel, projectPath)
  const onPick = (id: SurfaceRowId) => startSurface(panel, projectPath, id)
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
    const row = rows.find((other) => other.key?.toLowerCase() === event.key.toLowerCase())
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
        <div key={index} role="group" className={cn(index > 0 && GROUP)}>
          {group.map((row) => (
            <button
              key={row.id}
              type="button"
              role="menuitem"
              aria-disabled={row.off ? true : undefined}
              tabIndex={row.off ? -1 : 0}
              onClick={row.off ? undefined : () => onPick(row.id)}
              className={cn(ROW, row.off ? 'cursor-default' : ROW_ON)}
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
                  {row.open ? (
                    <span className="shrink-0 text-small text-(--text-disabled)">
                      {t('surfaces.list.open')}
                    </span>
                  ) : (
                    <kbd className="grid h-4.75 min-w-4.75 shrink-0 place-items-center rounded-[5px] bg-(--bg-selected) px-1.25 text-hint text-secondary">
                      {row.key ?? row.shortcut}
                    </kbd>
                  )}
                </>
              )}
            </button>
          ))}
        </div>
      ))}
      {panes.length > 0 && (
        <div role="group" aria-label={t('surfaces.list.plugins')} className={GROUP}>
          <div className="px-2.25 pt-0.5 pb-1 text-hint text-(--text-tertiary)">
            {t('surfaces.list.plugins')}
          </div>
          {panes.map((pane) => (
            <button
              key={`${pane.plugin.pluginId}/${pane.viewId}`}
              type="button"
              role="menuitem"
              onClick={() => startPluginPane(panel, pane)}
              className={cn(ROW, ROW_ON)}
            >
              <span className="grid shrink-0">
                <PluginTile name={pane.plugin.name} icon={pane.plugin.icon} size={16} />
              </span>
              <span className="flex-1 truncate">{pane.label}</span>
              <span
                title={pane.pluginTitle}
                className="min-w-0 shrink truncate text-small text-(--text-disabled)"
              >
                {pane.open ? t('surfaces.list.open') : pane.pluginTitle}
              </span>
            </button>
          ))}
        </div>
      )}
      {artifacts.length > 0 && (
        <div role="group" aria-label={t('surfaces.list.artifacts')} className={GROUP}>
          <div className="px-2.25 pt-0.5 pb-1 text-hint text-(--text-tertiary)">
            {t('surfaces.list.artifacts')}
          </div>
          {artifacts.map((artifact) => (
            <button
              key={artifact.id}
              type="button"
              role="menuitem"
              onClick={() => startArtifact(panel, artifact.id)}
              className={cn(ROW, ROW_ON)}
            >
              <span className="grid shrink-0 text-(--icon-default)">
                <PaneIcon icon={artifact.icon} size={16} />
              </span>
              <span className="flex-1 truncate">{artifact.title}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The same rows as a dropdown's items, with the picking letters `runSessionMenuAccelerator` reads,
 * then the session's artifacts. `devices` replaces the Mobile device row with a submenu.
 */
export function SurfaceMenuItems({
  rows,
  artifacts,
  panes,
  onPick,
  onArtifact,
  onPane,
  devices,
}: {
  rows: SurfaceRow[]
  artifacts: ArtifactChoice[]
  panes: PluginPaneChoice[]
  onPick: (id: SurfaceRowId) => void
  onArtifact: (id: string) => void
  onPane: (pane: PluginPaneChoice) => void
  devices?: (row: SurfaceRow, item: ReactNode) => ReactNode
}) {
  const { t } = useTranslation('shell')
  return (
    <>
      {grouped(rows).map((group, index) => (
        <Fragment key={index}>
          {index > 0 && <DropdownMenuSeparator />}
          <DropdownMenuGroup>
            {group.map((row) => {
              const item = (
                <>
                  <PaneIcon icon={row.icon} size={16} />
                  {row.label}
                  {row.off ? (
                    <span className="ml-auto pl-3 text-small text-(--text-disabled)">
                      {row.off}
                    </span>
                  ) : row.open ? (
                    <span className="ml-auto pl-3 text-small text-(--text-disabled)">
                      {t('surfaces.list.open')}
                    </span>
                  ) : (
                    <DropdownMenuShortcut>{row.key ?? row.shortcut}</DropdownMenuShortcut>
                  )}
                </>
              )
              if (row.id === 'devices' && !row.off && devices) return devices(row, item)
              return (
                <DropdownMenuItem
                  key={row.id}
                  disabled={!!row.off}
                  data-accelerator={row.key ?? undefined}
                  onClick={() => onPick(row.id)}
                >
                  {item}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuGroup>
        </Fragment>
      ))}
      {panes.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('surfaces.list.plugins')}</DropdownMenuLabel>
            {panes.map((pane) => (
              <DropdownMenuItem
                key={`${pane.plugin.pluginId}/${pane.viewId}`}
                onClick={() => onPane(pane)}
              >
                <PluginTile name={pane.plugin.name} icon={pane.plugin.icon} size={16} />
                <span className="truncate">{pane.label}</span>
                <span className="ml-auto pl-3 text-small text-(--text-disabled)">
                  {pane.open ? t('surfaces.list.open') : pane.pluginTitle}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </>
      )}
      {artifacts.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{t('surfaces.list.artifacts')}</DropdownMenuLabel>
            {artifacts.map((artifact) => (
              <DropdownMenuItem key={artifact.id} onClick={() => onArtifact(artifact.id)}>
                <PaneIcon icon={artifact.icon} size={16} />
                <span className="truncate">{artifact.title}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        </>
      )}
    </>
  )
}
