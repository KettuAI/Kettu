import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { CircleAlertIcon, XIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import {
  addressKey,
  addressText,
  MAX_OWN_ADDRESSES,
  parseAddress,
  parsePort,
} from '@shared/remote/address'
import type { DirectAddress } from '@shared/remote/protocol'
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
import { isWeb } from '@renderer/lib/platform'
import { useRemoteStore } from '@renderer/stores/remote'
import { useSettingsStore } from '@renderer/stores/settings'
import { CONFIRM, ControlError } from './controls'
import { DIRECT_PORT_FIELD } from './remote-text'
import { useApply } from './use-apply'

const isComposing = (event: KeyboardEvent<HTMLInputElement>): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229

/** The direct connections' port; a new one takes effect after a warning. */
export function DirectPortField({ label }: { label: string }) {
  const { t } = useTranslation(['settings', 'common'])
  const port = useSettingsStore((s) => s.settings.remote.direct.port)
  const [draft, setDraft] = useState<string | null>(null)
  const [asking, setAsking] = useState<number | null>(null)
  const [apply, error] = useApply()
  const shown = port === null ? '' : String(port)
  const invalid = draft !== null && draft.trim() !== '' && parsePort(draft) === null
  const commit = (): void => {
    if (draft === null) return
    const next = parsePort(draft)
    if (draft.trim() === '' || next === port) setDraft(null)
    else if (next !== null) setAsking(next)
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
  const settle = (change: boolean): void => {
    if (change && asking !== null) apply({ remote: { direct: { port: asking } } })
    setAsking(null)
    setDraft(null)
  }
  return (
    <>
      <ControlError error={invalid ? t('remote.direct.port.invalid') : error} />
      <Input
        id={DIRECT_PORT_FIELD}
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={draft ?? shown}
        inputMode="numeric"
        maxLength={5}
        spellCheck={false}
        autoComplete="off"
        className="h-7 w-20 font-mono text-code md:text-code"
        onFocus={() => setDraft((current) => current ?? shown)}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      <AlertDialog open={asking !== null} onOpenChange={(open) => !open && settle(false)}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('remote.direct.port.confirmTitle', { port: asking ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('remote.direct.port.confirmBody')}
              {isWeb && ` ${t('remote.web.portBody')}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => settle(true)}>
              {t('remote.direct.port.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function AddressList({ children }: { children: ReactNode }) {
  return <ul className="mt-2 flex flex-col">{children}</ul>
}

function AddressLine({ address, children }: { address: DirectAddress; children?: ReactNode }) {
  return (
    <li className="flex min-h-6 items-center gap-3">
      <span data-selectable="" className="min-w-0 flex-1 truncate font-mono text-code">
        {addressText(address)}
      </span>
      {children}
    </li>
  )
}

/** The addresses the computer found for itself, which every code and welcome carry. */
export function FoundAddresses({ text }: { text: ReactNode }) {
  const { t } = useTranslation('settings')
  const direct = useRemoteStore((s) => s.status?.direct)
  const own = useSettingsStore((s) => s.settings.remote.direct.addresses)
  const ownKeys = new Set(own.map(addressKey))
  const found =
    direct?.state === 'listening'
      ? direct.addresses.filter((address) => !ownKeys.has(addressKey(address)))
      : []
  return (
    <>
      {text}
      {found.length > 0 ? (
        <AddressList>
          {found.map((address) => (
            <AddressLine key={addressKey(address)} address={address} />
          ))}
        </AddressList>
      ) : (
        <p className="mt-2 text-xs text-tertiary">
          {direct?.state === 'listening'
            ? t('remote.direct.found.none')
            : t('remote.direct.found.notListening')}
        </p>
      )}
    </>
  )
}

/** The owner's own addresses, such as a forwarded port, with a field to add one. */
export function OwnAddresses({ text }: { text: ReactNode }) {
  const { t } = useTranslation('settings')
  const own = useSettingsStore((s) => s.settings.remote.direct.addresses)
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<'format' | 'repeat' | null>(null)
  const [apply, error] = useApply()
  const errorId = useId()
  const full = own.length >= MAX_OWN_ADDRESSES
  const add = (event: FormEvent): void => {
    event.preventDefault()
    if (draft.trim() === '' || full) return
    const address = parseAddress(draft)
    if (!address) return setProblem('format')
    if (own.some((kept) => addressKey(kept) === addressKey(address))) return setProblem('repeat')
    apply({ remote: { direct: { addresses: [...own, address] } } })
    setDraft('')
    setProblem(null)
  }
  const remove = (address: DirectAddress): void =>
    apply({
      remote: {
        direct: { addresses: own.filter((kept) => addressKey(kept) !== addressKey(address)) },
      },
    })
  return (
    <>
      {text}
      {own.length > 0 && (
        <AddressList>
          {own.map((address) => {
            const shown = addressText(address)
            return (
              <AddressLine key={addressKey(address)} address={address}>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('remote.direct.own.remove', { address: shown })}
                  onClick={() => remove(address)}
                >
                  <XIcon />
                </Button>
              </AddressLine>
            )
          })}
        </AddressList>
      )}
      {full ? (
        <p className="mt-2 text-xs text-tertiary">
          {t('remote.direct.own.full', { count: MAX_OWN_ADDRESSES })}
        </p>
      ) : (
        <form className="mt-1.5 flex items-center gap-2" onSubmit={add}>
          <Input
            value={draft}
            aria-label={t('remote.direct.own.label')}
            aria-invalid={problem !== null || undefined}
            aria-describedby={problem ? errorId : undefined}
            placeholder={t('remote.direct.own.placeholder')}
            spellCheck={false}
            autoComplete="off"
            maxLength={300}
            className="h-7 font-mono text-code md:text-code"
            onChange={(event) => {
              setDraft(event.target.value)
              setProblem(null)
            }}
          />
          <Button type="submit" variant="outline" size="sm" disabled={draft.trim() === ''}>
            {t('remote.direct.own.add')}
          </Button>
        </form>
      )}
      {problem && (
        <p id={errorId} className="mt-1.5 flex items-start gap-1.25 text-xs text-secondary">
          <CircleAlertIcon className="mt-px size-3.5 shrink-0 text-danger" />
          <span>
            {problem === 'repeat' ? (
              t('remote.direct.own.repeat')
            ) : (
              <Trans
                t={t}
                i18nKey="remote.direct.own.invalid"
                components={{
                  strong: <span className="text-danger" />,
                  code: <span className="font-mono text-primary" />,
                }}
              />
            )}
          </span>
        </p>
      )}
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
    </>
  )
}
