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
import { InstallDialog } from '@renderer/features/settings/harness-section'
import {
  addDefaultAgents,
  installKind,
  startInstall,
} from '@renderer/features/settings/harness-install'
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

export function AgentGuide({ statuses }: { statuses: AgentStatus[] }) {
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
      <header className="kettu-guide__head">
        <b>{t('newSession.guide.title')}</b>
        <span>{t('newSession.guide.hint')}</span>
      </header>
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
  const [installing, setInstalling] = useState(false)
  const harness = status.harnessId
  const task = status.task
  const running = task?.state === 'running' || status.state === 'installing'
  const failure = task?.state === 'failed' ? (task.error ?? ts('agents.install.failedTitle')) : null
  const reason = failure ?? taskError?.message ?? null
  const kind = installKind(status)
  const install = () => {
    if (kind === 'program') setInstalling(true)
    else if (kind === 'package')
      void startInstall(useAgentsStore, useSettingsStore, harness, task?.method)
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
          {reason ?? t(ABOUT[harness as GuideHarness])}
        </small>
      </span>
      {running ? (
        <span className="kettu-guide__busy">
          <RingSpinner />
          {ts('agents.install.installing')}
        </span>
      ) : hasProgram(status) ? (
        <span className="kettu-guide__busy">{t('newSession.guide.found')}</span>
      ) : (
        <Button variant="outline" size="xs" onClick={install}>
          {reason ? ts('agents.install.failed') : ts('agents.install.button')}
        </Button>
      )}
      {kind === 'program' && (
        <InstallDialog status={status} open={installing} onOpenChange={setInstalling} />
      )}
    </li>
  )
}
