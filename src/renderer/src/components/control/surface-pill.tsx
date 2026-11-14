import { useEffect, useRef } from 'react'
import { Cursor02Icon, Key01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { motion } from 'motion/react'
import { Trans, useTranslation } from 'react-i18next'
import type { ActiveControl, ControlAgent } from '@shared/control'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { CONTROL_EASE, CONTROL_LEAVE_EASE } from './motion'

/**
 * On the surface itself, at its bottom: the label's three states in the surface's own words. It
 * bobs each time `nudge` changes, for a click or key the agent's turn held back. Like the label, it
 * morphs between states and leaves inside an `AnimatePresence`.
 */
export function SurfacePill({
  control,
  agent,
  agentName,
  scope,
  nudge = 0,
  onTakeOver,
  onHandBack,
  onDone,
  className,
}: {
  control: ActiveControl
  /** The agent, for its mark; null draws none. */
  agent: ControlAgent | null
  agentName: string
  /** What the user holds, as the pill names it: "this tab", "this device". */
  scope: string
  nudge?: number
  onTakeOver: () => void
  onHandBack: () => void
  onDone: () => void
  className?: string
}) {
  const { t } = useTranslation('control')
  const box = useRef<HTMLSpanElement>(null)

  // Restarts the bob for each nudge; the stylesheet stills it under Reduce motion.
  useEffect(() => {
    const element = box.current
    if (!nudge || !element) return
    element.removeAttribute('data-nudged')
    void element.offsetWidth
    element.setAttribute('data-nudged', '')
  }, [nudge])

  const b = <b dir="auto" />
  return (
    <span ref={box} className={cn('ctl-pill-nudge', className)}>
      <motion.span
        layout
        role="status"
        data-control-pill=""
        data-control={control.kind}
        className="ctl-pill"
        style={{ borderRadius: 11 }}
        initial={{ opacity: 0, y: 12, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{
          opacity: 0,
          y: 10,
          scale: 0.97,
          filter: 'blur(2px)',
          transition: CONTROL_LEAVE_EASE,
        }}
        transition={CONTROL_EASE}
      >
        <motion.span layout="position" key={control.kind} className="ctl-pill__in">
          {control.kind === 'agent' ? (
            <>
              {agent && <AgentMark agent={agent.id} size={14} dot={agent.dot} hostId={null} />}
              <span className="ctl-pill__text">{t('pill.agent', { agent: agentName, scope })}</span>
              <Button variant="secondary" size="dialog" data-control-action="" onClick={onTakeOver}>
                {t('actions.takeOver')}
              </Button>
            </>
          ) : control.kind === 'you' ? (
            <>
              <span className="ctl-pill__mark">
                <HugeiconsIcon
                  icon={Cursor02Icon}
                  strokeWidth={1.9}
                  aria-hidden
                  className="size-3.5"
                />
              </span>
              <span className="ctl-pill__text">
                <Trans
                  t={t}
                  i18nKey="pill.you"
                  values={{ agent: agentName, scope }}
                  components={{ b }}
                />
              </span>
              <Button size="dialog" data-control-action="" onClick={onHandBack}>
                {t('actions.handBack')}
              </Button>
            </>
          ) : (
            <>
              <span className="ctl-pill__asks">
                <HugeiconsIcon
                  icon={Key01Icon}
                  strokeWidth={1.9}
                  aria-hidden
                  className="size-3.25"
                />
              </span>
              <span className="ctl-pill__text">
                <Trans t={t} i18nKey={`pill.asks.${control.ask.step}`} components={{ b }} />
              </span>
              <Button size="dialog" data-control-action="" onClick={onDone}>
                {t('actions.done')}
              </Button>
            </>
          )}
        </motion.span>
      </motion.span>
    </span>
  )
}
