import { useState, type CSSProperties } from 'react'
import { ArrowUpRight01Icon, StarIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/button'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { cn } from '@renderer/lib/utils'
import { Glyph } from '@renderer/features/shell/glyph'
import { CARD_BUTTON } from '@renderer/features/updates/update-actions'
import {
  starKettu,
  useGitHubStarStore,
  useStarPhase,
  useStarsInBrowser,
} from '@renderer/stores/github-star'
import { useStarLabel } from './use-star'
import './github-star.css'

// The burst around the star once it is starred: dots and small stars thrown out on a ring.
const PARTICLES = Array.from({ length: 10 }, (_, i) => ({
  a: `${i * 36 + (i % 2 ? 10 : -6)}deg`,
  r: `${i % 2 ? 15 : 21}px`,
  s: `${i % 3 === 0 ? 7 : i % 3 === 1 ? 4 : 5}px`,
  star: i % 3 === 0,
  amber: i % 2 === 1,
  d: `${(i % 4) * 18}ms`,
}))

/** The fox star: outline until starred, then filled, with a pop and a burst when starred here. */
export function StarMark({ size = 14 }: { size?: number }) {
  const phase = useStarPhase()
  const burst = useGitHubStarStore((s) => s.burst)
  // Only a mark on screen when the star was made celebrates it; one that mounts later is still.
  const [mountedAt] = useState(burst)
  if (phase === 'starring') return <RingSpinner className="size-3.5" data-icon="inline-start" />
  const done = phase === 'starred'
  const celebrate = done && burst > mountedAt
  return (
    <span className="kstar-anchor" data-icon="inline-start">
      <span key={done ? `on-${burst}` : 'off'} className={cn('kstar', celebrate && 'kstar-pop')}>
        <Glyph icon={StarIcon} size={size} className={done ? 'kstar-fill' : undefined} />
      </span>
      {celebrate && (
        <span key={burst} aria-hidden className="kstar-burst">
          <span className="kstar-ring" />
          {PARTICLES.map((p, i) => (
            <i
              key={i}
              data-star={p.star ? '' : undefined}
              data-amber={p.amber ? '' : undefined}
              style={{ '--a': p.a, '--r': p.r, '--s': p.s, '--d': p.d } as CSSProperties}
            />
          ))}
        </span>
      )}
    </span>
  )
}

/** The small ↗ after Star when a click opens the repository page instead. */
export function BrowserMark({ className }: { className?: string }) {
  return (
    <Glyph
      icon={ArrowUpRight01Icon}
      size={11}
      className={cn('-ml-0.5 text-(--shell-faint)', className)}
    />
  )
}

/** The Star button the prompts share, in the sidebar cards' small size. */
export function StarButton({
  className,
  size = 'xs',
  variant = 'secondary',
}: {
  className?: string
  size?: 'xs' | 'sm'
  variant?: 'secondary' | 'outline'
}) {
  const { t } = useTranslation('star')
  const phase = useStarPhase()
  const inBrowser = useStarsInBrowser()
  const label = useStarLabel()
  const button = (
    <Button
      size={size}
      variant={variant}
      onClick={() => void starKettu()}
      disabled={phase === 'starring'}
      data-starred={phase === 'starred' ? '' : undefined}
      className={cn(CARD_BUTTON, 'kstar-btn gap-1.5', className)}
    >
      <StarMark size={size === 'xs' ? 13 : 14} />
      {label}
      {inBrowser && phase === 'idle' && <BrowserMark />}
    </Button>
  )
  if (phase !== 'idle') return button
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="top">
        {inBrowser ? t('button.inBrowser') : t('button.withGh')}
      </TooltipContent>
    </Tooltip>
  )
}
