import { useId } from 'react'
import { KeyboardIcon, LockPasswordIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { AnimatePresence } from 'motion/react'
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId } from '@shared/thread'
import { ControlLabel, ControlLabelRow } from '@renderer/components/control/control-label'
import { useControlAgent } from '@renderer/components/control/use-control-agent'
import { Button } from '@renderer/components/ui/button'
import {
  handBackTerminal,
  revealTerminal,
  takeOverTerminal,
  useTerminalsStore,
} from '@renderer/stores/terminals'

export function TerminalLabels({
  sessionId,
  agentId,
  hostId,
}: {
  sessionId: string
  agentId: AgentId
  hostId: string | null
}) {
  const terminals = useTerminalsStore(
    useShallow((s) =>
      Object.values(s.byId).filter(
        (terminal) =>
          !terminal.stale &&
          (terminal.owner?.sessionId ?? terminal.sessionId) === sessionId &&
          (terminal.control.kind !== 'idle' || terminal.waiting === 'password'),
      ),
    ),
  )
  const agent = useControlAgent(agentId, hostId)
  return (
    <AnimatePresence>
      {agent &&
        terminals.map((terminal) => {
          const { id, control } = terminal
          const name = terminal.name ?? (terminal.title || terminal.shell)
          if (terminal.waiting === 'password') {
            return <TerminalPasswordLabel key={id} id={id} name={name} agent={agent.name} />
          }
          if (control.kind === 'idle') return null
          return (
            <ControlLabel
              key={id}
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
        })}
    </AnimatePresence>
  )
}

function TerminalPasswordLabel({ id, name, agent }: { id: string; name: string; agent: string }) {
  const { t } = useTranslation('terminal')
  const textId = useId()
  return (
    <ControlLabelRow
      surface="terminal"
      kind="asks"
      title={name}
      textId={textId}
      mark={<HugeiconsIcon icon={LockPasswordIcon} strokeWidth={1.9} className="size-3.5" />}
      text={
        <Trans
          t={t}
          i18nKey="password.label"
          values={{ agent, terminal: name }}
          components={{ b: <b dir="auto" /> }}
        />
      }
    >
      <Button
        size="dialog"
        className="h-6"
        aria-describedby={textId}
        onClick={() => revealTerminal(id)}
      >
        <HugeiconsIcon icon={KeyboardIcon} strokeWidth={1.9} aria-hidden />
        {t('password.go')}
      </Button>
    </ControlLabelRow>
  )
}
