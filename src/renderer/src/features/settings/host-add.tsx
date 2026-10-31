import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type Ref,
} from 'react'
import { CircleAlertIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { DEVICE_NAME_CHARS } from '@shared/remote/device'
import type { HostPairingFailure, HostPairingState, HostStatus } from '@shared/remote/hosts'
import { parsePairingLink } from '@shared/remote/pairing'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@renderer/components/ui/field'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage } from '@renderer/lib/host'
import { platformName } from './host-text'
import { DeviceTile, HostIcon } from './remote-parts'

/** Why Add host shows no host: what pairing said, or what kept it from starting. */
export type AddHostFailure = HostPairingFailure | 'self' | 'unavailable'

export type AddHostStep =
  | { kind: 'paste'; invalid: boolean }
  | { kind: 'connecting' }
  | { kind: 'confirm' }
  | { kind: 'failed'; reason: AddHostFailure }
  | { kind: 'added'; host: HostStatus }

const isComposing = (event: KeyboardEvent<HTMLInputElement>): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229

/**
 * Add host: a pasted pairing link connects at once, waits for the host's owner and says how it
 * went; once added, this computer's name there can be changed on the spot. Closing it ends a
 * pairing the host has not added.
 */
export function AddHostDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // Each opening starts afresh.
  const [opened, setOpened] = useState(open)
  const [round, setRound] = useState(0)
  if (open !== opened) {
    setOpened(open)
    if (open) setRound((n) => n + 1)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <AddHostFlow key={round} open={open} onDone={() => onOpenChange(false)} />
    </Dialog>
  )
}

