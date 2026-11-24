// Settings › Remote access › Relay: the Kettu relay, the owner's own relay or none, one at a time.
// Your own relay is filled in on its card and checked by the host before it switches; once in use,
// its card shows the address, how the host's sign-in is doing and the end of its access key.

import { useId, useState, type ReactNode } from 'react'
import {
  Alert02Icon,
  BookOpen01Icon,
  Tick02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { parseRelayLink, type OwnRelayCheck, type OwnRelayProblem } from '@shared/remote/own-relay'
import type { OwnRelayReport } from '@shared/remote/status'
import type { RelayChoice } from '@shared/settings'
import { Icon } from '@renderer/components/affect/app-shell'
import { RadioGroup, RadioGroupTile } from '@renderer/components/ui/radio-group'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext, useHostHas } from '@renderer/lib/host-features'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, IconAction, Pill, SetButton, SetInput } from './controls'
import { RelayRegions, RetryRelay } from './remote-relay'
import { GroupNote } from './rows'
import { errorGroup, relayHostName } from './relay-text'
import { useApply } from './use-apply'
import { useCloudOffHere } from './use-cloud-off-here'

/** What the own relay's form is for: a first relay, a new address, or a new key for the same. */
type FormMode = 'new' | 'change' | 'replace'

/** The checks the host runs, in its order; a problem fails the first it belongs to. */
const STEPS = ['address', 'reach', 'kettu', 'key'] as const
type Step = (typeof STEPS)[number]

const STEP_OF: Record<OwnRelayProblem, Step> = {
  address: 'address',
  kettu: 'address',
  http: 'address',
  unreachable: 'reach',
  certificate: 'reach',
  not_kettu: 'kettu',
  protocol: 'kettu',
  no_access_key: 'kettu',
  key: 'key',
  key_refused: 'key',
}

/** The own relay is in use, as the host reports it; null on another relay or before it says. */
function useOwnReport(): OwnRelayReport | null {
  const { useRemoteStore } = useHostScope()
  return useRemoteStore((s) =>
    s.status?.relay?.state === 'on' ? (s.status.relay.own ?? null) : null,
  )
}

/** The three cards; in Local mode the Kettu relay, a service of Kettu's, is left out. */
export function RelayChoices() {
  const { t } = useTranslation('settings')
  const { useSettingsStore, useRemoteStore } = useHostScope()
  const choice = useSettingsStore((s) => s.settings.remote.relay)
  const cloudOff = useCloudOffHere()
  const onHost = useHostContext()
  const canOwn = useHostHas('ownRelay') !== false
  const [editing, setEditing] = useState<FormMode | null>(null)
  const [apply, error] = useApply()
  // The regions show once the host signed in to them; before, the status line says why not.
  const regions = useRemoteStore(
    (s) =>
      s.status?.relay?.state === 'on' && !s.status.relay.own && s.status.relay.relays.length > 0,
  )
  // The Kettu relay is not used in Local mode, so it reads as no relay there.
  const current: RelayChoice = cloudOff && choice === 'kettu' ? 'off' : choice
  const value: RelayChoice = editing ? 'own' : current
  const options: RelayChoice[] = cloudOff ? ['own', 'off'] : ['kettu', 'own', 'off']

  const pick = (next: RelayChoice): void => {
    if (next === 'own') {
      if (current !== 'own') setEditing('new')
      return
    }
    setEditing(null)
    // A boolean, which every host takes: true is the Kettu relay, false none.
    if (next !== current) apply({ remote: { relay: next === 'kettu' } })
  }

  return (
    <div className="k-relay">
      <ControlError error={error} wrap />
      <RadioGroup
        aria-label={t('remote.relay.group')}
        value={value}
        onValueChange={(next) => pick(next as RelayChoice)}
        className="k-relay-choices"
      >
        {options.map((option) => (
          <div
            key={option}
            className="k-relay-choice"
            data-checked={value === option || undefined}
            data-disabled={(option === 'own' && !canOwn) || undefined}
          >
            <RadioGroupTile
              value={option}
              disabled={option === 'own' && !canOwn}
              className="k-relay-tile"
            >
              <span className="ui-sg-label">
                <b className="k-row-title">
                  {t(`remote.relay.choice.${option}.name`)}
                  {editing && option === current && (
                    <Pill className="k-relay-in-use">{t('remote.relay.inUse')}</Pill>
                  )}
                </b>
                <small>
                  {option === 'own' && !canOwn
                    ? t('remote.relay.choice.own.older')
                    : t(
                        option === 'own' && cloudOff
                          ? 'remote.relay.choice.own.descriptionLocal'
                          : `remote.relay.choice.${option}.description`,
                        onHost,
                      )}
                </small>
              </span>
            </RadioGroupTile>
            {option === 'own' &&
              (editing ? (
                <OwnRelayForm
                  mode={editing}
                  onCancel={() => setEditing(null)}
                  onDone={() => setEditing(null)}
                />
              ) : (
                current === 'own' && <OwnRelayInUse onEdit={setEditing} />
              ))}
            {option === 'kettu' && current === 'kettu' && !editing && regions && (
              <div className="k-relay-body">
                <RelayRegions />
              </div>
            )}
          </div>
        ))}
      </RadioGroup>
    </div>
  )
}

