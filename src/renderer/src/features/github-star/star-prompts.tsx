import { AnimatePresence, motion, type TargetAndTransition } from 'motion/react'
import { Cancel01Icon, GithubIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Button as AffectButton } from '@renderer/components/affect/button'
import { GradientFloor } from '@renderer/components/affect/gradient-floor'
import { GradientText } from '@renderer/components/affect/gradient-text'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph } from '@renderer/features/shell/glyph'
import {
  dismissGitHubStar,
  starKettu,
  useGitHubStarStore,
  useStarPhase,
  useStarsInBrowser,
} from '@renderer/stores/github-star'
import { BrowserMark, StarButton, StarMark } from './star-button'
import { useStarLabel } from './use-star'

/** The floor's stops, crest to bottom; the stylesheet colors them from the theme. */
const FLOOR_STOPS: [string, string, string] = ['currentColor', 'currentColor', 'currentColor']
const TEXT_COLORS = [
  'var(--send)',
  'var(--star-text-amber)',
  'var(--star-text-peach)',
  'var(--send)',
]

const ENTER: TargetAndTransition = { opacity: 0, y: 4 }
const SHOWN: TargetAndTransition = {
  opacity: 1,
  y: 0,
  transition: { duration: 0.32, ease: [0.22, 1, 0.36, 1] },
}
const LEAVE: TargetAndTransition = {
  opacity: 0,
  y: 6,
  transition: { duration: 0.36, ease: [0.4, 0, 0.2, 1] },
}
// New session's line comes in a beat after the page, and leaves without moving as far.
const LINE_SHOWN: TargetAndTransition = {
  opacity: 1,
  y: 0,
  transition: { duration: 0.42, delay: 0.16, ease: [0.22, 1, 0.36, 1] },
}
const LINE_LEAVE: TargetAndTransition = { ...LEAVE, y: 4 }

/** Whether a prompt shows: while the host has it due, then while it thanks for a star made here. */
function usePromptShown(which: 'card' | 'line'): boolean {
  return useGitHubStarStore((s) => (s.state?.[which] ?? false) || (s.thanking?.[which] ?? false))
}

/** The one-time card over the account row; `blocked` while another card is there. */
export function StarCard({ blocked }: { blocked: boolean }) {
  const shown = usePromptShown('card')
  return (
    <AnimatePresence initial={false}>
      {shown && !blocked && (
        <motion.div key="star" initial={ENTER} animate={SHOWN} exit={LEAVE}>
          <StarCardView />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function StarCardView() {
  const { t } = useTranslation('star')
  const phase = useStarPhase()
  const done = phase === 'starred'
  return (
    <div
      role="group"
      aria-label={t('card.label')}
      data-busy={phase === 'starring' ? '' : undefined}
      data-starred={done ? '' : undefined}
      className="kstar-card group/kstar relative rounded-xl bg-(--shell-card) shadow-(--shell-card-shadow)"
    >
      <div className="kstar-floor-clip">
        <GradientFloor className="kstar-floor" colors={FLOOR_STOPS} speed={5} />
      </div>
      <div className="relative flex flex-col gap-2 px-2.5 pt-2 pb-2.5">
        <span className="flex items-center gap-1.5 text-small font-medium text-(--shell-muted)">
          <Glyph icon={GithubIcon} size={13} />
          KettuAI/Kettu
        </span>
        <span className="text-control font-medium text-pretty text-(--shell-ink)">
          {done ? (
            t('card.thanks')
          ) : (
            <>
              {t('card.lead')}
              <GradientText colors={TEXT_COLORS} speed={6}>
                {t('card.ask')}
              </GradientText>
            </>
          )}
        </span>
        <StarButton size="sm" variant="outline" className="w-full justify-center" />
      </div>
      {!done && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-xs"
                aria-label={t('card.close')}
                onClick={dismissGitHubStar}
                className="absolute -top-1.5 -right-1.5 size-4.5 rounded-full text-(--shell-faint) opacity-0 transition-opacity duration-(--duration-fast) group-focus-within/kstar:opacity-100 group-hover/kstar:opacity-100 hover:text-(--shell-ink) focus-visible:opacity-100 no-hover:opacity-100 [&_svg:not([class*=size-])]:size-3"
              />
            }
          >
            <Glyph icon={Cancel01Icon} size={12} />
          </TooltipTrigger>
          <TooltipContent side="top">{t('card.close')}</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

/** New session's quiet line at the foot of the main area; `hidden` while a message is written. */
export function StarLine({ hidden }: { hidden: boolean }) {
  const shown = usePromptShown('line')
  return (
    <div className="kstar-foot-slot">
      <AnimatePresence initial={false}>
        {shown && (
          <motion.div key="star" initial={ENTER} animate={LINE_SHOWN} exit={LINE_LEAVE}>
            <StarLineView hidden={hidden} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function StarLineView({ hidden }: { hidden: boolean }) {
  const { t } = useTranslation('star')
  const done = useStarPhase() === 'starred'
  return (
    <div className="kstar-foot" data-hidden={hidden || undefined}>
      <Glyph icon={GithubIcon} size={13} />
      <span>{done ? t('line.thanks') : t('line.text')}</span>
      <StarButton />
      {!done && (
        <button
          type="button"
          aria-label={t('line.close')}
          className="kstar-foot__close"
          onClick={dismissGitHubStar}
        >
          <Glyph icon={Cancel01Icon} size={11} />
        </button>
      )}
    </div>
  )
}

/** A block under the agents on onboarding's last step. */
export function OnboardingStar() {
  const { t } = useTranslation('star')
  return (
    <div className="kob-panel kstar-onb">
      <span className="kstar-onb__mark">
        <Glyph icon={GithubIcon} size={18} />
      </span>
      <span className="kstar-onb__text">
        <b>{t('onboarding.title')}</b>
        <small>{t('onboarding.body')}</small>
      </span>
      <StarButton size="sm" variant="outline" />
    </div>
  )
}

/** Settings › About: Star beside the GitHub button, in its look. */
export function AboutStarButton() {
  const { t } = useTranslation('star')
  const phase = useStarPhase()
  const inBrowser = useStarsInBrowser()
  const label = useStarLabel()
  const button = (
    <AffectButton
      variant="secondary"
      size="md"
      onClick={() => void starKettu()}
      disabled={phase !== 'idle'}
      icon={<StarMark size={14} />}
      iconRight={inBrowser && phase === 'idle' ? <BrowserMark className="ml-0" /> : undefined}
      className="kstar-about kstar-btn"
      data-starred={phase === 'starred' ? '' : undefined}
    >
      {label}
    </AffectButton>
  )
  if (phase !== 'idle') return button
  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="bottom">
        {inBrowser ? t('button.inBrowser') : t('button.withGh')}
      </TooltipContent>
    </Tooltip>
  )
}
