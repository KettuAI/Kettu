// Settings › Remote access › Relay: one row picks the Kettu relay, the owner's own relay or none.
// Your own relay is filled in under it and checked by the host before it switches; once in use,
// its address with how the host's sign-in is doing and the end of its access key are rows under it.

import { useState, type ReactNode } from 'react'
import { BookOpen01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { parseRelayLink, type OwnRelayCheck, type OwnRelayProblem } from '@shared/remote/own-relay'
import type { OwnRelayReport } from '@shared/remote/status'
import type { RelayChoice } from '@shared/settings'
import { Icon } from '@renderer/components/affect/app-shell'
import { TextField } from '@renderer/components/affect/text-field'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext, useHostHas } from '@renderer/lib/host-features'
import { useHostScope } from '@renderer/stores/host-scope'
import { ControlError, Segmented, SetButton } from './controls'
import { RelayRegions, RetryRelay } from './remote-relay'
import { BlockLine, GroupNote, RowGroup, RowLine, RowShell, RowText } from './rows'
import { errorGroup, relayHostName } from './relay-text'
import { useApply } from './use-apply'
import { useCloudOffHere } from './use-cloud-off-here'

/** What the own relay's form is for: a first relay, a new address, or a new key for the same. */
type FormMode = 'new' | 'change' | 'replace'

/** The problems the access key causes; the others are the address's. */
const KEY_PROBLEMS: ReadonlySet<OwnRelayProblem> = new Set(['key', 'key_refused'])

/** The own relay is in use, as the host reports it; null on another relay or before it says. */
function useOwnReport(): OwnRelayReport | null {
  const { useRemoteStore } = useHostScope()
  return useRemoteStore((s) =>
    s.status?.relay?.state === 'on' ? (s.status.relay.own ?? null) : null,
  )
}

/**
 * The end of the access key the host keeps for its own relay, whichever relay is in use; older
 * hosts report it only while their own relay is.
 */
function useKeptKeyEnd(): string | null {
  const { useRemoteStore } = useHostScope()
  const kept = useRemoteStore((s) => s.status?.ownRelayKeyEnd)
  const own = useOwnReport()
  return kept !== undefined ? kept : (own?.keyEnd ?? null)
}

/**
 * The group's card: the Relay row with its choices, then what the choice brings, the own relay's
 * form or rows, or the Kettu relay's regions. In Local mode the Kettu relay is left out.
 */
export function RelayCard() {
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

  const description = t(
    value === 'own' && cloudOff
      ? 'remote.relay.choice.own.descriptionLocal'
      : `remote.relay.choice.${value}.description`,
    onHost,
  )

  return (
    <RowGroup>
      <RowShell id="relay">
        <RowLine
          text={
            <RowText
              name={t('remote.relay.group')}
              description={
                canOwn ? description : `${description} ${t('remote.relay.choice.own.older')}`
              }
            />
          }
        >
          <ControlError error={error} />
          <Segmented
            label={t('remote.relay.group')}
            value={value}
            options={options.map((option) => ({
              value: option,
              label: t(`remote.relay.choice.${option}.short`),
              disabled: option === 'own' && !canOwn,
            }))}
            onChange={pick}
          />
        </RowLine>
      </RowShell>
      {editing ? (
        <RowShell>
          <OwnRelayForm
            mode={editing}
            onCancel={() => setEditing(null)}
            onDone={() => setEditing(null)}
          />
        </RowShell>
      ) : current === 'own' ? (
        <OwnRelayInUse onEdit={setEditing} />
      ) : (
        current === 'kettu' &&
        regions && (
          <RowShell id="relay-regions">
            <div className="k-block">
              <BlockLine
                text={
                  <RowText
                    name={t('remote.relay.regions')}
                    description={t('remote.relay.regionsDescription')}
                  />
                }
              />
              <RelayRegions />
            </div>
          </RowShell>
        )
      )}
    </RowGroup>
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
    <>
      <RowShell>
        <RowLine
          text={
            <RowText
              name={<span className="k-mono">{relayHostName(url)}</span>}
              description={<OwnRelayState own={own} />}
            />
          }
        >
          <OwnRelayAction own={own} onEdit={onEdit} />
        </RowLine>
      </RowShell>
      <RowShell>
        <RowLine
          text={
            <RowText
              name={t('remote.relay.own.key')}
              description={
                own?.keyEnd ? (
                  <span className="k-mono">krk_••••{own.keyEnd}</span>
                ) : (
                  t('remote.relay.own.noKey')
                )
              }
            />
          }
        >
          <SetButton onClick={() => onEdit('replace')}>{t('remote.relay.own.replace')}</SetButton>
        </RowLine>
      </RowShell>
    </>
  )
}

