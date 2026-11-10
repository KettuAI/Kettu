import { Globe02Icon, SquareLock02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { addressText } from '@renderer/features/browser/address'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { longAgo } from '@renderer/lib/format'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { isMac } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { agentName } from '@renderer/stores/agents'
import {
  interruptTerminal,
  type TerminalOwner,
  type TerminalState,
} from '@renderer/stores/terminals'
import { toggleSidePane } from '@renderer/stores/view'

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
        {t('owner.startedBy', {
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

/** At the foot of a terminal an agent is using: typing takes it over, and Ctrl+C stops it. */
export function TakeoverNotice({
  terminal,
  owner,
}: {
  terminal: TerminalState
  owner: TerminalOwner
}) {
  const { t } = useTranslation('terminal')
  const agent = agentName(owner.agentId, hostOfPath(terminal.projectPath))
  return (
    <p className="kp-tlock">
      <PaneIcon icon={SquareLock02Icon} size={13} />
      <span>
        {t('owner.notice', { agent })} <kbd>{isMac ? '⌃C' : 'Ctrl+C'}</kbd> {t('owner.stops')}
      </span>
    </p>
  )
}
