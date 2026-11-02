import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FormEvent,
  type Ref,
  type RefObject,
} from 'react'
import {
  CheckIcon,
  CircleAlertIcon,
  CircleXIcon,
  ClockIcon,
  CopyIcon,
  RotateCwIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { DEVICE_NAME_CHARS } from '@shared/remote/device'
import type { PairingEnd, PairingState } from '@shared/remote/pairing'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { countdown } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext } from '@renderer/lib/host-features'
import { useSeconds } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useHostScope } from '@renderer/stores/host-scope'
import { ROW_BUTTON, Segmented, SettingSelect } from './controls'
import { closeRequest } from './pair-close'
import { browserLinks } from './pair-links'
import { QrCode } from './qr-code'
import { DeviceIcon, DeviceTile } from './remote-parts'
import { deviceLine } from './remote-text'
import {
  DIALOG_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'

export type Shown =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'pairing'; pairing: PairingState }

/** What Add device may do with the question while it is shown. */
export interface ConfirmHandle {
  /** Answers as Reject does, unless it was answered already. */
  reject(): void
}

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
  const confirmRef = useRef<ConfirmHandle>(null)
  if (open !== opened) {
    setOpened(open)
    if (open) setRound((n) => n + 1)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (next) return onOpenChange(true)
        const action = closeRequest(confirmRef.current !== null, details.reason)
        if (action === 'reject') confirmRef.current?.reject()
        else if (action === 'close') onOpenChange(false)
      }}
    >
      <PairFlow
        key={round}
        open={open}
        confirmRef={confirmRef}
        onNewCode={() => setRound((n) => n + 1)}
        onDone={() => onOpenChange(false)}
      />
    </Dialog>
  )
}

