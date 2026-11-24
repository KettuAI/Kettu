// A plugin's tile: the icon its package carries, else a glyph on a color its name picks, as the
// Marketplace draws it. Small, for a tab, a row of the side panel's list and a group of Search.

import { SiteIconImage } from '@renderer/components/site-icon-image'
import { kettuPluginSubject, tileArt } from '@renderer/features/marketplace/tile-art'
import { Glyph } from '@renderer/features/shell/glyph'

export function PluginTile({
  name,
  icon,
  size = 16,
}: {
  /** The package's name, which picks the color when there is no icon. */
  name: string
  /** The package's icon as a data URL. */
  icon: string | null
  size?: number
}) {
  const art = tileArt(kettuPluginSubject({ name, icon }))
  if (icon) {
    return (
      <span aria-hidden className="kpv-tile" style={{ width: size, height: size }}>
        <SiteIconImage className="kpv-tile__logo" src={icon} />
      </span>
    )
  }
  if (art.type !== 'glyph') return null
  return (
    <span
      aria-hidden
      className="kpv-tile"
      data-filled=""
      style={{ width: size, height: size, background: art.color }}
    >
      <Glyph icon={art.icon} size={Math.round(size * 0.66)} />
    </span>
  )
}
