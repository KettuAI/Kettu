import type { ReactNode } from 'react'
import {
  ArrowTurnBackwardIcon,
  Cursor02Icon,
  Key01Icon,
  StopCircleIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { motion } from 'motion/react'
import { Trans, useTranslation } from 'react-i18next'
import type { ActiveControl, ControlAgent, ControlSurface } from '@shared/control'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { CONTROL_EASE, CONTROL_LEAVE_EASE } from './motion'

/**
 * On the composer's top edge while a turn uses a surface or waits on the user there, whatever pane
 * shows: who uses it, with Take over; the user, with Hand back; or the step the agent asked for,
 * with Done. It morphs between them and sinks into the composer when the turn ends, so the caller
 * keeps it in an `AnimatePresence` under one key per surface.
 *
 * The computer's label is solid fox while the agent has it, as it uses the whole machine: the
 * app's icon in place of the agent's mark, and Stop beside Take over.
 */
export function ControlLabel({
  surface,
  control,
  agent,
  hostId,
  target,
  held,
  mark,
  looking,
  stopTitle,
  onTakeOver,
  onHandBack,
  onDone,
  onStop,
}: {
  surface: ControlSurface
  control: ActiveControl
  agent: ControlAgent
  /** The host the agent is on, null for this computer. */
  hostId?: string | null
  /** What the agent uses, as "is using ..." names it: "the browser", a device's name. */
  target: string
  /** What the user took over, as "You took over ..." names it: "the tab", a device's name. */
  held: string
  /** Drawn in place of the agent's mark while it uses the surface, such as an app's icon. */
  mark?: ReactNode
  /** The agent's latest call only looked at the surface. */
  looking?: boolean
  /** Stop's tooltip, which names its shortcut. */
  stopTitle?: string
  onTakeOver: () => void
  onHandBack: () => void
  onDone: () => void
  /** Stop beside Take over: it ends the use of the surface, not the turn. */
  onStop?: () => void
}) {
  const { t } = useTranslation('control')
  const b = <b dir="auto" />
  const computer = surface === 'computer'
  return (
    <motion.div
      layout
      role="status"
      data-control-label=""
      data-control={control.kind}
      data-surface={surface}
      className="ctl-label"
      style={{ borderTopLeftRadius: 12, borderTopRightRadius: 12 }}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12, filter: 'blur(2px)', transition: CONTROL_LEAVE_EASE }}
      transition={CONTROL_EASE}
    >
      <motion.span layout="position" key={control.kind} className="ctl-label__in">
        {control.kind === 'agent' ? (
          <>
            {mark ?? <AgentMark agent={agent.id} size={14} hostId={hostId} dot={agent.dot} />}
            <span className="ctl-label__text">
              <Trans
                t={t}
                i18nKey={
                  computer ? `label.computer.${looking ? 'looking' : 'agent'}` : 'label.agent'
                }
                values={{ agent: agent.name, target }}
                components={{ b }}
              />
            </span>
            <Button variant="secondary" size="dialog" className="h-6" onClick={onTakeOver}>
              {t('actions.takeOver')}
            </Button>
            {onStop && (
              <Button
                variant="ghost"
                size="dialog"
                className="-ml-1 h-6"
                title={stopTitle}
                data-quiet=""
                onClick={onStop}
              >
                <HugeiconsIcon icon={StopCircleIcon} strokeWidth={1.9} aria-hidden />
                {t('actions.stop')}
              </Button>
            )}
          </>
        ) : control.kind === 'you' ? (
          <>
            <span className="ctl-label__mark">
              <HugeiconsIcon
                icon={Cursor02Icon}
                strokeWidth={1.9}
                aria-hidden
                className="size-3.5"
              />
            </span>
            <span className="ctl-label__text">
              <Trans
                t={t}
                i18nKey={computer ? 'label.computer.you' : 'label.you'}
                values={{ agent: agent.name, held }}
                components={{ b, i: <i aria-hidden /> }}
              />
            </span>
            <Button size="dialog" className="h-6" onClick={onHandBack}>
              <HugeiconsIcon icon={ArrowTurnBackwardIcon} strokeWidth={1.9} aria-hidden />
              {t('actions.handBack')}
            </Button>
          </>
        ) : (
          <>
            <span className="ctl-label__mark" data-asks="">
              <HugeiconsIcon icon={Key01Icon} strokeWidth={1.9} aria-hidden className="size-3.5" />
            </span>
            <span className="ctl-label__text">
              <Trans
                t={t}
                i18nKey={
                  control.ask.target
                    ? `label.asks.${control.ask.step}`
                    : `label.asksHere.${control.ask.step}`
                }
                values={{ agent: agent.name, target: control.ask.target }}
                components={{ b }}
              />
            </span>
            <Button size="dialog" className="h-6" onClick={onDone}>
              {t('actions.done')}
            </Button>
          </>
        )}
      </motion.span>
    </motion.div>
  )
}