function PairFlow({
  open,
  confirmRef,
  onNewCode,
  onDone,
}: {
  open: boolean
  confirmRef: RefObject<ConfirmHandle | null>
  onNewCode: () => void
  onDone: () => void
}) {
  const { api } = useHostScope()
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
    const off = api.remote.onPairing(({ codeId, pairing }) => {
      if (codeId === code.current) take(pairing)
      else if (code.current === null) early.set(codeId, pairing)
    })
    api.remote
      .pair()
      .then((codeId) => {
        if (!live) {
          if (codeId !== null) void api.remote.closePairing(codeId)
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
      if (codeId !== null) void api.remote.closePairing(codeId)
    }
    // A code is made once per flow; onDone and t do not change what it asks for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const answer = (add: boolean, name: string): void => {
    if (code.current !== null) void api.remote.answerPairing(code.current, add, name)
  }
  const confirm =
    shown.kind === 'pairing' && shown.pairing.state === 'confirm' ? shown.pairing : null
  const ended = shown.kind === 'pairing' && shown.pairing.state === 'void'
  return (
    <SettingsDialogContent className={confirm ? 'sm:max-w-110' : 'sm:max-w-115'}>
      {confirm ? (
        <Confirm ref={confirmRef} pairing={confirm} onAnswer={answer} />
      ) : (
        <>
          <PairHeader />
          <CodeBody shown={shown} link={link} />
          <SettingsDialogFooter>
            {ended ? (
              <>
                <DialogClose render={<Button variant="ghost" className={ROW_BUTTON} />}>
                  {t('common:actions.close')}
                </DialogClose>
                <Button className={ROW_BUTTON} onClick={onNewCode}>
                  <RotateCwIcon data-icon="inline-start" />
                  {t('remote.pair.newCode')}
                </Button>
              </>
            ) : (
              <DialogClose render={<Button variant="ghost" className={ROW_BUTTON} />}>
                {t('common:actions.done')}
              </DialogClose>
            )}
          </SettingsDialogFooter>
        </>
      )}
    </SettingsDialogContent>
  )
}

function PairHeader() {
  const { t } = useTranslation('settings')
  const onHost = useHostContext()
  return (
    <SettingsDialogHeader title={t('remote.pair.title')}>
      {t('remote.pair.description', onHost)}
    </SettingsDialogHeader>
  )
}

/**
 * The QR code and the link beside what to do with them, or why the code is void: for Kettu's apps,
 * or for a browser, which opens the web client at one of this computer's addresses.
 */
export function CodeBody({ shown, link: appLink }: { shown: Shown; link: string | null }) {
  const { useSettingsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const pairing = shown.kind === 'pairing' ? shown.pairing : null
  const end = pairing?.state === 'void' ? pairing.reason : null
  const waiting = pairing?.state === 'waiting' ? pairing : null
  const [target, setTarget] = useState<'app' | 'browser'>('app')
  const [chosen, setChosen] = useState<string | null>(null)
  const own = useSettingsStore((s) => s.settings.remote.direct.addresses)
  const browsers = browserLinks(appLink, own)
  const browser = browsers.find((b) => b.address === chosen) ?? browsers[0] ?? null
  const link = target === 'browser' ? (browser?.link ?? null) : appLink
  return (
    <div className="flex min-w-0 flex-col items-center gap-4 px-6 pt-3 pb-1">
      {!end && shown.kind !== 'failed' && browsers.length > 0 && (
        <Segmented
          label={t('remote.pair.target')}
          value={target}
          options={[
            { value: 'app', label: t('remote.pair.targets.app') },
            { value: 'browser', label: t('remote.pair.targets.browser') },
          ]}
          onChange={setTarget}
        />
      )}
      <div className="relative size-56 shrink-0 rounded-modal bg-canvas p-3 shadow-[0_0_0_var(--hairline)_var(--border-default)]">
        {link && (
          <QrCode text={link} label={t('remote.pair.qr')} className={cn(end && 'opacity-8')} />
        )}
        {end && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-canvas-ink/60">
            <EndIcon end={end} className="size-5" />
            <span className="text-control font-medium">
              {t(`remote.pair.ends.${endKey(end)}.short`)}
            </span>
          </div>
        )}
        {!link && !end && (
          <div className="absolute inset-0 grid place-items-center">
            <Spinner className="size-5 text-canvas-ink/40" />
          </div>
        )}
      </div>
      <div className="flex max-w-90 flex-col items-center gap-1 text-center text-lede text-pretty text-secondary">
        {shown.kind === 'failed' ? (
          <p className="text-danger">{t('remote.pair.failed', { message: shown.message })}</p>
        ) : end ? (
          <EndText end={end} />
        ) : target === 'browser' ? (
          <>
            <p>
              {t('remote.pair.browserScan')} {t('remote.pair.browserHint')}
            </p>
            {browsers.length > 1 && browser && (
              <div className="flex items-center gap-2 pt-1 text-control">
                <span className="text-secondary">{t('remote.pair.address')}</span>
                <SettingSelect
                  label={t('remote.pair.address')}
                  value={browser.address}
                  options={browsers.map((b) => ({ value: b.address, label: b.address }))}
                  onChange={setChosen}
                />
              </div>
            )}
          </>
        ) : (
          <p>
            {t('remote.pair.scan')} {t('remote.pair.otherComputer')}
          </p>
        )}
      </div>
      <LinkBox link={link} disabled={!waiting} />
      {waiting && (
        <div className="flex w-full items-center gap-2 pt-3 text-control leading-[normal] text-tertiary shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]">
          <Spinner className="size-3.25" />
          <span role="status" className="flex-1">
            {t('remote.pair.waiting')}
          </span>
          <ExpiresIn expiresAt={waiting.expiresAt} />
        </div>
      )}
    </div>
  )
}

// A closed code is never shown: its dialog is gone.
const endKey = (end: PairingEnd) => (end === 'closed' ? 'expired' : end)

function EndIcon({ end, className }: { end: PairingEnd; className: string }) {
  const Icon = end === 'attempts' ? CircleAlertIcon : end === 'rejected' ? CircleXIcon : ClockIcon
  return <Icon className={className} />
}

function EndText({ end }: { end: PairingEnd }) {
  const { t } = useTranslation('settings')
  const key = endKey(end)
  return (
    <>
      <p className="flex items-center gap-1.5 font-medium text-primary">
        <EndIcon
          end={end}
          className={cn('size-4 shrink-0', end === 'attempts' ? 'text-danger' : 'text-tertiary')}
        />
        {t(`remote.pair.ends.${key}.title`)}
      </p>
      <p className="text-hint text-tertiary">{t(`remote.pair.ends.${key}.body`)}</p>
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
    <div className="flex w-full gap-2">
      <code
        className={cn(
          'block h-8 min-w-0 flex-1 truncate rounded-xl bg-card px-2.75 font-mono text-hint leading-8 shadow-outline',
          disabled ? 'text-disabled' : 'text-primary',
        )}
        data-selectable=""
      >
        {link ?? ' '}
      </code>
      <Button
        className={ROW_BUTTON}
        variant="outline"
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
    <span className="tabular">
      {t('remote.pair.expiresIn', { time: countdown(expiresAt - now) })}
    </span>
  )
}

/** Whether to add the device whose secret checked out, under a name the owner may change. */
export function Confirm({
  pairing,
  onAnswer,
  ref,
}: {
  pairing: Extract<PairingState, { state: 'confirm' }>
  onAnswer: (add: boolean, name: string) => void
  ref?: Ref<ConfirmHandle>
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
  useImperativeHandle(ref, () => ({ reject: () => answer(false) }))
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    answer(true)
  }
  const line = [
    deviceLine(t, device),
    device.known ? t('remote.pair.confirm.again') : t('remote.pair.confirm.justNow'),
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <form className="contents" onSubmit={submit}>
      <SettingsDialogHeader title={t('remote.pair.confirm.title')}>
        {t('remote.pair.confirm.body')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <div className="flex items-center gap-3 rounded-xl bg-subtle p-3">
          <DeviceTile large icon={<DeviceIcon device={device} className="size-5" />} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-label leading-[normal]">{device.name}</div>
            <div className="mt-0.5 text-hint text-pretty text-tertiary">{line}</div>
          </div>
        </div>
        <SettingsField
          label={t('remote.pair.confirm.name')}
          htmlFor="pair-name"
          hint={t('remote.pair.confirm.nameHint')}
        >
          <Input
            id="pair-name"
            value={name}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className={DIALOG_FIELD}
            aria-invalid={!valid || undefined}
            onChange={(event) => setName(event.target.value)}
          />
        </SettingsField>
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <Button
          type="button"
          variant="ghost"
          className={ROW_BUTTON}
          disabled={answered}
          onClick={() => answer(false)}
        >
          {t('remote.pair.confirm.reject')}
        </Button>
        <Button type="submit" className={ROW_BUTTON} disabled={answered || !valid}>
          {answered && <Spinner data-icon="inline-start" />}
          {t('remote.pair.confirm.add')}
        </Button>
      </SettingsDialogFooter>
    </form>
  )
}
