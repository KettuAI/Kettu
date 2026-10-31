import { useTranslation } from 'react-i18next'
import { loadHostState } from '@renderer/app/bootstrap'
import { FailedState } from '@renderer/features/session/session-states'
import { useProjectsStore } from '@renderer/stores/projects'

/** The main area until launch knows what to show: empty under the launch cover, or the failure. */
export function LaunchState() {
  const { t } = useTranslation('shell')
  const error = useProjectsStore((s) => s.error)

  if (!error) return <div className="h-full" />
  return (
    <div className="flex h-full items-center justify-center px-6 pb-10">
      <div className="w-full max-w-[460px]">
        <FailedState
          title={t('launch.loadFailed')}
          message={error}
          onRetry={() => void loadHostState()}
        />
      </div>
    </div>
  )
}
