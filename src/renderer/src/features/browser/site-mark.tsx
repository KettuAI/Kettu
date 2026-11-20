import { useEffect } from 'react'
import { Globe02Icon } from '@hugeicons/core-free-icons'
import { SiteIconImage } from '@renderer/components/site-icon-image'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { loadSiteIcons, useSiteIcon } from '@renderer/stores/site-icons'

/** The page's site icon, as recorded when it opened, else a globe. */
export function SiteMark({ url }: { url: string | null }) {
  useEffect(loadSiteIcons, [])
  const icon = useSiteIcon(url ?? '')
  if (icon) return <SiteIconImage src={icon} className="kp-sitemark" />
  return <PaneIcon icon={Globe02Icon} size={14} className="kp-tab__icon" />
}