function AddHostFlow({ open, onDone }: { open: boolean; onDone: () => void }) {
  const [step, setStep] = useState<AddHostStep>({ kind: 'paste', invalid: false })
  const [draft, setDraft] = useState('')
  const [link, setLink] = useState('')
  const pairing = useRef<number | null>(null)
  const attempt = useRef(0)
  // Progress of a pairing main has not named yet, as an event may beat the answer to pair().
  const early = useRef(new Map<number, HostPairingState[]>())
  const input = useRef<HTMLInputElement>(null)

  const take = (state: HostPairingState): void => {
    if (state.state === 'added' || state.state === 'failed') pairing.current = null
    if (state.state === 'added') setStep({ kind: 'added', host: state.host })
    else if (state.state === 'failed') setStep({ kind: 'failed', reason: state.reason })
    else setStep({ kind: state.state })
  }

  const close = (): void => {
    const pairId = pairing.current
    pairing.current = null
    if (pairId !== null) void window.kettu.hosts.closePairing(pairId)
  }

  /** Add host closed: its pairing ends, and an answer still on its way to main is let go. */
  const abandon = (): void => {
    attempt.current++
    close()
  }

  useEffect(() => {
    if (!open) return
    const off = window.kettu.hosts.onPairing(({ pairId, pairing: state }) => {
      if (pairId === pairing.current) take(state)
      else if (pairing.current === null) {
        early.current.set(pairId, [...(early.current.get(pairId) ?? []), state])
      }
    })
    return () => {
      off()
      abandon()
    }
    // One subscription for each opening; take and abandon reach only refs and state setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const start = (text: string): void => {
    const trimmed = text.trim()
    if (!parsePairingLink(trimmed)) {
      setStep({ kind: 'paste', invalid: true })
      return
    }
    close()
    const run = ++attempt.current
    early.current.clear()
    setLink(trimmed)
    setStep({ kind: 'connecting' })
    window.kettu.hosts.pair(trimmed).then(
      (started) => {
        if (run !== attempt.current) {
          if (started.kind === 'pairing') void window.kettu.hosts.closePairing(started.pairId)
          return
        }
        if (started.kind === 'invalid') return setStep({ kind: 'paste', invalid: true })
        if (started.kind !== 'pairing') return setStep({ kind: 'failed', reason: started.kind })
        pairing.current = started.pairId
        const waiting = early.current.get(started.pairId) ?? []
        early.current.clear()
        for (const state of waiting) take(state)
      },
      () => {
        if (run === attempt.current) setStep({ kind: 'failed', reason: 'unreachable' })
      },
    )
  }

  const again = (): void => {
    attempt.current++
    setDraft('')
    setStep({ kind: 'paste', invalid: false })
    // The field is back once this render is drawn.
    requestAnimationFrame(() => input.current?.focus())
  }

  return (
    <DialogContent showCloseButton={false} className="gap-0 p-0 sm:max-w-130">
      <AddHostBody
        step={step}
        draft={draft}
        link={link}
        inputRef={input}
        onDraft={(text) => {
          setDraft(text)
          if (step.kind === 'paste' && step.invalid) setStep({ kind: 'paste', invalid: false })
        }}
        onSubmit={start}
        onRetry={() => start(link)}
        onAgain={again}
        onDone={onDone}
      />
    </DialogContent>
  )
}

/** The dialog's content in each step, apart from what talks to main. */
export function AddHostBody({
  step,
  draft,
  link,
  inputRef,
  onDraft,
  onSubmit,
  onRetry,
  onAgain,
  onDone,
}: {
  step: AddHostStep
  draft: string
  link: string
  inputRef?: Ref<HTMLInputElement>
  onDraft: (text: string) => void
  onSubmit: (text: string) => void
  onRetry: () => void
  onAgain: () => void
  onDone: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const errorId = useId()
  if (step.kind === 'added') return <Added host={step.host} onDone={onDone} />
  const pasting = step.kind === 'paste'
  const invalid = pasting && step.invalid
  const failure = step.kind === 'failed' ? step.reason : null
  const problem = invalid ? 'invalid' : failure
  const onPaste = (event: ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData.getData('text')
    if (!text) return
    event.preventDefault()
    onDraft(text.trim())
    onSubmit(text)
  }
  return (
    <>
      <DialogHeader className="px-5 pt-5">
        <DialogTitle>{t('hosts.add.title')}</DialogTitle>
      </DialogHeader>
      <div className="px-5 pt-4">
        <p className="mb-2.5 text-ui leading-5 text-pretty text-tertiary">
          <Trans
            t={t}
            i18nKey="hosts.add.hint"
            components={{
              code: <code className="font-mono whitespace-nowrap text-code text-primary" />,
            }}
          />
        </p>
        <Input
          ref={inputRef}
          value={pasting ? draft : link}
          readOnly={!pasting}
          autoFocus
          aria-label={t('hosts.add.label')}
          aria-invalid={invalid || undefined}
          aria-describedby={problem ? errorId : undefined}
          placeholder={t('hosts.add.placeholder')}
          spellCheck={false}
          autoComplete="off"
          className="h-7 font-mono text-code md:text-code"
          onChange={(event) => onDraft(event.target.value)}
          onPaste={pasting ? onPaste : undefined}
          onKeyDown={(event) => {
            if (!pasting || isComposing(event) || event.key !== 'Enter') return
            event.preventDefault()
            onSubmit(draft)
          }}
        />
        {problem && (
          <p
            id={errorId}
            role="alert"
            className="mt-2.5 flex items-start gap-2 text-ui text-danger"
          >
            <CircleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
            <span className="text-pretty">
              {problem === 'unavailable' ? t('hosts.keyFailed') : t(`hosts.add.${problem}`)}
            </span>
          </p>
        )}
        {step.kind === 'confirm' && (
          <div className="mt-3.5 rounded-lg bg-subtle px-3.5 py-3 shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]">
            <div className="text-ui font-medium">{t('hosts.add.confirmTitle')}</div>
            <div className="mt-0.5 text-xs leading-4.5 text-pretty text-tertiary">
              {t('hosts.add.confirmBody')}
            </div>
          </div>
        )}
      </div>
      <DialogFooter className="items-center p-5">
        {(step.kind === 'connecting' || step.kind === 'confirm') && (
          <span role="status" className="flex items-center gap-2 text-ui text-tertiary">
            <Spinner className="size-4" />
            {t(step.kind === 'connecting' ? 'hosts.add.connecting' : 'hosts.add.waiting')}
          </span>
        )}
        <span className="flex-1" />
        {failure ? (
          <>
            <DialogClose render={<Button variant="outline" />}>
              {t('common:actions.close')}
            </DialogClose>
            {failure === 'unreachable' ? (
              <Button onClick={onRetry}>{t('hosts.add.retry')}</Button>
            ) : (
              <Button onClick={onAgain}>{t('hosts.add.newLink')}</Button>
            )}
          </>
        ) : (
          <>
            <DialogClose render={<Button variant="outline" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            {pasting && (
              <Button disabled={!parsePairingLink(draft.trim())} onClick={() => onSubmit(draft)}>
                {t('hosts.add.add')}
              </Button>
            )}
          </>
        )}
      </DialogFooter>
    </>
  )
}

/** The host just added, and this computer's name on it, which changes on Done. */
function Added({ host, onDone }: { host: HostStatus; onDone: () => void }) {
  const { t } = useTranslation('settings')
  const [name, setName] = useState(host.deviceName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()
  const valid = trimmed.length > 0 && [...trimmed].length <= DEVICE_NAME_CHARS
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    if (trimmed === host.deviceName) return onDone()
    setBusy(true)
    try {
      await window.kettu.hosts.rename(host.id, trimmed)
      onDone()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <form className="contents" onSubmit={(event) => void submit(event)}>
      <DialogHeader className="px-5 pt-5">
        <DialogTitle>{t('hosts.add.title')}</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-3.5 px-5 pt-4">
        <div className="flex items-center gap-3">
          <DeviceTile large icon={<HostIcon platform={host.platform} className="size-5" />} />
          <div className="min-w-0">
            <div className="truncate text-ui font-medium">
              {t('hosts.add.added', { name: host.name })}
            </div>
            <div className="truncate text-xs leading-4.5 text-tertiary">
              {[
                platformName(host.platform),
                t('hosts.version', { version: host.version }),
                t('hosts.via.direct'),
              ].join(' · ')}
            </div>
          </div>
        </div>
        <Field data-invalid={!valid || error !== null || undefined}>
          <FieldLabel htmlFor="host-device-name" className="text-ui">
            {t('hosts.add.nameLabel', { name: host.name })}
          </FieldLabel>
          <Input
            id="host-device-name"
            value={name}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            className="h-7 text-ui md:text-ui"
            aria-invalid={!valid || error !== null || undefined}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => {
              setName(event.target.value)
              setError(null)
            }}
          />
          {error ? (
            <FieldError>{error}</FieldError>
          ) : (
            <FieldDescription className="text-xs">
              {t('hosts.add.nameHint', { name: host.name })}
            </FieldDescription>
          )}
        </Field>
      </div>
      <DialogFooter className="p-5">
        <Button type="submit" disabled={!valid || busy}>
          {busy && <Spinner data-icon="inline-start" />}
          {t('hosts.add.done')}
        </Button>
      </DialogFooter>
    </form>
  )
}
