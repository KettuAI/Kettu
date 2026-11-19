import { useEffect } from 'react'
import { Globe02Icon } from '@hugeicons/core-free-icons'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { loadSiteIcons, useSiteIcon } from '@renderer/stores/site-icons'

/** The page's site icon, as recorded when it opened, else a globe. */
export function SiteMark({ url }: { url: string | null }) {
  useEffect(loadSiteIcons, [])
  const icon = useSiteIcon(url ?? '')
  if (icon) return <img src={icon} alt="" aria-hidden className="kp-sitemark" />
  return <PaneIcon icon={Globe02Icon} size={14} className="kp-tab__icon" />
}
