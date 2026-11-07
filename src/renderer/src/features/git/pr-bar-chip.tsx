import { useTranslation } from 'react-i18next'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useGitStore } from '@renderer/stores/git'
import { PrIcon } from './pr-icon'
import { prStateText } from './pr-text'

const CHECKS_KEY = {
  passing: 'pr.checks.passing',
  failing: 'pr.checks.failing',
  pending: 'pr.checks.pending',
} as const

/** The branch's pull request as a chip in the session's top bar; it opens the pull request. */
export function PrBarChip({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation('git')
  const pr = useGitStore((s) => s.currentPr[projectPath] ?? null)
  if (!pr) return null
  const live = pr.state === 'open' || pr.state === 'draft'
  const state =
    live && pr.checks.state !== 'none' ? t(CHECKS_KEY[pr.checks.state]) : prStateText(pr.state)
  const label = t('status.pullRequestState', { number: pr.number, state })
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            aria-label={label}
            className="ks-chip app-region-no-drag"
          />
        }
      >
        <PrIcon state={pr.state} size={13} className="text-current" />
        <span className="tabular">#{pr.number}</span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