/** What shows under the group: what switching does, what stays, or what Local mode keeps. */
export function RelayNote() {
  return <GroupNote>{useRelayNote()}</GroupNote>
}

function useRelayNote(): string {
  const { t } = useTranslation('settings')
  const { useSettingsStore } = useHostScope()
  const choice = useSettingsStore((s) => s.settings.remote.relay)
  const own = useOwnReport()
  const cloudOff = useCloudOffHere()
  const onHost = useHostContext()
  if (cloudOff) return t('remote.relay.note.local')
  if (choice === 'own') {
    return own?.pinned
      ? `${t('remote.relay.note.own', onHost)} ${t('remote.relay.note.pinned')}`
      : t('remote.relay.note.own', onHost)
  }
  return t('remote.relay.note.switch', onHost)
}

/** The own relay while it is the one in use: its address and state, and its key's end. */
function OwnRelayInUse({ onEdit }: { onEdit: (mode: FormMode) => void }) {
  const { t } = useTranslation('settings')
  const { useSettingsStore } = useHostScope()
  const saved = useSettingsStore((s) => s.settings.remote.ownRelay)
  const own = useOwnReport()
  const url = own?.url ?? saved?.url ?? ''
  return (
    <div className="k-relay-body">
      <div className="k-relay-table">
        <div className="k-relay-line">
          <span className="ui-sg-label">
            <b className="k-mono">{relayHostName(url)}</b>
            <small>
              <OwnRelayState own={own} />
            </small>
          </span>
          <OwnRelayAction own={own} onEdit={onEdit} />
        </div>
        <div className="k-relay-line">
          <span className="ui-sg-label">
            <b>{t('remote.relay.own.key')}</b>
            <small className="k-mono">
              {own?.keyEnd ? `krk_••••${own.keyEnd}` : t('remote.relay.own.noKey')}
            </small>
          </span>
          <SetButton onClick={() => onEdit('replace')}>{t('remote.relay.own.replace')}</SetButton>
        </div>
      </div>
    </div>
  )
}

/** The host's sign-in to its own relay, in a few words. */
function OwnRelayState({ own }: { own: OwnRelayReport | null }) {
  const { t } = useTranslation('settings')
  const { useRemoteStore } = useHostScope()
  const connection = useRemoteStore((s) =>
    s.status?.relay?.state === 'on' ? s.status.relay.relays[0]?.connection : undefined,
  )
  if (!own) {
    return (
      <span className="k-status">
        <span aria-hidden className="k-dot" data-tone="bad" />
        {t('remote.relay.own.state.noKey')}
      </span>
    )
  }
  if (!connection || connection.state === 'connecting') {
    return <span className="k-status">{t('remote.relay.own.state.connecting')}</span>
  }
  if (connection.state === 'connected') {
    const parts = [t('remote.relay.own.state.connected')]
    if (own.rtt !== null) parts.push(t('remote.relay.own.state.rtt', { ms: Math.round(own.rtt) }))
    if (own.pinned) parts.push(t('remote.relay.own.state.pinned'))
    else if (own.version) parts.push(t('remote.relay.own.state.version', { version: own.version }))
    return (
      <span className="k-status">
        <span aria-hidden className="k-dot" data-tone="ok" />
        {parts.join(' · ')}
      </span>
    )
  }
  const text =
    connection.state === 'conflict'
      ? t('remote.relay.state.conflict')
      : t(`remote.relay.own.state.${errorGroup(connection.error)}`)
  return (
    <span className="k-status">
      <span aria-hidden className="k-dot" data-tone="bad" />
      {text}
    </span>
  )
}

