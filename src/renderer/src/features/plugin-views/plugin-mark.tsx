import { PlugSocketIcon } from '@hugeicons/core-free-icons'
import type { PluginRefSource } from '@shared/plugin-refs'
import { SiteIconImage } from '@renderer/components/site-icon-image'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'

/**
 * A plugin's tile at the size of a line of text: its own icon, or a plug on the control tint. It
 * leads the plugin's group in the `@` menu and the plugin's references in replies.
 */
export function PluginMark({
  source,
  className,
}: {
  source: Pick<PluginRefSource, 'icon'>
  className?: string
}) {
  if (source.icon) {
    return (
      <SiteIconImage
        src={source.icon}
        className={cn('size-4 shrink-0 rounded-[4px] object-contain', className)}
      />
    )
  }
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-[4px] bg-control-on-tint text-control-on',
        className,
      )}
    >
      <Glyph icon={PlugSocketIcon} className="size-2.5" />
    </span>
  )
}
