import {
  useEffect,
  useId,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { DiscoveredHost } from '@shared/remote/discovery'
import type { HostPairingState, HostStatus, SshAddFailure, SshAddress } from '@shared/remote/hosts'
import { parsePairingLink } from '@shared/remote/pairing'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { useCloudOff } from '@renderer/lib/cloud'
import { openSettingsItem } from '@renderer/stores/view'
import { Segmented, SetButton, Spin } from './controls'
import { AccountHostsPicker, AccountPairFlow } from './host-account'
import { Added } from './host-added'
import { SshListBody, SshManualBody } from './host-add-ssh'
import { closeRequest } from './pair-close'
import {
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
} from './settings-dialog'
import { useSshAdding, type AddHostFailure } from './ssh-adding'

export type { AddHostFailure } from './ssh-adding'

/** Why a pasted link added no host. */
type LinkFailure = Exclude<AddHostFailure, SshAddFailure>

export type AddHostStep =
  | { kind: 'paste'; invalid: boolean }
  | { kind: 'connecting' }
  | { kind: 'confirm' }
  | { kind: 'failed'; reason: LinkFailure }
  | { kind: 'added'; host: HostStatus }

/** How the machine is reached: a pairing link pasted, or over SSH. */
export type AddHostTab = 'link' | 'ssh'

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
  ssh,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Opens on the SSH tab's form with this address, for a machine added over SSH before. */
  ssh?: SshAddress
  /** The host added, as the dialog closes on it. */
  onAdded?: (host: HostStatus) => void
}) {
  // Each opening starts afresh.
  const [opened, setOpened] = useState(open)
  const [round, setRound] = useState(0)
  // While pairing with one of the account's hosts, a click outside keeps the dialog.
  const pairing = useRef(false)
  if (open !== opened) {
    setOpened(open)
    if (open) setRound((n) => n + 1)
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (!next && closeRequest(pairing.current, details.reason) === 'stay') return
        onOpenChange(next)
      }}
    >
      <AddHostFlow
        key={round}
        open={open}
        ssh={ssh}
        pairingRef={pairing}
        onDone={(host) => {
          onOpenChange(false)
          if (host) onAdded?.(host)
        }}
      />
    </Dialog>
  )
}

