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
import { Alert02Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import type { DiscoveredHost } from '@shared/remote/discovery'
import {
  parseSshTarget,
  type HostPairingFailure,
  type HostPairingState,
  type HostStatus,
  type SshAddFailure,
  type SshStep,
} from '@shared/remote/hosts'
import { parsePairingLink } from '@shared/remote/pairing'
import { Icon } from '@renderer/components/affect/app-shell'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { Segmented, SetButton, Spin } from './controls'
import { AccountHostsPicker, AccountPairFlow } from './host-account'
import { Added } from './host-added'
import { closeRequest } from './pair-close'
import {
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'

/** Why Add host shows no host: what pairing said, or what kept it from starting. */
export type AddHostFailure = HostPairingFailure | 'self' | 'unavailable'

/** Why a pasted link added no host. */
type LinkFailure = Exclude<AddHostFailure, SshAddFailure>

export type AddHostStep =
  | { kind: 'paste'; invalid: boolean }
  | { kind: 'connecting' }
  | { kind: 'confirm' }
  | { kind: 'failed'; reason: LinkFailure }
  | { kind: 'added'; host: HostStatus }

/** How the machine is reached: a pairing link pasted, or an SSH address typed. */
export type AddHostTab = 'link' | 'ssh'

/** Adding over SSH: the steps it went through, the last one the current one. */
export type SshAddStep =
  | { kind: 'enter' }
  | { kind: 'working'; steps: SshStep[] }
  | { kind: 'failed'; steps: SshStep[]; reason: AddHostFailure; detail: string | null }
  | { kind: 'added'; host: HostStatus }

const stepsOf = (step: SshAddStep): SshStep[] =>
  step.kind === 'working' || step.kind === 'failed' ? step.steps : []

/** The step a pairing state names, without the state's own field. */
function sshStep(state: Extract<HostPairingState, { state: 'ssh' }>): SshStep {
  switch (state.step) {
    case 'installing':
      return { step: state.step, version: state.version }
    case 'updating':
      return { step: state.step, from: state.from, to: state.to }
    default:
      return { step: state.step }
  }
}

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
  /** Opens on the SSH tab with this address, for a machine added over SSH before. */
  ssh?: string
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
  ssh?: string
  pairingRef: RefObject<boolean>
  onDone: (added: HostStatus | null) => void
}) {
  // One of the account's hosts, once its Connect was chosen.
  const [account, setAccount] = useState<DiscoveredHost | null>(null)
  const [tab, setTab] = useState<AddHostTab>(sshTarget ? 'ssh' : 'link')
  const [step, setStep] = useState<AddHostStep>({ kind: 'paste', invalid: false })
  const [draft, setDraft] = useState('')
  const [link, setLink] = useState('')
  const [ssh, setSsh] = useState<SshAddStep>({ kind: 'enter' })
  const [sshDraft, setSshDraft] = useState(sshTarget ?? '')
  const [target, setTarget] = useState('')
  // Each way has a pairing of its own, so switching tabs leaves the other one going.
  const linkPairing = useRef<number | null>(null)
  const sshPairing = useRef<number | null>(null)
  const linkAttempt = useRef(0)
  const sshAttempt = useRef(0)
  // Progress of a pairing main has not named yet, as an event may beat the answer to pair().
  const early = useRef(new Map<number, HostPairingState[]>())
  const input = useRef<HTMLInputElement>(null)

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

  const takeSsh = (state: HostPairingState): void => {
    if (state.state === 'added' || state.state === 'failed') sshPairing.current = null
    if (state.state === 'added') setSsh({ kind: 'added', host: state.host })
    else if (state.state === 'failed') {
      const { reason } = state
      const detail = state.detail ?? null
      setSsh((now) => ({ kind: 'failed', steps: stepsOf(now), reason, detail }))
    } else if (state.state === 'ssh') {
      const next = sshStep(state)
      setSsh((now) => ({ kind: 'working', steps: [...stepsOf(now), next] }))
    }
  }

  const closeLink = (): void => {
    const pairId = linkPairing.current
    linkPairing.current = null
    if (pairId !== null) void window.kettu.hosts.closePairing(pairId)
  }

  const closeSsh = (): void => {
    const pairId = sshPairing.current
    sshPairing.current = null
    if (pairId !== null) void window.kettu.hosts.closePairing(pairId)
  }

  /** Add host closed: its pairings end, and an answer still on its way to main is let go. */
  const abandon = (): void => {
    linkAttempt.current++
    sshAttempt.current++
    closeLink()
    closeSsh()
  }

  useEffect(() => {
    if (!open) return
    const off = window.kettu.hosts.onPairing(({ pairId, pairing: state }) => {
      if (pairId === linkPairing.current) takeLink(state)
      else if (pairId === sshPairing.current) takeSsh(state)
      else early.current.set(pairId, [...(early.current.get(pairId) ?? []), state])
    })
    return () => {
      off()
      abandon()
    }
    // One subscription for each opening; the handlers reach only refs and state setters.
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

  const startSsh = (text: string): void => {
    const parsed = parseSshTarget(text)
    if (!parsed) return
    closeSsh()
    const run = ++sshAttempt.current
    setTarget(parsed)
    setSshDraft(parsed)
    setSsh({ kind: 'working', steps: [] })
    const failed = (reason: AddHostFailure): void =>
      setSsh({ kind: 'failed', steps: [], reason, detail: null })
    window.kettu.hosts.addSsh(parsed).then(
      (started) => {
        if (run !== sshAttempt.current) {
          if (started.kind === 'pairing') void window.kettu.hosts.closePairing(started.pairId)
          return
        }
        if (started.kind === 'invalid') return setSsh({ kind: 'enter' })
        if (started.kind !== 'pairing') return failed(started.kind)
        sshPairing.current = started.pairId
        caughtUp(started.pairId, takeSsh)
      },
      () => {
        if (run === sshAttempt.current) failed('ssh_failed')
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

  if (account) {
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

  const choosing = tab === 'ssh' ? ssh.kind === 'enter' : step.kind === 'paste'
  const tabs = (
    <>
      {choosing && (
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
      {tab === 'ssh' || ssh.kind === 'added' ? (
        <SshAddBody
          step={ssh}
          draft={sshDraft}
          target={target}
          tabs={tabs}
          onDraft={(text) => {
            setSshDraft(text)
            // A changed address goes back to asking, without what the last try said.
            if (ssh.kind === 'failed') setSsh({ kind: 'enter' })
          }}
          onSubmit={startSsh}
          onRetry={() => startSsh(target)}
          onDone={() => onDone(ssh.kind === 'added' ? ssh.host : null)}
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

/** The SSH tab's content in each step: the address, then each step and how it ended. */
export function SshAddBody({
  step,
  draft,
  target,
  inputRef,
  onDraft,
  onSubmit,
  onRetry,
  onDone,
  tabs,
}: {
  step: SshAddStep
  draft: string
  /** The address being added, or the last one tried. */
  target: string
  inputRef?: Ref<HTMLInputElement>
  onDraft: (text: string) => void
  onSubmit: (text: string) => void
  onRetry: () => void
  onDone: () => void
  tabs?: ReactNode
}) {
  const { t } = useTranslation(['settings', 'common'])
  const errorId = useId()
  const fieldId = useId()
  if (step.kind === 'added') return <Added host={step.host} onDone={onDone} />
  const working = step.kind === 'working'
  const failure = step.kind === 'failed' ? step : null
  const valid = parseSshTarget(draft) !== null
  const steps = stepsOf(step)
  return (
    <>
      <SettingsDialogHeader title={t('hosts.add.title')} />
      <SettingsDialogBody>
        {tabs}
        <SettingsField
          label={t('hosts.add.ssh.label')}
          htmlFor={fieldId}
          hint={!failure && t('hosts.add.ssh.note')}
        >
          <div className="kettu-sd__inline">
            <input
              id={fieldId}
              ref={inputRef}
              value={working ? target : draft}
              readOnly={working}
              autoFocus
              aria-describedby={failure ? errorId : undefined}
              placeholder={t('hosts.add.ssh.placeholder')}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              className={DIALOG_MONO_FIELD}
              onChange={(event) => onDraft(event.target.value)}
              onKeyDown={(event) => {
                if (working || isComposing(event) || event.key !== 'Enter') return
                event.preventDefault()
                if (valid) onSubmit(draft)
              }}
            />
            {!failure && (
              <SetButton
                size="md"
                variant="primary"
                disabled={!valid || working}
                onClick={() => onSubmit(draft)}
              >
                {t('hosts.add.ssh.connect')}
              </SetButton>
            )}
          </div>
        </SettingsField>
        {steps.length > 0 && (
          <SshProgress steps={steps} failed={failure !== null} target={target} />
        )}
        {failure && (
          <SshFailure
            id={errorId}
            reason={failure.reason}
            target={target}
            detail={failure.detail}
          />
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter>
        {failure ? (
          <>
            <DialogClose render={<SetButton size="md" variant="ghost" />}>
              {t('common:actions.close')}
            </DialogClose>
            <SetButton
              size="md"
              variant="primary"
              disabled={!valid}
              onClick={() => (draft.trim() === target ? onRetry() : onSubmit(draft))}
            >
              {t('hosts.add.retry')}
            </SetButton>
          </>
        ) : (
          <DialogClose render={<SetButton size="md" variant="ghost" />}>
            {t('common:actions.cancel')}
          </DialogClose>
        )}
      </SettingsDialogFooter>
    </>
  )
}

type StepState = 'done' | 'active' | 'failed' | 'pending'

/**
 * Logging in, installing or updating once that turned out to be needed, adding this computer and
 * opening the channel: each done, under way, failed or still to come.
 */
function SshProgress({
  steps,
  failed,
  target,
}: {
  steps: SshStep[]
  failed: boolean
  target: string
}) {
  const { t } = useTranslation('settings')
  const install = steps.find((s) => s.step === 'installing' || s.step === 'updating')
  const items: { id: SshStep['step']; label: string; detail?: string }[] = [
    { id: 'connecting', label: t('hosts.add.ssh.steps.connecting'), detail: target },
    ...(install?.step === 'installing'
      ? [
          {
            id: install.step,
            label: t('hosts.add.ssh.steps.installing', install),
            detail: t('hosts.add.ssh.steps.installingDetail'),
          },
        ]
      : install?.step === 'updating'
        ? [{ id: install.step, label: t('hosts.add.ssh.steps.updating', install) }]
        : []),
    { id: 'adding', label: t('hosts.add.ssh.steps.adding') },
    { id: 'opening', label: t('hosts.add.ssh.steps.opening') },
  ]
  const at = items.findIndex((item) => item.id === steps.at(-1)?.step)
  const stateAt = (index: number): StepState =>
    index < at ? 'done' : index > at ? 'pending' : failed ? 'failed' : 'active'
  return (
    <ol aria-label={t('hosts.add.ssh.steps.label')} aria-live="polite" className="kettu-sd__steps">
      {items.map((item, index) => {
        const state = stateAt(index)
        return (
          <li
            key={item.id}
            aria-current={state === 'active' ? 'step' : undefined}
            className="kettu-sd__step"
            data-state={state}
          >
            <span aria-hidden className="kettu-sd__step-mark">
              {state === 'done' && <Icon icon={Tick02Icon} size={14} />}
              {state === 'active' && <span className="ui-ss-spinner" />}
              {state === 'failed' && <Icon icon={Alert02Icon} size={14} />}
              {state === 'pending' && <span className="kettu-sd__step-ring" />}
            </span>
            <span className="kettu-sd__step-text">
              <span className="k-name">
                {item.label}
                {(state === 'done' || state === 'failed') && (
                  <span className="sr-only"> {t(`hosts.add.ssh.steps.${state}`)}</span>
                )}
              </span>
              {item.detail && <span className="k-name kettu-sd__hint">{item.detail}</span>}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

type SshErrorKey = SshAddFailure extends `ssh_${infer K}` ? K : never

/** Failures whose last lines of output say more than the sentence can. */
const WITH_OUTPUT: ReadonlySet<AddHostFailure> = new Set([
  'ssh_unreachable',
  'ssh_install',
  'ssh_failed',
])

/** Why adding over SSH failed, what to try, and the end of the output where it helps. */
function SshFailure({
  id,
  reason,
  target,
  detail,
}: {
  id: string
  reason: AddHostFailure
  target: string
  detail: string | null
}) {
  const { t } = useTranslation('settings')
  let text: ReactNode
  if (reason === 'unavailable') text = t('hosts.keyFailed')
  else if (reason === 'ssh_unsupported') {
    text = detail
      ? t('hosts.add.ssh.errors.unsupported', { target, system: detail })
      : t('hosts.add.ssh.errors.noShell', { target })
  } else if (reason.startsWith('ssh_')) {
    text = (
      <Trans
        t={t}
        i18nKey={`hosts.add.ssh.errors.${reason.slice(4) as SshErrorKey}`}
        values={{ target }}
        components={{ code: <code className="k-code" /> }}
      />
    )
  } else text = t(`hosts.add.${reason as Exclude<LinkFailure, 'unavailable'>}`)
  const output = detail && WITH_OUTPUT.has(reason) ? detail : null
  return (
    <div id={id} role="alert" className="kettu-sd__stack">
      <p className="kettu-sd__error" data-selectable="">
        {text}
      </p>
      {output && (
        <pre data-selectable="" aria-label={t('hosts.add.ssh.output')} className="kettu-sd__output">
          {output}
        </pre>
      )}
    </div>
  )
}
