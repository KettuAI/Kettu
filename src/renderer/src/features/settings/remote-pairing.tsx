import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  CheckIcon,
  CircleAlertIcon,
  CircleXIcon,
  ClockIcon,
  CopyIcon,
  RotateCwIcon,
} from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import type { PairingEnd, PairingState } from '@shared/remote/pairing'
import { DEVICE_NAME_CHARS } from '@shared/remote/device'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@renderer/components/ui/field'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { countdown } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useSeconds } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { QrCode } from './qr-code'
import { DeviceIcon, DeviceTile } from './remote-parts'
import { kindLabel } from './remote-text'

export type Shown =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'pairing'; pairing: PairingState }

/**
 * Add device: a code as a QR code and a link while it waits, the question once a device's secret
 * checked out, and why the code is void with a way to a new one. Closing it voids the code.
 */
export function PairDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // Each opening, and each new code, starts afresh.
  const [opened, setOpened] = useState(open)
  const [round, setRound] = useState(0)
  if (open !== opened) {
    setOpened(open)
    if (open) setRound((n) => n + 1)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <PairFlow
        key={round}
        open={open}
        onNewCode={() => setRound((n) => n + 1)}
        onDone={() => onOpenChange(false)}
      />
    </Dialog>
  )
}

function PairFlow({
  open,
  onNewCode,
  onDone,
}: {
  open: boolean
  onNewCode: () => void
  onDone: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [shown, setShown] = useState<Shown>({ kind: 'loading' })
  // The last link shown, greyed out once its code is void.
  const [link, setLink] = useState<string | null>(null)
  const code = useRef<number | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    // Progress of a code main has not named yet, as an event may beat the answer to pair().
    const early = new Map<number, PairingState>()
    const take = (pairing: PairingState): void => {
      if (pairing.state === 'waiting') setLink(pairing.link)
      if (pairing.state === 'added') {
        toast(t('remote.pair.added', { name: pairing.device.name }))
        code.current = null
        onDone()
        return
      }
      setShown({ kind: 'pairing', pairing })
    }
    const off = window.kettu.remote.onPairing(({ codeId, pairing }) => {
      if (codeId === code.current) take(pairing)
      else if (code.current === null) early.set(codeId, pairing)
    })
    window.kettu.remote
      .pair()
      .then((codeId) => {
        if (!live) {
          if (codeId !== null) void window.kettu.remote.closePairing(codeId)
          return
        }
        if (codeId === null) {
          setShown({ kind: 'pairing', pairing: { state: 'void', reason: 'stopped' } })
          return
        }
        code.current = codeId
        const first = early.get(codeId)
        if (first) take(first)
      })
      .catch((error: unknown) => {
        if (live) setShown({ kind: 'failed', message: errorMessage(error) })
      })
    return () => {
      live = false
      off()
      const codeId = code.current
      code.current = null
      if (codeId !== null) void window.kettu.remote.closePairing(codeId)
    }
    // A code is made once per flow; onDone and t do not change what it asks for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const answer = (add: boolean, name: string): void => {
    if (code.current !== null) void window.kettu.remote.answerPairing(code.current, add, name)
  }
  const confirm =
    shown.kind === 'pairing' && shown.pairing.state === 'confirm' ? shown.pairing : null
  const ended = shown.kind === 'pairing' && shown.pairing.state === 'void'
  return (
    <DialogContent
      showCloseButton={false}
      className={cn('gap-0 p-0', confirm ? 'sm:max-w-110' : 'sm:max-w-145')}
    >
      {confirm ? (
        <Confirm pairing={confirm} onAnswer={answer} />
      ) : (
        <>
          <DialogHeader className="px-5 pt-5">
            <DialogTitle>{t('remote.pair.title')}</DialogTitle>
          </DialogHeader>
          <CodeBody shown={shown} link={link} />
          <DialogFooter className="items-center p-5 sm:justify-start">
            {ended ? (
              <>
                <span className="flex-1" />
                <DialogClose render={<Button variant="outline" />}>
                  {t('common:actions.close')}
                </DialogClose>
                <Button onClick={onNewCode}>
                  <RotateCwIcon data-icon="inline-start" />
                  {t('remote.pair.newCode')}
                </Button>
              </>
            ) : (
              <>
                {shown.kind !== 'failed' && (
                  <span role="status" className="flex items-center gap-2 text-ui text-tertiary">
                    <Spinner className="size-4" />
                    {t('remote.pair.waiting')}
                  </span>
                )}
                <span className="flex-1" />
                <DialogClose render={<Button variant="outline" />}>
                  {t('common:actions.cancel')}
                </DialogClose>
              </>
            )}
          </DialogFooter>
        </>
      )}
    </DialogContent>
  )
}

