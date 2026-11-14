import { useState } from 'react'
import { ComputerIcon, DashboardSquare01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { AnimatePresence } from 'motion/react'
import { Trans, useTranslation } from 'react-i18next'
import { computerControl, stopShortcutText } from '@shared/computer-use'
import type { AgentId, ComputerUseView } from '@shared/thread'
import { ControlLabel } from '@renderer/components/control/control-label'
import { useControlAgent } from '@renderer/components/control/use-control-agent'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage, host } from '@renderer/lib/host'
import { platform } from '@renderer/lib/platform'
import { useSettingsStore } from '@renderer/stores/settings'
import { useThreadsStore } from '@renderer/stores/threads'
import { useAppIcon } from './app-icon'

/** How far back from the thread's end a waiting app card is looked for: it follows the agent. */
const WAITING_LOOKBACK = 40

/** The app's icon as the system draws it, or a window's when it has none. */
export function AppMark({ icon, app }: { icon: string | null; app: string | null }) {
  return (
    <span className="ctl-app-icon">
      {icon ? (
        <img src={icon} alt="" draggable={false} />
      ) : (
        <HugeiconsIcon
          icon={app ? DashboardSquare01Icon : ComputerIcon}
          strokeWidth={1.9}
          aria-hidden
          className="size-3.75"
        />
      )}
    </span>
  )
}

/** The name of the app a card in the session waits on the user to allow, if one does. */
function useWaitingApp(sessionId: string): string | null {
  return useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    if (!state) return null
    const { order, byId } = state
    for (let i = order.length - 1; i >= Math.max(0, order.length - WAITING_LOOKBACK); i--) {
      const entry = byId[order[i]!]
      if (entry?.kind === 'computer_app' && entry.decision === null) return entry.appName
    }
    return null
  })
}

/**
 * On the composer's top edge while the session holds the computer: the shared control label for
 * the app it uses, with Stop, which ends computer use for the rest of the turn, not the turn. While
 * a new app waits for the user's answer, or Stop takes the computer back, it says so instead.
 */
export function ComputerLabel({
  sessionId,
  view,
  agentId,
  hostId,
  onError,
}: {
  sessionId: string
  /** The session's hold on the computer; null draws nothing, and the label leaves. */
  view: ComputerUseView | null
  agentId: AgentId
  hostId: string | null
  onError: (message: string | null) => void
}) {
  const { t } = useTranslation(['control', 'session'])
  const [stopping, setStopping] = useState(false)
  const app = view?.app ?? null
  const icon = useAppIcon(view?.appPath ?? null)
  const waiting = useWaitingApp(sessionId)
  const agent = useControlAgent(agentId, hostId)
  const shortcut = useSettingsStore((s) => s.settings.computerUse.stopShortcut)
  // The computer was taken back: the next hold starts with the plain label.
  if (!view && stopping) setStopping(false)

  const stop = async () => {
    setStopping(true)
    onError(null)
    try {
      await host('computer.stop', { sessionId })
    } catch (caught) {
      onError(errorMessage(caught))
      setStopping(false)
    }
  }
  const control = (method: 'computer.takeOver' | 'computer.handBack') => {
    onError(null)
    host(method, { sessionId }).catch((caught: unknown) => onError(errorMessage(caught)))
  }

  // The stop shortcut works on this computer, for the apps of this computer.
  const stopTitle =
    hostId === null
      ? `${t('session:computerBar.stopLabel')}  ${stopShortcutText(shortcut, platform)}`
      : t('session:computerBar.stopLabel')

  let label = null
  if (view && stopping) {
    label = (
      <div
        key="computer"
        role="status"
        className="ctl-label"
        data-surface="computer"
        data-control="agent"
        style={{ borderTopLeftRadius: 12, borderTopRightRadius: 12 }}
      >
        <span className="ctl-label__in pr-3">
          <Spinner className="size-3.5 shrink-0" />
          <span className="ctl-label__text">{t('session:computerBar.stopping')}</span>
        </span>
      </div>
    )
  } else if (view && waiting) {
    label = (
      <div
        key="computer"
        role="status"
        className="ctl-label"
        data-surface="computer"
        data-control="waiting"
        style={{ borderTopLeftRadius: 12, borderTopRightRadius: 12 }}
      >
        <span className="ctl-label__in pr-3">
          <HugeiconsIcon
            icon={DashboardSquare01Icon}
            strokeWidth={1.9}
            aria-hidden
            className="size-3.75 shrink-0"
          />
          <span className="ctl-label__text">
            <Trans
              t={t}
              i18nKey="session:computerBar.waiting"
              values={{ app: waiting }}
              components={{ app: <b dir="auto" /> }}
            />
          </span>
        </span>
      </div>
    )
  } else if (view && agent) {
    label = (
      <ControlLabel
        key="computer"
        surface="computer"
        control={computerControl(view.control)}
        agent={agent}
        hostId={hostId}
        target={app ?? t('target.computer')}
        held={app ?? t('held.computer')}
        mark={<AppMark icon={icon} app={app} />}
        looking={!!app && view.action === 'read'}
        stopTitle={stopTitle}
        onTakeOver={() => control('computer.takeOver')}
        onHandBack={() => control('computer.handBack')}
        onDone={() => {}}
        onStop={() => void stop()}
      />
    )
  }
  return <AnimatePresence>{label}</AnimatePresence>
}
