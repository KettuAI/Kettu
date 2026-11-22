import type { ReactNode } from 'react'
import { FlashIcon, Settings02Icon, WorkflowSquare01Icon } from '@hugeicons/core-free-icons'
import type { ConfigOption } from '@shared/thread'
import { ShimmerText } from '@renderer/components/affect/shimmer-loader'
import { Switch } from '@renderer/components/ui/switch'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import { isFast, isUltracode, lockedNow, useSwitchLine } from './switch-options'

/**
 * The agent's switches as rows lined up with the model rows: an icon, the name over a line of what
 * it does, and the app's switch at the end. Fast mode's icon turns blue when on and Ultracode's violet.
 */
export function SwitchRows({
  options,
  agent,
  running = false,
  valueOf,
  onFlip,
  className,
}: {
  options: readonly ConfigOption[]
  /** Whom an option that follows the agent's setting follows, such as Claude Code. */
  agent: string
  running?: boolean
  valueOf: (option: ConfigOption) => boolean
  onFlip: (option: ConfigOption, on: boolean) => void
  className?: string
}) {
  const line = useSwitchLine(agent)
  if (options.length === 0) return null
  return (
    <div className={cn('kettu-switch-rows', className)} data-mm-line="">
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
            className="kettu-switch-row"
            data-kind={isFast(o) ? 'fast' : ultra ? 'ultra' : undefined}
            data-on={on ? '' : undefined}
            data-disabled={locked ? '' : undefined}
            data-mm-nav=""
            onClick={() => {
              if (!locked) onFlip(o, !on)
            }}
          >
            <span className="kettu-switch-row__icon">
              <Glyph
                icon={isFast(o) ? FlashIcon : ultra ? WorkflowSquare01Icon : Settings02Icon}
                size={16}
              />
            </span>
            <span className="kettu-switch-row__text">
              <span className="kettu-switch-row__name">{name}</span>
              {said && <span className="kettu-switch-row__line">{said}</span>}
            </span>
            <Switch
              size="sm"
              checked={on}
              tabIndex={-1}
              aria-hidden
              className="pointer-events-none"
            />
          </button>
        )
      })}
    </div>
  )
}