function AddHostFlow({
  open,
  ssh: sshTarget,
  pairingRef,
  onDone,
}: {
  open: boolean
  ssh?: SshAddress
  pairingRef: RefObject<boolean>
  onDone: (added: HostStatus | null) => void
}) {
  // One of the account's hosts, once its Connect was chosen.
  const [account, setAccount] = useState<DiscoveredHost | null>(null)
  const cloudOff = useCloudOff()
  const [tab, setTab] = useState<AddHostTab>(sshTarget ? 'ssh' : 'link')
  const [step, setStep] = useState<AddHostStep>({ kind: 'paste', invalid: false })
  const [draft, setDraft] = useState('')
  const [link, setLink] = useState('')
  // Each way has pairings of its own, so switching tabs leaves the other one going.
  const linkPairing = useRef<number | null>(null)
  const linkAttempt = useRef(0)
  // Progress of a pairing main has not named yet, as an event may beat the answer to pair().
  const early = useRef(new Map<number, HostPairingState[]>())
  const input = useRef<HTMLInputElement>(null)
  const ssh = useSshAdding({ active: open && tab === 'ssh', prefill: sshTarget, early })
  const { take: takeSsh, abandon: abandonSsh } = ssh

  const takeLink = (state: HostPairingState): void => {
    if (state.state === 'added' || state.state === 'failed') linkPairing.current = null
    if (state.state === 'added') setStep({ kind: 'added', host: state.host })
    else if (state.state === 'failed') {
      // Only adding over SSH fails for ssh.
      const reason = state.reason.startsWith('ssh_') ? 'unreachable' : state.reason
      setStep({ kind: 'failed', reason: reason as LinkFailure })
    } else if (state.state === 'connecting' || state.state === 'confirm') {
      setStep({ kind: state.state })
    }
  }

  const closeLink = (): void => {
    const pairId = linkPairing.current
    linkPairing.current = null
    if (pairId !== null) void window.kettu.hosts.closePairing(pairId)
  }

  /** Add host closed: its pairings end, and an answer still on its way to main is let go. */
  const abandon = (): void => {
    linkAttempt.current++
    closeLink()
    abandonSsh()
  }

  useEffect(() => {
    if (!open) return
    const off = window.kettu.hosts.onPairing(({ pairId, pairing: state }) => {
      if (pairId === linkPairing.current) takeLink(state)
      else if (!takeSsh(pairId, state)) {
        early.current.set(pairId, [...(early.current.get(pairId) ?? []), state])
      }
    })
    return () => {
      off()
      abandon()
    }
    // One subscription for each opening; the handlers reach only refs, state setters and the SSH
    // tab's handlers, which last as long.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** The progress that came before main named the pairing. */
  const caughtUp = (pairId: number, take: (state: HostPairingState) => void): void => {
    const waiting = early.current.get(pairId) ?? []
    early.current.delete(pairId)
    for (const state of waiting) take(state)
  }

  const start = (text: string): void => {
    const trimmed = text.trim()
    if (!parsePairingLink(trimmed)) {
      setStep({ kind: 'paste', invalid: true })
      return
    }
    closeLink()
    const run = ++linkAttempt.current
    setLink(trimmed)
    setStep({ kind: 'connecting' })
    window.kettu.hosts.pair(trimmed).then(
      (started) => {
        if (run !== linkAttempt.current) {
          if (started.kind === 'pairing') void window.kettu.hosts.closePairing(started.pairId)
          return
        }
        if (started.kind === 'invalid') return setStep({ kind: 'paste', invalid: true })
        if (started.kind !== 'pairing') return setStep({ kind: 'failed', reason: started.kind })
        linkPairing.current = started.pairId
        caughtUp(started.pairId, takeLink)
      },
      () => {
        if (run === linkAttempt.current) setStep({ kind: 'failed', reason: 'unreachable' })
      },
    )
  }

  const again = (): void => {
    linkAttempt.current++
    setDraft('')
    setStep({ kind: 'paste', invalid: false })
    // The field is back once this render is drawn.
    requestAnimationFrame(() => input.current?.focus())
  }

  // While machines are being added over SSH, a click outside keeps the dialog.
  useEffect(() => {
    if (!account) pairingRef.current = ssh.busy
  }, [account, ssh.busy, pairingRef])

  if (account && !cloudOff) {
    return (
      <SettingsDialogContent>
        <AccountPairFlow
          host={account}
          open={open}
          activeRef={pairingRef}
          onDone={onDone}
          onBack={() => setAccount(null)}
        />
      </SettingsDialogContent>
    )
  }

  const sshIdle = Object.keys(ssh.runs).length === 0 && ssh.manual.kind === 'enter'
  const choosing = tab === 'ssh' ? sshIdle : step.kind === 'paste'
  const tabs = (
    <>
      {choosing && !cloudOff && (
        <AccountHostsPicker
          onConnect={(host) => {
            abandon()
            setAccount(host)
          }}
        />
      )}
      <AddHostTabs tab={tab} onTab={setTab} />
    </>
  )
  return (
    <SettingsDialogContent>
      {ssh.manual.kind === 'added' ? (
        <Added
          host={ssh.manual.host}
          onDone={() => onDone(ssh.manual.kind === 'added' ? ssh.manual.host : null)}
        />
      ) : tab === 'ssh' && ssh.view === 'manual' ? (
        <SshManualBody adding={ssh} tabs={tabs} />
      ) : tab === 'ssh' ? (
        <SshListBody
          adding={ssh}
          tabs={tabs}
          onOpenHost={(id) => {
            onDone(null)
            openSettingsItem('hosts', id)
          }}
        />
      ) : (
        <AddHostBody
          step={step}
          draft={draft}
          link={link}
          inputRef={input}
          tabs={tabs}
          onDraft={(text) => {
            setDraft(text)
            if (step.kind === 'paste' && step.invalid) setStep({ kind: 'paste', invalid: false })
          }}
          onSubmit={start}
          onRetry={() => start(link)}
          onAgain={again}
          onDone={() => onDone(step.kind === 'added' ? step.host : null)}
        />
      )}
    </SettingsDialogContent>
  )
}

/** The two ways to reach a machine, over the dialog's body. */
function AddHostTabs({ tab, onTab }: { tab: AddHostTab; onTab: (tab: AddHostTab) => void }) {
  const { t } = useTranslation('settings')
  return (
    <div className="kettu-sd__tabs">
      <Segmented
        label={t('hosts.add.tabs.label')}
        value={tab}
        onChange={onTab}
        options={[
          { value: 'link', label: t('hosts.add.tabs.link') },
          { value: 'ssh', label: t('hosts.add.tabs.ssh') },
        ]}
      />
    </div>
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
  tabs,
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
  /** The ways to reach a machine, over the body. */
  tabs?: ReactNode
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
      <SettingsDialogHeader title={t('hosts.add.title')} />
      <SettingsDialogBody>
        {tabs}
        <p className="kettu-sd__text">
          <Trans
            t={t}
            i18nKey="hosts.add.hint"
            components={{
              code: <code className="k-code" />,
            }}
          />
        </p>
        <input
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
          className={DIALOG_MONO_FIELD}
          onChange={(event) => onDraft(event.target.value)}
          onPaste={pasting ? onPaste : undefined}
          onKeyDown={(event) => {
            if (!pasting || isComposing(event) || event.key !== 'Enter') return
            event.preventDefault()
            onSubmit(draft)
          }}
        />
        {problem && (
          <p id={errorId} role="alert" className="kettu-sd__error">
            {problem === 'unavailable' ? t('hosts.keyFailed') : t(`hosts.add.${problem}`)}
          </p>
        )}
        {step.kind === 'confirm' && (
          <div className="k-inset">
            <b>{t('hosts.add.confirmTitle')}</b>
            <div className="kettu-sd__hint">{t('hosts.add.confirmBody')}</div>
          </div>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter
        start={
          (step.kind === 'connecting' || step.kind === 'confirm') && (
            <span role="status" className="kettu-sd__status">
              <Spin />
              {t(step.kind === 'connecting' ? 'hosts.add.connecting' : 'hosts.add.waiting')}
            </span>
          )
        }
      >
        {failure ? (
          <>
            <DialogClose render={<SetButton size="md" variant="ghost" />}>
              {t('common:actions.close')}
            </DialogClose>
            {failure === 'unreachable' ? (
              <SetButton size="md" variant="primary" onClick={onRetry}>
                {t('hosts.add.retry')}
              </SetButton>
            ) : (
              <SetButton size="md" variant="primary" onClick={onAgain}>
                {t('hosts.add.newLink')}
              </SetButton>
            )}
          </>
        ) : (
          <>
            <DialogClose render={<SetButton size="md" variant="ghost" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            {pasting && (
              <SetButton
                size="md"
                variant="primary"
                disabled={!parsePairingLink(draft.trim())}
                onClick={() => onSubmit(draft)}
              >
                {t('hosts.add.add')}
              </SetButton>
            )}
          </>
        )}
      </SettingsDialogFooter>
    </>
  )
}
