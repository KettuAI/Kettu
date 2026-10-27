import { MinusIcon, PlusIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { PanelButton } from '@renderer/features/shell/panel-button'
import { cn } from '@renderer/lib/utils'
import type { PictureControls } from './picture-zoom'
import { MAX_ZOOM } from './zoom'

/** The picture's zoom and the fit it is measured against. */
export interface ZoomLevel {
  z: number
  fit: number
}

/**
 * Zoom out, the level, which toggles the fit and 100%, and zoom in. Both the viewer's bar and the
 * Files pane's header show it, the pane at its smaller size.
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
  const icon = viewer ? undefined : 'size-3.5'
  return (
    <>
      <PanelButton
        size={viewer ? 'icon-sm' : 'icon-xs'}
        label={t('viewer.zoomOut')}
        shortcut="−"
        disabled={fitted}
        onClick={() => controls?.zoomBy(-1)}
      >
        <MinusIcon className={icon} />
      </PanelButton>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="quiet"
              size={viewer ? 'sm' : 'xs'}
              onClick={() => controls?.toggle()}
              className={cn(
                'tabular app-region-no-drag',
                viewer ? 'min-w-12 px-1.5 text-meta' : 'min-w-10 px-1.5 text-xs',
              )}
            />
          }
        >
          {Math.round(zoom.z * 100)}%
        </TooltipTrigger>
        <TooltipContent>{fitted ? t('viewer.actualSize') : t('viewer.fit')}</TooltipContent>
      </Tooltip>
      <PanelButton
        size={viewer ? 'icon-sm' : 'icon-xs'}
        label={t('viewer.zoomIn')}
        shortcut="+"
        disabled={!controls || zoom.z >= MAX_ZOOM}
        onClick={() => controls?.zoomBy(1)}
      >
        <PlusIcon className={icon} />
      </PanelButton>
    </>
  )
}
