import { useEffect, useState, type ReactNode } from 'react'
import { CircleCheckIcon, ExternalLinkIcon } from 'lucide-react'
import type { AppInfo } from '@shared/ipc'
import { releaseUrl, type UpdateStatus } from '@shared/updates'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { Spinner } from '@renderer/components/ui/spinner'
import { CopyButton } from '@renderer/features/git/branch-popover'
import { longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { useSettingsStore } from '@renderer/stores/settings'
import { checkForUpdates, useUpdatesStore } from '@renderer/stores/updates'
import { ControlError, SettingSelect } from './controls'
import { useApply } from './use-apply'

function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null)
  useEffect(() => {
    void window.overbench.app.getInfo().then(setInfo)
  }, [])
  return info
}

export function Version() {
  const info = useAppInfo()
  if (!info) return <Spinner className="size-3.5 text-muted-foreground" />
  const text = `OverBench ${info.version} (${info.platform} ${info.arch})\nElectron ${info.versions.electron}\nChromium ${info.versions.chrome}\nNode.js ${info.versions.node}`
  return (
    <div className="flex items-start gap-2">
      <dl
        className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5 text-right text-xs tabular"
        data-selectable=""
      >
        <dt className="text-muted-foreground">Electron</dt>
        <dd className="font-mono text-[11.5px]">{info.versions.electron}</dd>
        <dt className="text-muted-foreground">Chromium</dt>
        <dd className="font-mono text-[11.5px]">{info.versions.chrome}</dd>
        <dt className="text-muted-foreground">Node.js</dt>
        <dd className="font-mono text-[11.5px]">{info.versions.node}</dd>
      </dl>
      <CopyButton text={text} label="Copy versions" />
    </div>
  )
}

export function UpdateRow({ status }: { status: UpdateStatus | null }) {
  const justChecked = useUpdatesStore((s) => s.justChecked)
  const now = useNow()
  const [error, setError] = useState<string | null>(null)
  const run = (action: () => Promise<unknown>) => {
    setError(null)
    action().catch((e: unknown) => setError(errorMessage(e)))
  }
  if (!status) return <Spinner className="size-3.5 text-muted-foreground" />
  const { state } = status
  const whatsNew = (version: string) => (
    <a
      href={releaseUrl(version)}
      target="_blank"
      rel="noreferrer"
      className={buttonVariants({ variant: 'quiet', size: 'compact' })}
    >
      What's new
    </a>
  )

  let text: ReactNode
  let action: ReactNode = null
  if (justChecked && state.kind === 'idle') {
    text = (
      <span
        key="checked"
        className="inline-flex animate-in items-center gap-1.5 fade-in animation-duration-(--duration-base)"
      >
        <CircleCheckIcon className="size-3.5 text-success" />
        Up to date
      </span>
    )
  } else {
    switch (state.kind) {
      case 'idle':
        text = (
          <span className="flex flex-col">
            <span>You're up to date</span>
            {state.checkedAt && (
              <span className="text-xs text-muted-foreground">
                Checked {longAgo(state.checkedAt, now)}
              </span>
            )}
          </span>
        )
        action = (
          <Button variant="outline" size="compact" onClick={() => run(checkForUpdates)}>
            Check for updates
          </Button>
        )
        break
      case 'checking':
        text = (
          <span className="inline-flex items-center gap-1.5 text-muted-foreground">
            <Spinner className="size-3.5" />
            Checking for updates…
          </span>
        )
        break
      case 'downloading':
        text = (
          <span className="flex w-56 flex-col gap-1.5">
            <span className="flex justify-between tabular">
              Downloading {state.version}
              <span className="text-muted-foreground">{Math.round(state.percent)}%</span>
            </span>
            <Progress value={state.percent} aria-label="Download progress" />
          </span>
        )
        break
      case 'ready':
        text = `${state.version} is ready to install`
        action = (
          <>
            {whatsNew(state.version)}
            <Button size="compact" onClick={() => run(window.overbench.updates.restart)}>
              Restart
            </Button>
          </>
        )
        break
      case 'available':
        text = `${state.version} is available`
        action = (
          <>
            {whatsNew(state.version)}
            {state.mode === 'link' ? (
              <a
                href={releaseUrl(state.version)}
                target="_blank"
                rel="noreferrer"
                className={buttonVariants({ size: 'compact' })}
              >
                Download
                <ExternalLinkIcon data-icon="inline-end" />
              </a>
            ) : (
              <Button size="compact" onClick={() => run(window.overbench.updates.download)}>
                Download
              </Button>
            )}
          </>
        )
        break
      case 'error':
        text = (
          <span className="flex flex-col">
            <span>Couldn't check for updates</span>
            <span className="text-xs text-muted-foreground" data-selectable="">
              {state.message}
            </span>
          </span>
        )
        action = (
          <Button variant="outline" size="compact" onClick={() => run(checkForUpdates)}>
            Try again
          </Button>
        )
        break
      case 'off':
        text = (
          <span className="text-muted-foreground">
            {state.reason === 'development'
              ? 'Updates are off in development builds'
              : 'Updates are installed by your package manager'}
          </span>
        )
    }
  }
  return (
    <div className="flex min-h-control w-full items-center gap-3 text-[13px]">
      <span className="min-w-0 flex-1">{text}</span>
      <ControlError error={error} />
      {action && <span className="flex shrink-0 items-center gap-1.5">{action}</span>}
    </div>
  )
}

export function AutomaticUpdates() {
  const value = useSettingsStore((s) => s.settings.updates.automatic)
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label="Automatic updates"
        value={value}
        options={[
          { value: 'download', label: 'Download and install' },
          { value: 'notify', label: 'Notify only' },
          { value: 'off', label: 'Off' },
        ]}
        onChange={(v) => apply({ updates: { automatic: v } })}
      />
    </>
  )
}
