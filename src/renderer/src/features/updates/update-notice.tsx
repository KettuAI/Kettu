import { CircleArrowUpIcon, CircleCheckIcon, ExternalLinkIcon, XIcon } from 'lucide-react'
import { releaseUrl, type UpdateStatus } from '@shared/updates'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { useUpdatesStore } from '@renderer/stores/updates'

type Notice =
  | { kind: 'ready'; version: string }
  | { kind: 'link'; version: string }
  | { kind: 'updated'; version: string }

/** Which notice the footer shows, if any: only when there is something to do. */
function noticeFor(status: UpdateStatus | null, updatedSeen: boolean): Notice | null {
  if (!status) return null
  const { state } = status
  if (state.kind === 'ready' && status.dismissed !== state.version)
    return { kind: 'ready', version: state.version }
  if (state.kind === 'available' && state.mode === 'link' && status.dismissed !== state.version)
    return { kind: 'link', version: state.version }
  if (status.updatedFrom && !updatedSeen) return { kind: 'updated', version: status.current }
  return null
}

/** The update notice: a raised, neutral row in the sidebar footer, above Settings. */
export function UpdateNotice() {
  const status = useUpdatesStore((s) => s.status)
  const updatedDismissed = useUpdatesStore((s) => s.updatedDismissed)
  const notice = noticeFor(status, updatedDismissed)
  if (!notice) return null

  const dismiss = () => {
    if (notice.kind === 'updated') useUpdatesStore.setState({ updatedDismissed: true })
    else void window.overbench.updates.dismiss()
  }

  const close = (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label="Dismiss"
      onClick={dismiss}
      className="size-5 rounded-[5px] text-muted-foreground hover:text-foreground"
    >
      <XIcon className="size-3.5" />
    </Button>
  )

  const version = (
    <span className="font-mono text-[11.5px] text-muted-foreground tabular">{notice.version}</span>
  )

  const row = (
    <div
      role="status"
      className="group/update relative flex min-h-9 animate-in items-center gap-2 rounded-[8px] bg-card pr-1 pl-2.5 text-xs shadow-card animation-duration-(--duration-slow) ease-out-quint fade-in slide-in-from-bottom-1"
    >
      {notice.kind === 'updated' ? (
        <CircleCheckIcon className="size-[15px] shrink-0 text-success" />
      ) : (
        <CircleArrowUpIcon className="size-[15px] shrink-0" />
      )}
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5 whitespace-nowrap">
        {notice.kind === 'ready' && (
          <>
            <span className="font-medium">Update ready</span>
            {version}
          </>
        )}
        {notice.kind === 'link' && (
          <span className="font-medium">{notice.version} is available</span>
        )}
        {notice.kind === 'updated' && (
          <>
            <span className="font-medium">Updated to</span>
            {version}
          </>
        )}
      </span>
      <span className="inline-flex items-center gap-0.5">
        {notice.kind === 'ready' && (
          <Button
            variant="outline"
            size="xs"
            onClick={() => void window.overbench.updates.restart()}
          >
            Restart
          </Button>
        )}
        {notice.kind === 'link' && (
          <a
            href={releaseUrl(notice.version)}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'outline', size: 'xs' })}
          >
            <ExternalLinkIcon data-icon="inline-start" />
            Download
          </a>
        )}
        {notice.kind === 'updated' && (
          <a
            href={releaseUrl(notice.version)}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: 'ghost', size: 'xs' })}
          >
            What’s new
          </a>
        )}
        {notice.kind === 'updated' ? (
          close
        ) : (
          <span className="hidden group-hover/update:inline-flex group-focus-within/update:inline-flex">
            {close}
          </span>
        )}
      </span>
    </div>
  )

  if (notice.kind === 'updated') return row
  return (
    <Tooltip>
      <TooltipTrigger render={row} delay={500} />
      <TooltipContent side="top" align="start" className="max-w-64">
        {notice.kind === 'ready'
          ? `OverBench ${notice.version} is downloaded. Restart to finish; your sessions come back.`
          : `OverBench ${notice.version} is available. Download it from the release page.`}
      </TooltipContent>
    </Tooltip>
  )
}
