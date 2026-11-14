import { AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/thread'
import { ControlLabel } from '@renderer/components/control/control-label'
import { useControlAgent } from '@renderer/components/control/use-control-agent'
import { useBrowserStore } from '@renderer/stores/browser'

/** On the composer's top edge while a turn uses the session's page, whatever pane shows. */
export function BrowserLabel({
  sessionId,
  agentId,
  hostId,
}: {
  sessionId: string
  agentId: AgentId
  hostId: string | null
}) {
  const { t } = useTranslation('control')
  const control = useBrowserStore((s) => s.bySession[sessionId]?.control)
  const agent = useControlAgent(agentId, hostId)
  const active = control && control.kind !== 'idle' ? control : null
  const failed = (error: unknown) => console.error('Could not reach the page', error)
  return (
    <AnimatePresence>
      {active && agent && (
        <ControlLabel
          key="browser"
          surface="browser"
          control={active}
          agent={agent}
          hostId={hostId}
          target={t('target.browser')}
          held={t('held.tab')}
          onTakeOver={() => void window.kettu.browser.takeOver(sessionId).catch(failed)}
          onHandBack={() => void window.kettu.browser.handBack(sessionId).catch(failed)}
          onDone={() => void window.kettu.browser.answerAsk(sessionId, 'done').catch(failed)}
        />
      )}
    </AnimatePresence>
  )
}
