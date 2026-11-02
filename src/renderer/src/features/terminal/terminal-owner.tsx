import { AppWindowIcon, LockIcon, SquareIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { Kbd, KbdGroup } from '@renderer/components/ui/kbd'
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
import { toggleSidePane, useViewStore } from '@renderer/stores/view'

/** Over a terminal an agent started: who started it and when, with its address and Stop. */
export function OwnerBar({ terminal, owner }: { terminal: TerminalState; owner: TerminalOwner }) {
  const { t } = useTranslation('terminal')
  const now = useNow()
  const hostId = hostOfPath(terminal.projectPath)
  const shownSession = useViewStore((s) => (s.main.kind === 'session' ? s.main.sessionId : null))
  const sessionId = owner.sessionId ?? shownSession
  const running = terminal.busy && terminal.exitCode === null && !terminal.stale
  // Another host's localhost is not this computer's, which the session's browser runs on.
  const url = hostId === null ? terminal.localUrl : null

  const openInBrowser = () => {
    if (!sessionId || !url) return
    void window.kettu.browser.navigate(sessionId, url)
    toggleSidePane(terminal.projectPath, 'browser', true)
  }

  return (
    <div className="flex h-9.5 shrink-0 items-center gap-2.5 pr-2.5 pl-3.5 text-hint text-secondary shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]">
      <AgentMark agent={owner.agentId} size={14} />
      {/* The folder gives way first; who started it and when stay readable. */}
      <span className="min-w-0 truncate">
        {t('owner.startedBy', {
          agent: agentName(owner.agentId, hostId),
          time: longAgo(terminal.createdAt, now),
        })}
      </span>
      <span aria-hidden className="text-border-strong">
        ·
      </span>
      <span
        className="min-w-0 shrink-100 truncate font-mono text-caption text-tertiary"
        data-selectable=""
      >
        {hostPath(terminal.projectPath)}
      </span>
      <span className="flex-1" />
      {url && sessionId && (
        <Button variant="ghost" size="sm" className="h-6.5 px-3" onClick={openInBrowser}>
          <AppWindowIcon className="size-3.5" strokeWidth={1.5} />
          {t('owner.openInBrowser')}
        </Button>
      )}
      {running && (
        <Button
          variant="outline"
          size="sm"
          className="h-6.5 px-3"
          onClick={() => void interruptTerminal(terminal.id)}
        >
          <SquareIcon className="size-3.5" strokeWidth={1.5} />
          {t('owner.stop')}
        </Button>
      )}
    </div>
  )
}

/** Under a terminal an agent is using: typing takes it over, and Ctrl+C stops its process. */
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
    <div className="flex h-10 shrink-0 items-center gap-2.5 bg-code-block px-3.5 text-hint text-tertiary shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
      <LockIcon aria-hidden className="size-3.25 shrink-0" strokeWidth={1.4} />
      <span className="min-w-0 flex-1 truncate">{t('owner.notice', { agent })}</span>
      <KbdGroup className="shrink-0">
        <Kbd className="h-5.5 min-w-5.5 px-1.5">{isMac ? '⌃' : 'Ctrl'}</Kbd>
        <Kbd className="h-5.5 min-w-5.5 px-1.5">C</Kbd>
      </KbdGroup>
      <span className="shrink-0">{t('owner.stops')}</span>
    </div>
  )
}
