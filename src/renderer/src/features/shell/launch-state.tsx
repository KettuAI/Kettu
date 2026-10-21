import { useEffect, useState } from 'react'
import { loadHostState } from '@renderer/app/bootstrap'
import { Spinner } from '@renderer/components/ui/spinner'
import { FailedState } from '@renderer/features/session/session-states'
import { useProjectsStore } from '@renderer/stores/projects'

/**
 * The main area before the project list arrives. A launch that takes longer than 1 s shows
 * "Starting OverBench…", so a slow start never looks frozen; a normal start shows nothing.
 */
export function LaunchState() {
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
            title="Couldn't load your projects"
            message={error}
            onRetry={() => void loadHostState()}
          />
        </div>
      </div>
    )
  }
  if (!slow) return <div className="h-full" />
  return (
    <div
      role="status"
      className="flex h-full animate-in items-center justify-center gap-2.5 pb-10 text-[15px] font-medium text-muted-foreground duration-(--duration-base) fade-in"
    >
      <Spinner className="size-[18px]" />
      Starting OverBench…
    </div>
  )
}
