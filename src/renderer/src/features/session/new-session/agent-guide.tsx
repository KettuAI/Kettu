// New session while this computer has no agent: the main harnesses with Install.

import { useState } from 'react'
import { PlusSignIcon, RefreshIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentStatus } from '@shared/agent-host'
import { Icon } from '@renderer/components/affect/app-shell'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import { RingSpinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { cliOutdated } from '@renderer/features/agents/readiness'
import {
  addDefaultAgents,
  installKind,
  installRoute,
  openInstall,
  startInstall,
} from '@renderer/features/settings/harness-install'
import { confirmCliUpdate } from '@renderer/features/updates/command-confirm-model'
import { errorMessage } from '@renderer/lib/host'
import { hasProgram, useAgentsStore } from '@renderer/stores/agents'
import { useSettingsStore } from '@renderer/stores/settings'
import { openAgentSettings, openHarnessSettings } from '@renderer/stores/view'
import type { GuideHarness } from './guide-statuses'

const ABOUT = {
  'claude-code': 'newSession.guide.about.claude-code',
  codex: 'newSession.guide.about.codex',
  opencode: 'newSession.guide.about.opencode',
  pi: 'newSession.guide.about.pi',
} as const satisfies Record<GuideHarness, string>

/** `bare` leaves out the card's own heading, where the page above already says what it is. */
export function AgentGuide({ statuses, bare }: { statuses: AgentStatus[]; bare?: boolean }) {
  const { t } = useTranslation('session')
  const [detecting, setDetecting] = useState(false)

  // Detects again and adds the default agent of every program found that has none.
  const redetect = async () => {
    setDetecting(true)
    try {
      const found = await useAgentsStore.getState().detectedPrograms()
      const { byId } = useAgentsStore.getState()
      const added = found.filter((id) => byId[id]?.registered === false)
      if (added.length > 0) {
        const patch = addDefaultAgents(useAgentsStore, useSettingsStore, added)
        await useSettingsStore.getState().update(patch)
      }
    } catch (error) {
      toast(errorMessage(error), undefined, { tone: 'warning' })
    } finally {
      setDetecting(false)
    }
  }

  return (
    <section className="kettu-guide" aria-label={t('newSession.guide.title')}>
      {!bare && (
        <header className="kettu-guide__head">
          <b>{t('newSession.guide.title')}</b>
          <span>{t('newSession.guide.hint')}</span>
        </header>
      )}
      <ul className="kettu-guide__rows">
        {statuses.map((status) => (
          <GuideRow key={status.id} status={status} />
        ))}
      </ul>
      <footer className="kettu-guide__foot">
        <Button variant="ghost" size="sm" disabled={detecting} onClick={() => void redetect()}>
          <Icon icon={RefreshIcon} size={14} />
          {t('newSession.guide.redetect')}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => openAgentSettings(null)}>
          <Icon icon={PlusSignIcon} size={14} />
          {t('newSession.addAgent')}
        </Button>
      </footer>
    </section>
  )
}

function GuideRow({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('session')
  const { t: ts } = useTranslation('settings')
  const taskError = useAgentsStore((s) => s.taskErrors[status.id])
  const harness = status.harnessId
  const task = status.task
  const running = task?.state === 'running' || status.state === 'installing'
  const failure = task?.state === 'failed' ? (task.error ?? ts('agents.install.failedTitle')) : null
  const reason = failure ?? taskError?.message ?? null
  const kind = installKind(status)
  const minimum = cliOutdated(status)
  // A failed install is tried again by the route the user already picked in the install window.
  const install = () => {
    if (failure && task)
      void startInstall(useAgentsStore, useSettingsStore, harness, installRoute(task))
    else if (kind) void openInstall(harness)
    else openHarnessSettings(harness)
  }

  return (
    <li className="kettu-guide__row">
      <span className="kettu-guide__tile">
        <AgentTile agent={status.id} size={20} />
      </span>
      <span className="kettu-guide__name">
        <b>{status.harnessName}</b>
        <small data-error={reason ? '' : undefined} title={reason ?? undefined}>
          {reason ??
            (minimum !== null
              ? t('newSession.guide.outdated', {
                  name: status.harnessName,
                  current: status.cli?.installed?.version ?? '',
                })
              : t(ABOUT[harness as GuideHarness]))}
        </small>
      </span>
      {running ? (
        <span className="kettu-guide__busy">
          <RingSpinner />
          {ts(task?.kind === 'update' ? 'agents.update.updating' : 'agents.install.installing')}
        </span>
      ) : minimum !== null ? (
        <Button variant="outline" size="xs" onClick={() => void confirmCliUpdate(status)}>
          {ts(reason ? 'agents.update.failed' : 'agents.update.button')}
        </Button>
      ) : hasProgram(status) ? (
        <span className="kettu-guide__busy">{t('newSession.guide.found')}</span>
      ) : (
        <Button variant="outline" size="xs" onClick={install}>
          {reason ? ts('agents.install.failed') : ts('agents.install.button')}
        </Button>
      )}
    </li>
  )
}
