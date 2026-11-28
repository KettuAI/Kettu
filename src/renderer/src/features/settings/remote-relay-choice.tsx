// Settings › Remote access › Relay: one row picks the Kettu relay, the owner's own relay or none.
// Your own relay is filled in under it and checked by the host before it switches; once in use,
// its address with how the host's sign-in is doing and the end of its access key are rows under it.

import { useState, type ReactNode } from 'react'
import { BookOpen01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { parseRelayLink, type OwnRelayCheck, type OwnRelayProblem } from '@shared/remote/own-relay'
import type { OwnRelayReport } from '@shared/remote/status'
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
import { Icon } from '@renderer/components/affect/app-shell'
import { TextField } from '@renderer/components/affect/text-field'
import { errorMessage } from '@renderer/lib/host'
import { useHostContext, useHostHas } from '@renderer/lib/host-features'
import { useTextFieldLabels } from '@renderer/lib/text-field-labels'
import { useHostScope } from '@renderer/stores/host-scope'
import { CONFIRM, ControlError, SetButton, SettingSwitch } from './controls'
import { MeasureRelays, RelayRegions, RetryRelay } from './remote-relay'
import { BlockLine, GroupNote, Notice, RowGroup, RowLine, RowShell, RowText } from './rows'
import { errorGroup, relayHostName } from './relay-text'
import { useApply } from './use-apply'
import { useCloudOffHere } from './use-cloud-off-here'

/** What the own relay's form is for: a first relay, a new address, or a new key for the same. */
type FormMode = 'new' | 'change' | 'replace'

/** The problems the access key causes; the others are the address's. */
const KEY_PROBLEMS: ReadonlySet<OwnRelayProblem> = new Set(['key', 'key_refused'])

/** The own relay report from the host, regardless of whether the official relay is active. */
function useOwnReport(): OwnRelayReport | null {
  const { useRemoteStore } = useHostScope()
  return useRemoteStore((s) => s.status?.relay?.own ?? null)
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
 * Independent switches for the official Kettu relay and the owner's own relay, along with live
 * region states or own-relay status and inline setup form.
 */
export function RelayCard() {
  const { t } = useTranslation(['settings', 'common'])
  const { useSettingsStore, useRemoteStore } = useHostScope()
  const officialSetting = useSettingsStore((s) => s.settings.remote.relay)
  const ownSetting = useSettingsStore((s) => s.settings.remote.ownRelayEnabled)
  const savedOwn = useSettingsStore((s) => s.settings.remote.ownRelay)
  const cloudOff = useCloudOffHere()
  const onHost = useHostContext()
  const canOwn = useHostHas('ownRelay') !== false
  const dualRelay = useHostHas('dualRelay') !== false
  const keptKeyEnd = useKeptKeyEnd()
  const [editing, setEditing] = useState<FormMode | null>(null)
  const [confirm, setConfirm] = useState<{ target: 'official' | 'own' } | null>(null)
  const [apply, error] = useApply()
  const deviceCount = useRemoteStore((s) => s.status?.devices.length ?? 0)
  const offlineCount = useRemoteStore((s) => {
    const status = s.status
    if (!status) return 0
    return status.devices.filter((device) => !status.online.includes(device.id)).length
  })
  // Official regions show once the host signed in to them or reported available regions.
  const regions = useRemoteStore(
    (s) =>
      s.status?.relay?.state === 'on' &&
      ((s.status.relay.available?.length ?? 0) > 0 || s.status.relay.relays.length > 0),
  )
  const officialChecked = !cloudOff && officialSetting
  const ownChecked = ownSetting || editing !== null

  const applyOfficial = (next: boolean): void => {
    if (dualRelay) apply({ remote: { relay: next } })
    else apply({ remote: { relay: next ? 'kettu' : 'off' } })
  }

  const applyOwn = (next: boolean): void => {
    if (dualRelay) apply({ remote: { ownRelayEnabled: next } })
    else apply({ remote: { relay: next ? 'own' : 'off' } })
  }

  const toggleOfficial = (next: boolean): void => {
    if (cloudOff) return
    if (next) {
      applyOfficial(true)
      return
    }
    const willLeaveNone = dualRelay ? !ownSetting : true
    if (willLeaveNone && deviceCount > 0) {
      setConfirm({ target: 'official' })
      return
    }
    applyOfficial(false)
  }

  const toggleOwn = (next: boolean): void => {
    if (!canOwn) return
    if (next) {
      if (!savedOwn || !keptKeyEnd) {
        setEditing('new')
        return
      }
      applyOwn(true)
      return
    }
    if (editing !== null && !ownSetting) {
      setEditing(null)
      return
    }
    const willLeaveNone = dualRelay ? !officialChecked : true
    if (willLeaveNone && deviceCount > 0) {
      setConfirm({ target: 'own' })
      return
    }
    setEditing(null)
    applyOwn(false)
  }

  const settle = (proceed: boolean): void => {
    const pending = confirm
    setConfirm(null)
    if (!proceed || !pending) return
    if (pending.target === 'official') applyOfficial(false)
    else {
      setEditing(null)
      applyOwn(false)
    }
  }

  const officialDescription = t(
    cloudOff ? 'remote.relay.official.descriptionLocal' : 'remote.relay.official.description',
    onHost,
  )
  const ownBaseDescription = t(
    cloudOff ? 'remote.relay.own.toggleDescriptionLocal' : 'remote.relay.own.toggleDescription',
    onHost,
  )
  const ownDescription = !canOwn
    ? `${ownBaseDescription} ${t('remote.relay.choice.own.older')}`
    : !ownChecked && savedOwn
      ? `${ownBaseDescription} ${t('remote.relay.own.savedAt', { host: relayHostName(savedOwn.url) })}`
      : ownBaseDescription

  return (
    <>
      <RowGroup>
        <RowShell id="relay">
          <RowLine
            text={
              <RowText name={t('remote.relay.official.name')} description={officialDescription} />
            }
          >
            <ControlError error={error} />
            <SettingSwitch
              label={t('remote.relay.official.name')}
              checked={officialChecked}
              disabled={cloudOff}
              onChange={toggleOfficial}
            />
          </RowLine>
        </RowShell>
        {officialChecked && regions && (
          <RowShell id="relay-regions">
            <div className="k-block">
              <BlockLine
                text={
                  <RowText
                    name={t('remote.relay.regions')}
                    description={t('remote.relay.regionsDescription')}
                  />
                }
              >
                <MeasureRelays />
              </BlockLine>
              <RelayRegions />
            </div>
          </RowShell>
        )}
        <RowShell id="own-relay">
          <RowLine
            text={<RowText name={t('remote.relay.own.toggleName')} description={ownDescription} />}
          >
            <SettingSwitch
              label={t('remote.relay.own.toggleName')}
              checked={ownChecked}
              disabled={!canOwn}
              onChange={toggleOwn}
            />
          </RowLine>
        </RowShell>
        {editing ? (
          <RowShell>
            <OwnRelayForm
              mode={editing}
              offlineCount={officialChecked ? 0 : offlineCount}
              onCancel={() => setEditing(null)}
              onDone={() => setEditing(null)}
            />
          </RowShell>
        ) : (
          ownSetting && <OwnRelayInUse onEdit={setEditing} />
        )}
      </RowGroup>
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && settle(false)}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('remote.relay.confirm.offTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('remote.relay.confirm.offBody', { count: deviceCount, ...onHost })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => settle(true)}>
              {t('remote.relay.confirm.offConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** What shows under the group: what switching does, what stays, or what Local mode keeps. */
export function RelayNote() {
  return <GroupNote>{useRelayNote()}</GroupNote>
}

function useRelayNote(): string {
  const { t } = useTranslation('settings')
  const { useSettingsStore } = useHostScope()
  const ownEnabled = useSettingsStore((s) => s.settings.remote.ownRelayEnabled)
  const own = useOwnReport()
  const cloudOff = useCloudOffHere()
  const onHost = useHostContext()
  if (cloudOff) return t('remote.relay.note.local')
  if (ownEnabled) {
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
  const fallback = useRemoteStore((s) =>
    s.status?.relay?.state === 'on' ? s.status.relay.relays[0]?.connection : undefined,
  )
  const connection = own?.connection ?? fallback
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
  const fallback = useRemoteStore((s) =>
    s.status?.relay?.state === 'on' ? s.status.relay.relays[0]?.connection : undefined,
  )
  const connection = own?.connection ?? fallback
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
  offlineCount,
  onCancel,
  onDone,
}: {
  mode: FormMode
  offlineCount: number
  onCancel: () => void
  onDone: () => void
}) {
  const { t } = useTranslation('settings')
  const fieldLabels = useTextFieldLabels()
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
  const savedUrl = saved?.url ?? ''
  const savedPin = saved?.pin ?? null
  // Replacing the access key for the same relay address does not strand offline devices.
  const addressChanged = url !== '' && (url !== savedUrl || pin !== savedPin)
  const warnsOffline = offlineCount > 0 && (mode === 'new' || mode === 'change' || addressChanged)

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
        labels={fieldLabels}
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
      {warnsOffline && (
        <Notice
          variant="warning"
          title={t('remote.relay.confirm.offlineTitle', { count: offlineCount })}
        >
          {t('remote.relay.confirm.offlineBody', { count: offlineCount, ...onHost })}
        </Notice>
      )}
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
