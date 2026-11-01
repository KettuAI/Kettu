import { useEffect, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { normalizeDeviceName } from '@shared/remote/device'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage } from '@renderer/lib/host'
import { useWebHostStore, type WebHost } from '@renderer/stores/web-host'
import { CONFIRM, ControlError } from './controls'
import { webHostLine } from './host-text'
import { HostState } from './hosts-section'
import { DeviceTile, HostIcon } from './remote-parts'

// The parts of Settings > Hosts in the web client: the host that served the page, this browser's
// name on it, and forgetting it here.

/** How long a rename waits for the host's answer before the field shows the old name again. */
const RENAME_MS = 5000

const isComposing = (event: KeyboardEvent<HTMLInputElement>): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229

/** The host this page connects to: what it runs, where it is reached, and whether it is now. */
export function WebHostRow({ host }: { host: WebHost }) {
  const { t } = useTranslation('settings')
  return (
    <div className="-mx-3 flex items-start gap-3 py-3 pr-3 pl-4">
      <DeviceTile icon={<HostIcon platform={host.platform ?? ''} className="size-4" />} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-h-5.5 items-center truncate text-ui font-medium">
          {host.name}
        </span>
        <span className="truncate text-command leading-4.5 text-secondary">
          {webHostLine(t, host)}
        </span>
      </div>
      <span className="flex h-5.5 shrink-0 items-center">
        <HostState host={host} />
      </span>
    </div>
  )
}

/** This browser's name on the host, which it renames itself while connected. */
export function BrowserNameField() {
  const { t } = useTranslation('settings')
  const host = useWebHostStore((s) => s.host)
  const rename = useWebHostStore((s) => s.actions?.rename)
  const [draft, setDraft] = useState<string | null>(null)
  // Shown from the commit until the host's answer comes, or until it stays away too long.
  const [sent, setSent] = useState<string | null>(null)
  const current = host?.device.name ?? ''
  const online = host?.connection.state === 'online'
  useEffect(() => {
    if (sent === null) return
    const timer = setTimeout(() => setSent(null), RENAME_MS)
    return () => clearTimeout(timer)
  }, [sent])
  const [seen, setSeen] = useState(current)
  if (seen !== current) {
    setSeen(current)
    setSent(null)
  }
  const commit = (): void => {
    if (draft === null) return
    const next = normalizeDeviceName(draft)
    setDraft(null)
    if (!next || next === current || !rename) return
    setSent(next)
    rename(next)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (isComposing(event)) return
    if (event.key === 'Enter') event.currentTarget.blur()
    else if (event.key === 'Escape') {
      event.stopPropagation()
      setDraft(null)
      event.currentTarget.blur()
    }
  }
  return (
    <>
      {sent !== null && <Spinner className="size-3.5 text-icon" />}
      <Input
        aria-label={t('hosts.web.self', { name: host?.name ?? '' })}
        value={draft ?? sent ?? current}
        disabled={!online}
        maxLength={256}
        spellCheck={false}
        autoComplete="off"
        className="h-7 w-55 text-ui md:text-ui"
        onFocus={() => setDraft(sent ?? current)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </>
  )
}

/** Forget..., after a confirm saying the page goes back to pairing. */
export function ForgetHost() {
  const { t } = useTranslation(['settings', 'common'])
  const name = useWebHostStore((s) => s.host?.name ?? '')
  const forget = useWebHostStore((s) => s.actions?.forget)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (): Promise<void> => {
    if (!forget) return
    setBusy(true)
    setError(null)
    try {
      await forget()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <>
      <ControlError error={open ? null : error} />
      <Button variant="destructive-outline" size="sm" onClick={() => setOpen(true)}>
        {t('hosts.web.forget.button')}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('hosts.web.forget.title', { name })}</AlertDialogTitle>
            <AlertDialogDescription>{t('hosts.web.forget.body', { name })}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-xs text-danger">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void run()}>
              {busy && <Spinner data-icon="inline-start" />}
              {t('hosts.web.forget.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
