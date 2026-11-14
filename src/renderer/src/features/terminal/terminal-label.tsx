import { KeyboardIcon, LockPasswordIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { AnimatePresence, motion } from 'motion/react'
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId } from '@shared/thread'
import { ControlLabel } from '@renderer/components/control/control-label'
import { CONTROL_EASE, CONTROL_LEAVE_EASE } from '@renderer/components/control/motion'
import { useControlAgent } from '@renderer/components/control/use-control-agent'
import { Button } from '@renderer/components/ui/button'
import {
  handBackTerminal,
  revealTerminal,
  takeOverTerminal,
  terminalAskingPassword,
  terminalInUse,
  useTerminalsStore,
} from '@renderer/stores/terminals'

/**
 * On the composer's top edge while a terminal of the session waits for the user's password, or
 * else while the session's turn uses a terminal its agent started.
 */
export function TerminalLabel({
  sessionId,
  agentId,
  hostId,
}: {
  sessionId: string
  agentId: AgentId
  hostId: string | null
}) {
  const { t } = useTranslation('terminal')
  const used = useTerminalsStore(
    useShallow((s) => {
      const found = terminalInUse(s, sessionId)
      return found ?? { id: null, name: '', control: null }
    }),
  )
  const asking = useTerminalsStore(
    useShallow((s) => terminalAskingPassword(s, sessionId) ?? { id: null, name: '' }),
  )
  const agent = useControlAgent(agentId, hostId)
  const { id, name, control } = used
  return (
    <AnimatePresence>
      {asking.id && agent ? (
        <motion.div
          key="terminal-password"
          layout
          role="status"
          data-control-label=""
          data-control="asks"
          data-surface="terminal"
          className="ctl-label"
          style={{ borderTopLeftRadius: 12, borderTopRightRadius: 12 }}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12, filter: 'blur(2px)', transition: CONTROL_LEAVE_EASE }}
          transition={CONTROL_EASE}
        >
          <span className="ctl-label__in">
            <span className="ctl-label__mark" data-asks="">
              <HugeiconsIcon
                icon={LockPasswordIcon}
                strokeWidth={1.9}
                aria-hidden
                className="size-3.5"
              />
            </span>
            <span className="ctl-label__text">
              <Trans
                t={t}
                i18nKey="password.label"
                values={{ agent: agent.name, terminal: asking.name }}
                components={{ b: <b dir="auto" /> }}
              />
            </span>
            <Button size="dialog" className="h-6" onClick={() => revealTerminal(asking.id!)}>
              <HugeiconsIcon icon={KeyboardIcon} strokeWidth={1.9} aria-hidden />
              {t('password.go')}
            </Button>
          </span>
        </motion.div>
      ) : (
        id &&
        control &&
        agent && (
          <ControlLabel
            key="terminal"
            surface="terminal"
            control={control}
            agent={agent}
            hostId={hostId}
            target={name}
            held={name}
            onTakeOver={() => takeOverTerminal(id)}
            onHandBack={() => handBackTerminal(id)}
            onDone={() => handBackTerminal(id)}
          />
        )
      )}
    </AnimatePresence>
  )
}
