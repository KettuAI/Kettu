import { useEffect, useState } from 'react'
import { Spinner } from '@renderer/components/ui/spinner'
import { useProjectsStore } from '@renderer/stores/projects'

/**
 * A launch that takes longer than 1 s shows "Starting OverBench…" over the main area, so a slow
 * start never looks frozen; a normal start never shows it.
 */
export function LaunchState() {
  const loaded = useProjectsStore((s) => s.loaded)
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (loaded) return
    const timer = setTimeout(() => setSlow(true), 1000)
    return () => clearTimeout(timer)
  }, [loaded])
  if (loaded || !slow) return null
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-y-0 right-0 left-[260px] flex animate-in items-center justify-center gap-2.5 pb-10 text-[15px] font-medium text-muted-foreground duration-(--duration-base) fade-in"
    >
      <Spinner className="size-[18px]" />
      Starting OverBench…
    </div>
  )
}
