import { useTranslation } from 'react-i18next'
import type { GitStatus } from '@shared/git'
import { useRefresh } from '@renderer/components/refresh'
import { RefreshIcon } from '@renderer/components/refresh-icon'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useGitStore } from '@renderer/stores/git'
import { runStep } from './steps'
import { commandOf } from './sync'

/** Fetches the project's remote; it turns while the fetch runs, and says why when it cannot. */
export function FetchButton({ status }: { status: GitStatus }) {
  const { t } = useTranslation('git')
  const running = useGitStore((s) => s.running[status.projectPath] ?? null)
  const refresh = useRefresh({ busy: running?.kind === 'fetch' })
  const { remote } = status

  const fetchNow = (): void => {
    void refresh
      .run(async () => {
        // A failed fetch has its toast, so reject to keep the icon from a check.
        if (!(await runStep(status.projectPath, { kind: 'fetch' }))) {
          throw new Error('fetch failed')
        }
      })
      .catch(() => {})
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={t('sync.fetch')}
          aria-busy={refresh.phase === 'turning'}
          disabled={!remote || !!running || refresh.phase === 'turning'}
          onClick={fetchNow}
          className="text-tertiary"
        >
          <RefreshIcon phase={refresh.phase} className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {!remote
          ? t('reason.noRemote')
          : running && running.kind !== 'fetch'
            ? t('sync.waiting')
            : commandOf(status, 'fetch')}
      </TooltipContent>
    </Tooltip>
  )
}