/** The QR code and the link beside what to do with them, or why the code is void. */
export function CodeBody({ shown, link }: { shown: Shown; link: string | null }) {
  const { t } = useTranslation('settings')
  const pairing = shown.kind === 'pairing' ? shown.pairing : null
  const end = pairing?.state === 'void' ? pairing.reason : null
  const waiting = pairing?.state === 'waiting' ? pairing : null
  return (
    <div className="flex min-w-0 items-start gap-5 px-5 pt-4">
      <div className="relative size-50.75 shrink-0 rounded-xl bg-canvas p-3.5 shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]">
        {link && (
          <QrCode text={link} label={t('remote.pair.qr')} className={cn(end && 'opacity-8')} />
        )}
        {end && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-canvas-ink/60">
            <ClockIcon className="size-5" />
            <span className="text-ui font-medium">{t('remote.pair.expired')}</span>
          </div>
        )}
        {!link && !end && (
          <div className="absolute inset-0 grid place-items-center">
            <Spinner className="size-5 text-canvas-ink/40" />
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {shown.kind === 'failed' ? (
          <p className="text-ui text-danger">
            {t('remote.pair.failed', { message: shown.message })}
          </p>
        ) : end ? (
          <EndText end={end} />
        ) : (
          <p className="text-ui font-medium">{t('remote.pair.scan')}</p>
        )}
        <LinkBox link={link} disabled={!waiting} />
        {waiting && <ExpiresIn expiresAt={waiting.expiresAt} />}
      </div>
    </div>
  )
}

function EndText({ end }: { end: PairingEnd }) {
  const { t } = useTranslation('settings')
  // A closed code is never shown: its dialog is gone.
  const key = end === 'closed' ? 'expired' : end
  return (
    <>
      <p className="flex items-center gap-1.5 text-ui font-medium">
        {end === 'attempts' ? (
          <CircleAlertIcon className="size-4 shrink-0 text-danger" />
        ) : end === 'rejected' ? (
          <CircleXIcon className="size-4 shrink-0 text-tertiary" />
        ) : (
          <ClockIcon className="size-4 shrink-0 text-tertiary" />
        )}
        {t(`remote.pair.ends.${key}.title`)}
      </p>
      <p className="text-xs leading-4.5 text-tertiary">{t(`remote.pair.ends.${key}.body`)}</p>
    </>
  )
}

/** The link, which copies; greyed out once its code is void. */
function LinkBox({ link, disabled }: { link: string | null; disabled: boolean }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <div className="flex items-center gap-2 rounded-lg bg-subtle py-1.5 pr-1.5 pl-2.5 shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]">
      <code
        className={cn(
          'min-w-0 flex-1 truncate font-mono text-code leading-4.5',
          disabled ? 'text-disabled' : 'text-primary',
        )}
        data-selectable=""
      >
        {link ?? ' '}
      </code>
      <Button
        variant="outline"
        size="xs"
        disabled={disabled || !link}
        onClick={() => {
          if (!link) return
          void navigator.clipboard.writeText(link).then(() => setCopied(true))
        }}
      >
        {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
        {copied ? t('remote.pair.copied') : t('remote.pair.copy')}
      </Button>
    </div>
  )
}

function ExpiresIn({ expiresAt }: { expiresAt: number }) {
  const { t } = useTranslation('settings')
  const now = useSeconds()
  return (
    <p className="text-xs leading-4.5 text-tertiary">
      <Trans
        t={t}
        i18nKey="remote.pair.expires"
        values={{ time: countdown(expiresAt - now) }}
        components={{ time: <span className="text-primary tabular" /> }}
      />
    </p>
  )
}

/** Whether to add the device whose secret checked out, under a name the owner may change. */
export function Confirm({
  pairing,
  onAnswer,
}: {
  pairing: Extract<PairingState, { state: 'confirm' }>
  onAnswer: (add: boolean, name: string) => void
}) {
  const { t } = useTranslation('settings')
  const { device } = pairing
  const [name, setName] = useState(device.name)
  const [answered, setAnswered] = useState(false)
  const trimmed = name.trim()
  const valid = trimmed.length > 0 && [...trimmed].length <= DEVICE_NAME_CHARS
  const answer = (add: boolean): void => {
    if (answered || (add && !valid)) return
    setAnswered(true)
    onAnswer(add, add ? trimmed : '')
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    answer(true)
  }
  const line: ReactNode = [
    kindLabel(t, device.kind),
    device.platform,
    device.known ? t('remote.pair.confirm.again') : t('remote.pair.confirm.justNow'),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <form className="contents" onSubmit={submit}>
      <DialogHeader className="px-5 pt-5">
        <DialogTitle>{t('remote.pair.confirm.title')}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-4 px-5 pt-4">
        <p className="text-ui leading-5 text-secondary">{t('remote.pair.confirm.body')}</p>
        <div className="flex items-center gap-3 rounded-xl bg-subtle p-3 shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]">
          <DeviceTile large icon={<DeviceIcon device={device} className="size-5" />} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-ui font-medium">{device.name}</div>
            <div className="mt-0.5 truncate text-xs leading-4 text-tertiary">{line}</div>
          </div>
        </div>
        <Field data-invalid={!valid || undefined}>
          <FieldLabel htmlFor="pair-name" className="text-ui font-normal text-tertiary">
            {t('remote.pair.confirm.name')}
          </FieldLabel>
          <Input
            id="pair-name"
            value={name}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="h-7 text-ui md:text-ui"
            aria-invalid={!valid || undefined}
            onChange={(event) => setName(event.target.value)}
          />
          <FieldDescription className="text-xs">
            {t('remote.pair.confirm.nameHint')}
          </FieldDescription>
        </Field>
      </div>
      <DialogFooter className="p-5">
        <Button type="button" variant="outline" disabled={answered} onClick={() => answer(false)}>
          {t('remote.pair.confirm.reject')}
        </Button>
        <Button type="submit" disabled={answered || !valid}>
          {answered && <Spinner data-icon="inline-start" />}
          {t('remote.pair.confirm.add')}
        </Button>
      </DialogFooter>
    </form>
  )
}
