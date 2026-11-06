import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Cancel01Icon } from '@hugeicons/core-free-icons'
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
import { useHostContext } from '@renderer/lib/host-features'
import { isWeb } from '@renderer/lib/platform'
import { useHostScope } from '@renderer/stores/host-scope'
import { useOtherHost } from '@renderer/stores/hosts'
import { CONFIRM, ControlError, IconAction, SetButton, SetInput } from './controls'
import { BlockLine } from './rows'
import { DIRECT_PORT_FIELD } from './remote-text'
import { useApply } from './use-apply'

const isComposing = (event: KeyboardEvent<HTMLInputElement>): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229

/** The direct connections' port; a new one takes effect after a warning. */
export function DirectPortField({ label }: { label: string }) {
  const { hostId, useSettingsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const onHost = useHostContext()
  // A host added over SSH is reached through it alone, whatever its direct port.
  const direct = useOtherHost(hostId)?.ssh === undefined
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
      <SetInput
        id={DIRECT_PORT_FIELD}
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={draft ?? shown}
        inputMode="numeric"
        maxLength={5}
        spellCheck={false}
        autoComplete="off"
        className="k-input--short"
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
              {hostId !== null && direct && ` ${t('remote.other.portBody', onHost)}`}
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
  return <ul className="k-inset k-list k-addresses">{children}</ul>
}

function AddressLine({ address, children }: { address: DirectAddress; children?: ReactNode }) {
  return (
    <li className="k-list__row">
      <span data-selectable="" className="k-list__name k-mono">
        {addressText(address)}
      </span>
      {children}
    </li>
  )
}

/** The addresses the computer found for itself, which every code and welcome carry. */
export function FoundAddresses({ text }: { text: ReactNode }) {
  const { useSettingsStore, useRemoteStore } = useHostScope()
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
        <p className="k-block-note">
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
  const { useSettingsStore } = useHostScope()
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
  const form = full ? (
    <span className="k-block-note">
      {t('remote.direct.own.full', { count: MAX_OWN_ADDRESSES })}
    </span>
  ) : (
    <form className="k-end" onSubmit={add}>
      <SetInput
        value={draft}
        aria-label={t('remote.direct.own.label')}
        aria-invalid={problem !== null || undefined}
        aria-describedby={problem ? errorId : undefined}
        placeholder={t('remote.direct.own.placeholder')}
        spellCheck={false}
        autoComplete="off"
        maxLength={300}
        className="k-input--wide k-mono"
        onChange={(event) => {
          setDraft(event.target.value)
          setProblem(null)
        }}
      />
      <SetButton type="submit" disabled={draft.trim() === ''}>
        {t('remote.direct.own.add')}
      </SetButton>
    </form>
  )
  return (
    <>
      <BlockLine text={text}>{form}</BlockLine>
      {own.length > 0 && (
        <AddressList>
          {own.map((address) => {
            const shown = addressText(address)
            return (
              <AddressLine key={addressKey(address)} address={address}>
                <IconAction
                  label={t('remote.direct.own.remove', { address: shown })}
                  icon={Cancel01Icon}
                  onClick={() => remove(address)}
                />
              </AddressLine>
            )
          })}
        </AddressList>
      )}
      {problem && (
        <p id={errorId} className="k-error" data-wrap="">
          {problem === 'repeat' ? (
            t('remote.direct.own.repeat')
          ) : (
            <Trans
              t={t}
              i18nKey="remote.direct.own.invalid"
              components={{
                strong: <span />,
                code: <span className="k-mono" />,
              }}
            />
          )}
        </p>
      )}
      {error && (
        <p className="k-error" data-wrap="">
          {error}
        </p>
      )}
    </>
  )
}
