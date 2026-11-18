import { useId, type ReactNode } from 'react'
import {
  ArrowTurnBackwardIcon,
  Cursor02Icon,
  Key01Icon,
  StopCircleIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { motion, useIsPresent } from 'motion/react'
import { Trans, useTranslation } from 'react-i18next'
import type { ActiveControl, ControlAgent, ControlSurface } from '@shared/control'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { CONTROL_EASE, CONTROL_LEAVE_EASE } from './motion'

export function ControlLabelRow({
  surface,
  kind,
  mark,
  text,
  textId,
  title,
  children,
}: {
  surface: ControlSurface
  kind: ActiveControl['kind'] | 'waiting'
  mark: ReactNode
  text: ReactNode
  textId?: string
  title?: string
  children?: ReactNode
}) {
  const present = useIsPresent()
  return (
    <motion.div
      data-control-label=""
      data-control={kind}
      data-surface={surface}
      className="ctl-label"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: CONTROL_LEAVE_EASE }}
      transition={CONTROL_EASE}
      inert={!present}
    >
      <span className="ctl-label__mark" aria-hidden>
        {mark}
      </span>
      <span id={textId} role="status" className="ctl-label__text" title={title}>
        {text}
      </span>
      {children && <div className="ctl-label__actions">{children}</div>}
    </motion.div>
  )
}

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
  const textId = useId()
  const b = <b dir="auto" />
  const computer = surface === 'computer'
  let title = target
  let text: ReactNode
  let actionLabel: string
  let onAction: () => void
  switch (control.kind) {
    case 'agent':
      text = (
        <Trans
          t={t}
          i18nKey={computer ? `label.computer.${looking ? 'looking' : 'agent'}` : 'label.agent'}
          values={{ agent: agent.name, target }}
          components={{ b }}
        />
      )
      actionLabel = t('actions.takeOver')
      onAction = onTakeOver
      break
    case 'you':
      title = held
      text = (
        <Trans
          t={t}
          i18nKey={computer ? 'label.computer.you' : 'label.you'}
          values={{ agent: agent.name, held }}
          components={{ b, i: <i aria-hidden /> }}
        />
      )
      actionLabel = t('actions.handBack')
      onAction = onHandBack
      break
    case 'asks':
      title = control.ask.target ?? target
      text = (
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
      )
      actionLabel = t('actions.done')
      onAction = onDone
      break
  }
  const indicator =
    control.kind === 'agent' ? (
      (mark ?? <AgentMark agent={agent.id} size={14} hostId={hostId} dot={agent.dot} />)
    ) : (
      <HugeiconsIcon
        icon={control.kind === 'you' ? Cursor02Icon : Key01Icon}
        strokeWidth={1.9}
        className="size-3.5"
      />
    )
  return (
    <ControlLabelRow
      surface={surface}
      kind={control.kind}
      mark={indicator}
      text={text}
      textId={textId}
      title={title}
    >
      <Button
        variant={control.kind === 'agent' ? 'secondary' : 'default'}
        size="dialog"
        className="h-6"
        aria-describedby={textId}
        onClick={onAction}
      >
        {control.kind === 'you' && (
          <HugeiconsIcon icon={ArrowTurnBackwardIcon} strokeWidth={1.9} aria-hidden />
        )}
        {actionLabel}
      </Button>
      {control.kind === 'agent' && onStop && (
        <Button
          variant="ghost"
          size="dialog"
          className="h-6"
          title={stopTitle}
          aria-describedby={textId}
          data-quiet=""
          onClick={onStop}
        >
          <HugeiconsIcon icon={StopCircleIcon} strokeWidth={1.9} aria-hidden />
          {t('actions.stop')}
        </Button>
      )}
    </ControlLabelRow>
  )
}
