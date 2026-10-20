import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'
import { buttonVariants } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'

const isMac = window.overbench.platform === 'darwin'

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)

  useEffect(() => {
    void window.overbench.app.getInfo().then(setInfo)
  }, [])

  return (
    <div className="flex h-screen flex-col select-none">
      {/* Leaves room for the macOS traffic lights drawn over the hidden title bar. */}
      <header className={cn('app-region-drag h-10 shrink-0', isMac && 'pl-20')} />
      <main className="flex flex-1 flex-col items-center justify-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">OverBench</h1>
        <p className="text-muted-foreground">Beauty is productivity.</p>
        <a
          href="https://github.com/overbench/overbench"
          target="_blank"
          rel="noreferrer"
          className={cn(buttonVariants({ variant: 'outline' }), 'mt-3')}
        >
          GitHub
        </a>
      </main>
      <footer className="flex h-8 shrink-0 items-center justify-center font-mono text-xs text-muted-foreground">
        {info && `${info.name} v${info.version} · ${info.platform}`}
      </footer>
    </div>
  )
}