/** The host's sign-in to its own relay, in a few words after a dot of its state. */
function OwnRelayState({ own }: { own: OwnRelayReport | null }) {
  const { t } = useTranslation('settings')
  const { useRemoteStore } = useHostScope()
  const connection = useRemoteStore((s) =>
    s.status?.relay?.state === 'on' ? s.status.relay.relays[0]?.connection : undefined,
  )
  if (!own) {
    return (
      <>
        <span aria-hidden className="k-dot" data-tone="bad" />
        {t('remote.relay.own.state.noKey')}
      </>
    )
  }
  if (!connection || connection.state === 'connecting') {
    return (
      <>
        <span aria-hidden className="k-dot" />
        {t('remote.relay.own.state.connecting')}
      </>
    )
  }
  if (connection.state === 'connected') {
    const parts = [t('remote.relay.own.state.connected')]
    if (own.rtt !== null) parts.push(t('remote.relay.own.state.rtt', { ms: Math.round(own.rtt) }))
    if (own.pinned) parts.push(t('remote.relay.own.state.pinned'))
    else if (own.version) parts.push(t('remote.relay.own.state.version', { version: own.version }))
    return (
      <>
        <span aria-hidden className="k-dot" data-tone="ok" />
        {parts.join(' · ')}
      </>
    )
  }
  const text =
    connection.state === 'conflict'
      ? t('remote.relay.state.conflict')
      : t(`remote.relay.own.state.${errorGroup(connection.error)}`)
  return (
    <span className="k-relay-bad">
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
      <SetButton variant="primary" onClick={() => onEdit('replace')}>
        {t('remote.relay.own.pasteLink')}
      </SetButton>
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
 * has the host check both and switch once they pass. Nothing changes until then, and a check
 * that fails says why under the field it concerns.
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
  const keptEnd = useKeptKeyEnd()
  const onHost = useHostContext()
  const [address, setAddress] = useState(saved?.url ?? '')
  const [key, setKey] = useState('')
  // A pin comes with the address it was printed with, and only holds for that address.
  const [pinned, setPinned] = useState<{ url: string; pin: string } | null>(
    saved?.pin ? { url: saved.url, pin: saved.pin } : null,
  )
  const [phase, setPhase] = useState<CheckPhase>({ kind: 'idle' })
  const url = withScheme(address)
  const pin = pinned && pinned.url === url ? pinned.pin : null
  // The key kept now is used again when the field is left empty, unless it is being replaced.
  const keepsKey = mode !== 'replace' && keptEnd !== null
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
  const problem = phase.kind === 'failed' ? phase.problem : null
  const keyProblem = problem && KEY_PROBLEMS.has(problem) ? problem : null
  const addressProblem = problem && !keyProblem ? problem : null

  return (
    <form
      className="k-block k-relay-form"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <TextField
        label={t('remote.relay.own.address')}
        inputClassName="k-mono"
        value={address}
        placeholder="https://relay.example.com"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        autoFocus={mode !== 'replace'}
        readOnly={checking}
        hint={pin ? t('remote.relay.own.pinnedHint') : t('remote.relay.own.addressHint')}
        error={addressProblem && problemText(addressProblem)}
        onChange={(event) => take(event.target.value, 'address')}
      />
      <TextField
        label={t('remote.relay.own.key')}
        inputClassName="k-mono"
        type="password"
        value={key}
        placeholder={keepsKey ? `krk_••••${keptEnd}` : 'krk_…'}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        autoFocus={mode === 'replace'}
        readOnly={checking}
        hint={
          keepsKey
            ? t('remote.relay.own.keyKept', { end: keptEnd })
            : t('remote.relay.own.keyHint', onHost)
        }
        error={keyProblem && problemText(keyProblem)}
        onChange={(event) => take(event.target.value, 'key')}
      />
      {phase.kind === 'error' && <ControlError error={phase.message} wrap />}
      <div className="k-block-foot">
        <a
          className="k-relay-docs"
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
