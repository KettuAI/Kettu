import { MinusSignIcon, PlusSignIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Kbd } from '@renderer/components/ui/kbd'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { PaneIcon, PanelButton } from '@renderer/features/shell/panel-button'
import { formatShortcut } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import type { PictureControls } from './picture-zoom'
import { MAX_ZOOM } from './zoom'

/** The picture's zoom and the fit it is measured against. */
export interface ZoomLevel {
  z: number
  fit: number
}

/**
 * Zoom out, the level, which toggles the fit and 100%, and zoom in. Both the viewer and the Files
 * pane's header show it, the pane at its smaller size.
 */
export function ZoomControls({
  zoom,
  controls,
  size = 'sm',
}: {
  zoom: ZoomLevel
  controls: PictureControls | null
  size?: 'sm' | 'xs'
}) {
  const { t } = useTranslation('session')
  const fitted = zoom.z <= zoom.fit
  const viewer = size === 'sm'
  // The pane's header draws its icons at 14 px, as Save and the rest of it does.
  const icon = viewer ? 16 : 14
  const percent = Math.round(zoom.z * 100)
  // A picture that fits at its own size has nothing to switch between.
  const switches = !fitted || zoom.fit < 1
  const target = fitted ? t('viewer.actualSize') : t('viewer.fit')
  return (
    <>
      <PanelButton
        size={viewer ? 'icon-sm' : 'icon-xs'}
        label={t('viewer.zoomOut')}
        shortcut="−"
        unavailable={!controls || fitted}
        onClick={() => controls?.zoomBy(-1)}
      >
        <PaneIcon icon={MinusSignIcon} size={icon} />
      </PanelButton>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="quiet"
              size={viewer ? 'sm' : 'xs'}
              aria-label={t('viewer.zoomLevel', { percent, action: target })}
              aria-disabled={!controls || !switches || undefined}
              onClick={() => controls?.toggle()}
              className={cn(
                'tabular app-region-no-drag active:bg-accent aria-disabled:pointer-events-none',
                viewer ? 'min-w-13 px-1.5 text-meta text-foreground' : 'min-w-10 px-1.5 text-xs',
              )}
            />
          }
        >
          {percent}%
        </TooltipTrigger>
        <TooltipContent>
          {target}
          <Kbd>{formatShortcut(fitted ? 'Shift+0' : 'Shift+1')}</Kbd>
        </TooltipContent>
      </Tooltip>
      <PanelButton
        size={viewer ? 'icon-sm' : 'icon-xs'}
        label={t('viewer.zoomIn')}
        shortcut="+"
        unavailable={!controls || zoom.z >= MAX_ZOOM}
        onClick={() => controls?.zoomBy(1)}
      >
        <PaneIcon icon={PlusSignIcon} size={icon} />
      </PanelButton>
    </>
  )
}
