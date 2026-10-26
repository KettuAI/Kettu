import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { loadHostState } from '@renderer/app/bootstrap'
import { BrandMark } from '@renderer/components/brand'
import { Spinner } from '@renderer/components/ui/spinner'
import { FailedState } from '@renderer/features/session/session-states'
import { useProjectsStore } from '@renderer/stores/projects'

/**
 * The main area until launch knows what to show. A launch that takes longer than 1 s shows the mark
 * over "Starting OverBench…", so a slow start never looks frozen; a normal start shows nothing.
 */
export function LaunchState() {
  const { t } = useTranslation('shell')
  const error = useProjectsStore((s) => s.error)
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [])

  if (error) {
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
  if (!slow) return <div className="h-full" />
  return (
    <div className="flex h-full animate-in flex-col items-center justify-center gap-6 pb-10 animation-duration-(--duration-base) fade-in">
      <BrandMark width={72} />
      <div role="status" className="flex items-center gap-2.5 text-ui font-medium text-secondary">
        <Spinner className="size-4" />
        {t('launch.starting')}
      </div>
    </div>
  )
}