/** The next step the state calls for: a new link for a refused key, Retry, or Change…. */
function OwnRelayAction({
  own,
  onEdit,
}: {
  own: OwnRelayReport | null
  onEdit: (mode: FormMode) => void
}) {
  const { t } = useTranslation('settings')
  const { useRemoteStore } = useHostScope()
  const connection = useRemoteStore((s) =>
    s.status?.relay?.state === 'on' ? s.status.relay.relays[0]?.connection : undefined,
  )
  const refused =
    !own ||
    ((connection?.state === 'refused' || connection?.state === 'retrying') &&
      errorGroup(connection.error) === 'refused')
  if (refused) {
    return (
      <SetButton onClick={() => onEdit('replace')}>{t('remote.relay.own.pasteLink')}</SetButton>
    )
  }
  if (connection?.state === 'retrying' || connection?.state === 'conflict') return <RetryRelay />
  return <SetButton onClick={() => onEdit('change')}>{t('remote.relay.own.change')}</SetButton>
}

type CheckPhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'failed'; problem: OwnRelayProblem }
  | { kind: 'error'; message: string }

/** The address with https when none was typed, since an own relay is reached over https. */
function withScheme(text: string): string {
  const trimmed = text.trim()
  return trimmed === '' || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/**
 * Address and access key, filled in by hand or from the link the relay printed; Use this relay
 * has the host check both and switch once they pass. Nothing changes until then.
 */
function OwnRelayForm({
  mode,
  onCancel,
  onDone,
}: {
  mode: FormMode
  onCancel: () => void
  onDone: () => void
}) {
  const { t } = useTranslation('settings')
  const { api, useSettingsStore } = useHostScope()
  const saved = useSettingsStore((s) => s.settings.remote.ownRelay)
  const current = useSettingsStore((s) => s.settings.remote.relay)
  const own = useOwnReport()
  const onHost = useHostContext()
  const id = useId()
  const [address, setAddress] = useState(saved?.url ?? '')
  const [key, setKey] = useState('')
  // A pin comes with the address it was printed with, and only holds for that address.
  const [pinned, setPinned] = useState<{ url: string; pin: string } | null>(
    saved?.pin ? { url: saved.url, pin: saved.pin } : null,
  )
  const [shown, setShown] = useState(false)
  const [phase, setPhase] = useState<CheckPhase>({ kind: 'idle' })
  const url = withScheme(address)
  const pin = pinned && pinned.url === url ? pinned.pin : null
  // The key kept now is used again for a new address, when the field is left empty.
  const keepsKey = mode === 'change' && current === 'own' && own?.keyEnd != null
  const checking = phase.kind === 'checking'

  /** Splits a pasted link into its address, key and pin; other text is typed as it is. */
  const take = (text: string, into: 'address' | 'key'): void => {
    setPhase({ kind: 'idle' })
    const link = text.includes('#') ? parseRelayLink(text) : null
    if (link?.key) {
      setAddress(link.url)
      setKey(link.key)
      setPinned(link.pin ? { url: link.url, pin: link.pin } : null)
      return
    }
    if (into === 'address') setAddress(text)
    else setKey(text)
  }

  const submit = (): void => {
    if (checking) return
    if (url === '') return setPhase({ kind: 'failed', problem: 'address' })
    const typed = key.trim()
    if (typed === '' && !keepsKey) return setPhase({ kind: 'failed', problem: 'key' })
    setPhase({ kind: 'checking' })
    api.remote
      .useOwnRelay({ url, key: typed === '' ? null : typed, pin })
      .then((result: OwnRelayCheck) => {
        if (result.ok) onDone()
        else setPhase({ kind: 'failed', problem: result.problem })
      })
      .catch((e: unknown) => setPhase({ kind: 'error', message: errorMessage(e) }))
  }

  const failedAt = phase.kind === 'failed' ? STEP_OF[phase.problem] : null
  const host = relayHostName(url)
  const port = URL.parse(url)?.port || (url.startsWith('http:') ? '80' : '443')
  const problemText = (problem: OwnRelayProblem): ReactNode =>
    problem === 'key_refused' ? (
      <>
        {t('remote.relay.own.problem.key_refused')} <span className="k-mono">kettu-relay link</span>{' '}
        {t('remote.relay.own.problem.key_refusedEnd')}
      </>
    ) : (
      t(
        problem === 'certificate' && pin
          ? 'remote.relay.own.problem.certificatePinned'
          : `remote.relay.own.problem.${problem}`,
        { host, port },
      )
    )
  const addressProblem =
    phase.kind === 'failed' && STEP_OF[phase.problem] !== 'key' ? phase.problem : null
  const keyProblem =
    phase.kind === 'failed' && STEP_OF[phase.problem] === 'key' ? phase.problem : null

  return (
    <form
      className="k-relay-body"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
      // The card's radio takes Space and the arrows; typing here stays in the fields.
      onKeyDown={(event) => event.stopPropagation()}
    >
      <label className="k-field k-relay-field" htmlFor={`${id}-address`}>
        {t('remote.relay.own.address')}
        <SetInput
          id={`${id}-address`}
          className="k-mono k-relay-input"
          value={address}
          placeholder="https://relay.example.com"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoFocus={mode !== 'replace'}
          readOnly={checking}
          aria-invalid={addressProblem ? true : undefined}
          aria-describedby={`${id}-address-hint`}
          onChange={(event) => take(event.target.value, 'address')}
        />
        <span
          id={`${id}-address-hint`}
          className="k-relay-hint"
          data-bad={addressProblem ? '' : undefined}
          role={addressProblem ? 'alert' : undefined}
        >
          {addressProblem
            ? problemText(addressProblem)
            : pin
              ? t('remote.relay.own.pinnedHint')
              : t('remote.relay.own.addressHint')}
        </span>
      </label>
      <label className="k-field k-relay-field" htmlFor={`${id}-key`}>
        {t('remote.relay.own.key')}
        <span className="k-relay-secret">
          <SetInput
            id={`${id}-key`}
            className="k-mono k-relay-input"
            type={shown ? 'text' : 'password'}
            value={key}
            placeholder={keepsKey ? `krk_••••${own?.keyEnd ?? ''}` : 'krk_…'}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            autoFocus={mode === 'replace'}
            readOnly={checking}
            aria-invalid={keyProblem ? true : undefined}
            aria-describedby={`${id}-key-hint`}
            onChange={(event) => take(event.target.value, 'key')}
          />
          <IconAction
            label={t(shown ? 'remote.relay.own.hideKey' : 'remote.relay.own.showKey')}
            icon={shown ? ViewOffSlashIcon : ViewIcon}
            onClick={() => setShown((value) => !value)}
          />
        </span>
        <span
          id={`${id}-key-hint`}
          className="k-relay-hint"
          data-bad={keyProblem ? '' : undefined}
          role={keyProblem ? 'alert' : undefined}
        >
          {keyProblem
            ? problemText(keyProblem)
            : keepsKey
              ? t('remote.relay.own.keyKept', { end: own?.keyEnd })
              : t('remote.relay.own.keyHint', onHost)}
        </span>
      </label>
      {(checking || phase.kind === 'failed') && (
        <ChecksList checking={checking} failedAt={failedAt} />
      )}
      {phase.kind === 'error' && <ControlError error={phase.message} wrap />}
      <div className="k-relay-actions">
        <a
          className="k-link k-relay-docs"
          href={t('remote.relay.own.docsUrl')}
          target="_blank"
          rel="noreferrer"
        >
          <Icon icon={BookOpen01Icon} size={14} />
          {t('remote.relay.own.docs')}
        </a>
        <span className="k-relay-buttons">
          <SetButton variant="ghost" onClick={onCancel} disabled={checking}>
            {t('remote.relay.own.cancel')}
          </SetButton>
          <SetButton variant="primary" type="submit" loading={checking}>
            {t(checking ? 'remote.relay.own.checking' : 'remote.relay.own.use')}
          </SetButton>
        </span>
      </div>
    </form>
  )
}

/**
 * The host's checks, each passed, failed or still to come. The host answers once for all of them,
 * so while it checks none is marked passed; a failure passed the ones before it.
 */
function ChecksList({ checking, failedAt }: { checking: boolean; failedAt: Step | null }) {
  const { t } = useTranslation('settings')
  const at = failedAt ? STEPS.indexOf(failedAt) : -1
  return (
    <ol aria-label={t('remote.relay.own.checks')} aria-live="polite" className="kettu-sd__steps">
      {STEPS.map((step, index) => {
        const state = checking
          ? 'active'
          : index < at
            ? 'done'
            : index === at
              ? 'failed'
              : 'pending'
        return (
          <li key={step} className="kettu-sd__step" data-state={state}>
            <span aria-hidden className="kettu-sd__step-mark">
              {state === 'done' && <Icon icon={Tick02Icon} size={14} />}
              {state === 'active' && <span className="ui-ss-spinner" />}
              {state === 'failed' && <Icon icon={Alert02Icon} size={14} />}
              {state === 'pending' && <span className="kettu-sd__step-ring" />}
            </span>
            <span className="kettu-sd__step-text">
              <span className="k-name">
                {t(`remote.relay.own.step.${step}`)}
                {(state === 'done' || state === 'failed') && (
                  <span className="sr-only"> {t(`remote.relay.own.step.${state}`)}</span>
                )}
              </span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
