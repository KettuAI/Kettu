// What a personal Google sign-in of Antigravity means for using it in Kettu: shown on the agent's
// page while it applies, and once where the user first picks or starts it, until dismissed.

import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { AlertCircleIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import type { AgentStatus } from '@shared/agent-host'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { readJson, writeJson } from '@renderer/lib/storage'

const TERMS = 'https://antigravity.google/terms'
const DISMISSED_KEY = 'agents.personalPlanNotice'

/** The notice's text, its "terms" a link to the vendor's terms. */
export function PersonalPlanText() {
  const { t } = useTranslation('settings')
  return (
    <Trans
      t={t}
      i18nKey="agents.personalPlan.body"
      components={{
        terms: <a href={TERMS} target="_blank" rel="noreferrer" className="k-link" />,
      }}
    />
  )
}

/** The notice the first time a personally signed-in Antigravity is picked or used; dismissed for good. */
export function PersonalPlanFirstUse({
  status,
  className,
}: {
  status: AgentStatus | undefined
  className?: string
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [dismissed, setDismissed] = useState(() => readJson<unknown>(DISMISSED_KEY, false) === true)
  if (dismissed || !status?.personalSignIn) return null
  const dismiss = () => {
    writeJson(DISMISSED_KEY, true)
    setDismissed(true)
  }
  return (
    <Alert variant="info" className={cn('has-data-[slot=alert-action]:pr-24', className)}>
      <HugeiconsIcon icon={AlertCircleIcon} strokeWidth={1.9} aria-hidden />
      <AlertTitle>{t('agents.personalPlan.title', { agent: status.name })}</AlertTitle>
      <AlertDescription>
        <PersonalPlanText />
      </AlertDescription>
      <AlertAction>
        <Button size="xs" variant="outline" onClick={dismiss}>
          {t('agents.personalPlan.dismiss')}
        </Button>
      </AlertAction>
    </Alert>
  )
}
