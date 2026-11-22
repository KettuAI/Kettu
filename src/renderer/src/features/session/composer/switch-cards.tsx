import type { ReactNode } from 'react'
import { FlashIcon, Settings02Icon, WorkflowSquare01Icon } from '@hugeicons/core-free-icons'
import type { ConfigOption } from '@shared/thread'
import { ShimmerText } from '@renderer/components/affect/shimmer-loader'
import { Switch } from '@renderer/components/ui/switch'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import { isFast, isUltracode, lockedNow, useCardLine } from './switch-options'

/**
 * The agent's switches as cards, two side by side and an odd last one across: an icon, the name,
 * the app's switch and a line under them. Fast mode turns blue when on and Ultracode violet.
 */
export function SwitchCards({
  options,
  agent,
  running = false,
  valueOf,
  onFlip,
  onPoint,
  className,
}: {
  options: readonly ConfigOption[]
  /** Whom an option that follows the agent's setting follows, such as Claude Code. */
  agent: string
  running?: boolean
  valueOf: (option: ConfigOption) => boolean
  onFlip: (option: ConfigOption, on: boolean) => void
  /** The card under the pointer or the focus, then null. */
  onPoint?: (option: ConfigOption | null) => void
  className?: string
}) {
  const line = useCardLine(agent)
  if (options.length === 0) return null
  return (
    <div
      className={cn('kettu-cards', className)}
      data-one={options.length === 1 ? '' : undefined}
      data-mm-line=""
    >
      {options.map((o) => {
        const on = valueOf(o)
        const locked = lockedNow(o, running)
        const ultra = isUltracode(o)
        const said = line(o, running)
        const name: ReactNode =
          ultra && on ? (
            <ShimmerText className="kettu-ultra-text" duration={2.4}>
              {o.name}
            </ShimmerText>
          ) : (
            o.name
          )
        return (
          <button
            key={o.id}
            type="button"
            role="switch"
            aria-checked={on}
            aria-disabled={locked || undefined}
            className="kettu-card"
            data-kind={isFast(o) ? 'fast' : ultra ? 'ultra' : undefined}
            data-on={on ? '' : undefined}
            data-disabled={locked ? '' : undefined}
            data-mm-nav=""
            onClick={() => {
              if (!locked) onFlip(o, !on)
            }}
            onPointerEnter={() => onPoint?.(o)}
            onPointerLeave={() => onPoint?.(null)}
            onFocus={() => onPoint?.(o)}
            onBlur={() => onPoint?.(null)}
          >
            <span className="kettu-card__icon">
              <Glyph
                icon={isFast(o) ? FlashIcon : ultra ? WorkflowSquare01Icon : Settings02Icon}
                size={16}
              />
            </span>
            <span className="kettu-card__name">{name}</span>
            <Switch
              size="sm"
              checked={on}
              tabIndex={-1}
              aria-hidden
              className="kettu-card__switch pointer-events-none"
            />
            {said && <span className="kettu-card__line">{said}</span>}
          </button>
        )
      })}
    </div>
  )
}
