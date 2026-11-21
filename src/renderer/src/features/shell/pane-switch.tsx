import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { runSessionMenuAccelerator } from '@renderer/features/sidebar/session-menu-model'
import { isMac } from '@renderer/lib/platform'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { PaneIcon } from './panel-button'
import { SurfaceMenuItems } from './surface-list'
import { startSurface, useSurfaceRows, type SurfaceRowId } from './surface-rows'

/**
 * The pane's glyph and a small arrow at the start of its head: the side panel's list, with the
 * pane that shows ticked, so the head can change the pane the bar no longer has a button for.
 */
export function PaneSwitch({
  panel,
  projectPath,
  pane,
}: {
  panel: string
  projectPath: string
  pane: Extract<SurfaceRowId, 'files' | 'git' | 'requests' | 'computer'>
}) {
  const { t } = useTranslation('shell')
  const rows = useSurfaceRows(panel, projectPath)
  const icon = rows.find((row) => row.id === pane)?.icon
  if (!icon) return null
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  aria-label={t('surfaces.switch')}
                  className="kp-tool kp-tool--switch app-region-no-drag"
                />
              }
            />
          }
        >
          <PaneIcon icon={icon} size={16} />
          <PaneIcon icon={ArrowDown01Icon} size={11} />
        </TooltipTrigger>
        <TooltipContent>{t('surfaces.switch')}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="start"
        className="w-68"
        onKeyDown={(event) => runSessionMenuAccelerator(event, isMac)}
      >
        <SurfaceMenuItems
          rows={rows}
          current={pane}
          onPick={(id) => id !== pane && startSurface(panel, projectPath, id)}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
