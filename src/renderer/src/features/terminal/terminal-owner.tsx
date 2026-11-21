import { useEffect, type RefObject } from 'react'
import { Globe02Icon, LockPasswordIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { AnimatePresence } from 'motion/react'
import { Trans, useTranslation } from 'react-i18next'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { HeldBubble } from '@renderer/components/control/held-bubble'
import { PillDock } from '@renderer/components/control/pill-dock'
import { SurfaceLight } from '@renderer/components/control/surface-light'
import { SurfacePill } from '@renderer/components/control/surface-pill'
import { useControlAgent } from '@renderer/components/control/use-control-agent'
import { useHeldBubble } from '@renderer/components/control/use-held-bubble'
import { addressText } from '@renderer/features/browser/address'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { longAgo } from '@renderer/lib/format'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { isMac } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { agentName } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import {
  handBackTerminal,
  interruptTerminal,
  takeOverTerminal,
  useTerminalsStore,
  type TerminalOwner,
  type TerminalState,
} from '@renderer/stores/terminals'
import { toggleSidePane } from '@renderer/stores/view'
import { onHeld } from './xterm-registry'

/** Over a terminal an agent started: who started it and when, with its address and Stop. */
export function OwnerBar({ terminal, owner }: { terminal: TerminalState; owner: TerminalOwner }) {
  const { t } = useTranslation('terminal')
  const now = useNow()
  const hostId = hostOfPath(terminal.projectPath)
  const sessionId = terminal.sessionId ?? owner.sessionId
  const running = terminal.busy && terminal.exitCode === null && !terminal.stale
  // Another host's localhost is not this computer's, which the session's browser runs on.
  const url = hostId === null ? terminal.localUrl : null

  const openInBrowser = () => {
    if (!sessionId || !url) return
    void window.kettu.browser.navigate(sessionId, url)
    toggleSidePane(sessionId, 'browser', true)
  }

  return (
    <div className="kp-towner">
      <AgentMark agent={owner.agentId} size={14} hostId={hostId} />
      {/* One line, so the folder at its end is cut before who started it and when. */}
      <span className="kp-towner__text">
        {t(owner.fromReply ? 'owner.fromReply' : 'owner.startedBy', {
          agent: agentName(owner.agentId, hostId),
          time: longAgo(terminal.createdAt, now),
        })}
        <span className="kp-towner__dir kp-mono" data-selectable="">
          {hostPath(terminal.projectPath)}
        </span>
      </span>
      {url && sessionId && (
        // In a narrow bar, such as one side of a split, only its icon shows.
        <button
          type="button"
          className="kp-link"
          title={t('owner.openInBrowser')}
          aria-label={t('owner.openInBrowser')}
          onClick={openInBrowser}
        >
          <PaneIcon icon={Globe02Icon} size={13} />
          <span className="kp-towner__url">{addressText(url) ?? url}</span>
        </button>
      )}
      {running && (
        <button
          type="button"
          className="kp-btn kp-btn--sm"
          onClick={() => void interruptTerminal(terminal.id)}
        >
          {t('owner.stop')}
        </button>
      )}
    </div>
  )
}

/**
 * At a terminal's foot while its program waits for a password: type it here, unseen by the agent.
 */
export function PasswordStrip({ terminal }: { terminal: TerminalState }) {
  const { t } = useTranslation('terminal')
  const hostId = hostOfPath(terminal.projectPath)
  const sessionAgent = useSessionsStore((s) =>
    terminal.sessionId ? s.byId[terminal.sessionId]?.agentId : undefined,
  )
  const agentId = terminal.owner?.agentId ?? sessionAgent
  return (
    <div className="kp-tpassword" role="status">
      <HugeiconsIcon icon={LockPasswordIcon} strokeWidth={1.9} aria-hidden />
      <span className="kp-tpassword__text">
        <Trans
          t={t}
          i18nKey={agentId ? 'password.strip' : 'password.stripNoAgent'}
          values={agentId ? { agent: agentName(agentId, hostId) } : {}}
          components={{ b: <b /> }}
        />
      </span>
    </div>
  )
}

/**
 * Over a terminal an agent's running turn uses: the light along its inner edge, the pill at its
 * foot with Take over or Hand back, and the bubble at the cursor when typing is held back.
 */
export function TerminalControl({
  terminal,
  owner,
  box,
  radius,
}: {
  terminal: TerminalState
  owner: TerminalOwner
  /** The box it sits in, whose pixels the bubble is placed in. */
  box: RefObject<HTMLDivElement | null>
  /** The box's corners as the sheet clips them, which the light follows. */
  radius: string
}) {
  const { t } = useTranslation('control')
  const control = useTerminalsStore((s) => s.controls[terminal.id] ?? null)
  const hostId = hostOfPath(terminal.projectPath)
  const agent = useControlAgent(owner.agentId, hostId)
  const agentName = agent?.name ?? t('agent')
  const bubble = useHeldBubble()
  const { held } = bubble

  useEffect(
    () =>
      onHeld(terminal.id, (at) => {
        const room = box.current?.getBoundingClientRect()
        held(room ? { x: at.x - room.left, y: at.y - room.top } : null)
      }),
    [terminal.id, box, held],
  )

  const takeOver = () => takeOverTerminal(terminal.id)
  const holds = control?.kind === 'agent'
  return (
    <>
      <AnimatePresence>{holds && <SurfaceLight key="light" radius={radius} />}</AnimatePresence>
      {holds && bubble.bubble && (
        <HeldBubble
          key={bubble.bubble.id}
          at={bubble.bubble.at}
          agentName={agentName}
          scope={t('scope.terminal')}
          hint={t('bubble.hintTerminal', { keys: isMac ? '⌃C' : 'Ctrl+C' })}
          leaving={bubble.bubble.leaving}
          onTakeOver={takeOver}
        />
      )}
      <PillDock kind="terminal" className="kp-tbox__pill">
        <AnimatePresence>
          {control && (
            <SurfacePill
              key="pill"
              control={control}
              agent={agent}
              agentName={agentName}
              scope={t('scope.terminal')}
              nudge={bubble.nudge}
              onTakeOver={takeOver}
              onHandBack={() => handBackTerminal(terminal.id)}
              onDone={() => handBackTerminal(terminal.id)}
            />
          )}
        </AnimatePresence>
      </PillDock>
    </>
  )
}
