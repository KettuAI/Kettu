// Add host's SSH tab: the machines of the user's own SSH config, checked and added together, at
// most three at a time, each row with its own progress; and a form for a machine typed by hand.

import { useId, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  Alert02Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  FolderOpenIcon,
  RefreshIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { Trans, useTranslation } from 'react-i18next'
import type { SshAddFailure, SshConfigHost, SshConfigHosts, SshStep } from '@shared/remote/hosts'
import { Icon } from '@renderer/components/affect/app-shell'
import { useRefresh } from '@renderer/components/refresh'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@renderer/components/ui/collapsible'
import { DialogClose } from '@renderer/components/ui/dialog'
import { RadioGroup } from '@renderer/components/ui/radio-group'
import { PANEL } from '@renderer/features/session/entries/helpers'
import { Choice } from './agents-section'
import { FindField, IconAction, SetButton, Skel } from './controls'
import {
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'
import {
  draftAddress,
  draftProblems,
  machineLine,
  matchMachines,
  sshCommand,
  stepsOf,
  type AddHostFailure,
  type SshAdding,
  type SshDraft,
  type SshRun,
} from './ssh-adding'

/** A list longer than this gets a filter. */
const FILTER_FROM = 8

const isComposing = (event: KeyboardEvent<HTMLInputElement>): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229

/** The step a row is at, as the progress list names it. */
function stepLabel(t: TFunction<'settings'>, step: SshStep | undefined): string {
  switch (step?.step) {
    case 'installing':
      return t('hosts.add.ssh.steps.installing', { version: step.version })
    case 'updating':
      return t('hosts.add.ssh.steps.updating', { from: step.from, to: step.to })
    case 'adding':
      return t('hosts.add.ssh.steps.adding')
    case 'opening':
      return t('hosts.add.ssh.steps.opening')
    default:
      return t('hosts.add.ssh.steps.connecting')
  }
}

/**
 * The SSH tab's list: the config's machines with a checkbox each, Add for the checked ones at
 * the end, and Enter manually for any other machine.
 */
export function SshListBody({
  adding,
  tabs,
  onOpenHost,
}: {
  adding: SshAdding
  tabs?: ReactNode
  onOpenHost: (id: string) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const labelId = useId()
  const refresh = useRefresh()
  const [query, setQuery] = useState('')
  const { config, checked, runs } = adding
  const hosts = useMemo(() => (config?.state === 'ok' ? config.hosts : []), [config])
  const shown = useMemo(() => matchMachines(hosts, query), [hosts, query])
  const started = Object.keys(runs).length > 0
  const count = hosts.filter((host) => checked.has(host.alias)).length
  return (
    <>
      <SettingsDialogHeader title={t('hosts.add.title')} />
      <SettingsDialogBody>
        {tabs}
        <section aria-labelledby={labelId} className="kettu-sd__field">
          <div className="kettu-sd__machines-head">
            <h3 id={labelId} className="kettu-sd__label">
              {t('hosts.add.ssh.config.label')}
            </h3>
            {config && (
              <IconAction
                label={t('hosts.add.ssh.config.refresh')}
                icon={refresh.phase === 'done' ? Tick02Icon : RefreshIcon}
                busy={refresh.phase === 'turning'}
                onClick={() => void refresh.run(adding.read)}
              />
            )}
          </div>
          {hosts.length > FILTER_FROM && (
            <FindField
              value={query}
              onChange={setQuery}
              label={t('hosts.add.ssh.config.filter')}
              clearLabel={t('hosts.add.ssh.config.clearFilter')}
            />
          )}
          <MachineList
            config={config}
            shown={shown}
            query={query}
            row={(host) => (
              <MachineRow
                key={host.alias}
                host={host}
                run={adding.runs[host.alias]}
                checked={adding.checked.has(host.alias)}
                onCheck={(on) => adding.setChecked(host.alias, on)}
                onRetry={() => adding.retry(host.alias)}
                onOpenHost={onOpenHost}
              />
            )}
          />
        </section>
        <p className="kettu-sd__hint">{t('hosts.add.ssh.note')}</p>
      </SettingsDialogBody>
      <SettingsDialogFooter
        start={
          <SetButton variant="ghost" onClick={() => adding.setView('manual')}>
            {t('hosts.add.ssh.manual.button')}
          </SetButton>
        }
      >
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t(started ? 'common:actions.close' : 'common:actions.cancel')}
        </DialogClose>
        <SetButton size="md" variant="primary" disabled={count === 0} onClick={adding.addChecked}>
          {count > 0 ? t('hosts.add.ssh.config.addCount', { count }) : t('hosts.add.add')}
        </SetButton>
      </SettingsDialogFooter>
    </>
  )
}

/** The machines, or in their place loading, none, none matching or why the config is unread. */
export function MachineList({
  config,
  shown,
  query,
  row,
}: {
  config: SshConfigHosts | null
  shown: SshConfigHost[]
  query: string
  row: (host: SshConfigHost) => ReactNode
}) {
  const { t } = useTranslation('settings')
  if (config === null) {
    return (
      <ul
        aria-busy="true"
        aria-label={t('hosts.add.ssh.config.loading')}
        className="kettu-sd__machines"
      >
        {[112, 84, 136].map((width) => (
          <li key={width} className="kettu-sd__machine">
            <span className="kettu-sd__machine-line">
              <span className="kettu-sd__machine-mark">
                <Skel width={16} className="k-skel--check" />
              </span>
              <span className="ui-sg-label k-lines">
                <Skel width={width} />
                <Skel width={width + 40} />
              </span>
            </span>
          </li>
        ))}
      </ul>
    )
  }
  if (config.state === 'failed') {
    return (
      <p role="alert" className="kettu-sd__error kettu-sd__machines-note" data-selectable="">
        {config.reason === 'ssh_missing'
          ? t('hosts.add.ssh.errors.missing')
          : t('hosts.add.ssh.config.unreadable', { path: config.path, detail: config.detail })}
      </p>
    )
  }
  if (config.hosts.length === 0) {
    return <p className="kettu-sd__machines-note">{t('hosts.add.ssh.config.empty')}</p>
  }
  if (shown.length === 0) {
    return (
      <p className="kettu-sd__machines-note">
        {t('hosts.add.ssh.config.noMatch', { query: query.trim() })}
      </p>
    )
  }
  return (
    <ul aria-label={t('hosts.add.ssh.config.label')} className="kettu-sd__machines">
      {shown.map(row)}
    </ul>
  )
}

/**
 * One machine: a checkbox until Add takes it, then its state in the checkbox's place, the step
 * it is at under its address, and how it ended.
 */
function MachineRow({
  host,
  run,
  checked,
  onCheck,
  onRetry,
  onOpenHost,
}: {
  host: SshConfigHost
  run: SshRun | undefined
  checked: boolean
  onCheck: (on: boolean) => void
  onRetry: () => void
  onOpenHost: (id: string) => void
}) {
  const { t } = useTranslation('settings')
  const checkId = useId()
  const addedId = run?.kind === 'added' ? run.host.id : (host.hostId ?? null)
  const state = addedId !== null ? 'added' : (run?.kind ?? 'idle')
  let mark: ReactNode
  if (state === 'added') mark = <Icon icon={Tick02Icon} size={14} />
  else if (state === 'working') mark = <span className="ui-ss-spinner" />
  else if (state === 'failed') mark = <Icon icon={Alert02Icon} size={14} />
  else if (state === 'waiting') mark = <span className="kettu-sd__step-ring" />
  else {
    mark = (
      <Checkbox
        id={checkId}
        checked={checked}
        aria-label={t('hosts.add.ssh.config.pick', { alias: host.alias })}
        onCheckedChange={(value) => onCheck(value === true)}
      />
    )
  }
  const text = (
    <span className="ui-sg-label">
      <b className="k-name">{host.alias}</b>
      <small className="k-mono" data-selectable="">
        {machineLine(t, host)}
      </small>
      {state === 'waiting' && <small>{t('hosts.add.ssh.config.waiting')}</small>}
      {state === 'working' && run?.kind === 'working' && (
        <small aria-live="polite">{stepLabel(t, run.steps.at(-1))}</small>
      )}
    </span>
  )
  return (
    <li className="kettu-sd__machine" data-state={state}>
      <span className="kettu-sd__machine-line">
        <span aria-hidden={state !== 'idle' || undefined} className="kettu-sd__machine-mark">
          {mark}
        </span>
        {state === 'idle' ? (
          <label htmlFor={checkId} className="kettu-sd__machine-text">
            {text}
          </label>
        ) : (
          <span className="kettu-sd__machine-text">{text}</span>
        )}
        {addedId !== null && (
          <SetButton
            variant="ghost"
            aria-label={t('hosts.add.ssh.config.openHost', { alias: host.alias })}
            onClick={() => onOpenHost(addedId)}
          >
            {t('hosts.add.ssh.config.added')}
          </SetButton>
        )}
        {run?.kind === 'failed' && <SetButton onClick={onRetry}>{t('hosts.add.retry')}</SetButton>}
      </span>
      {run?.kind === 'failed' && (
        <div className="kettu-sd__machine-more">
          <SshFailure
            reason={run.reason}
            target={host.alias}
            command={sshCommand({ target: host.alias })}
            detail={run.detail}
            folded
          />
        </div>
      )}
    </li>
  )
}

/**
 * The fields of a machine typed by hand: its address, the port and how it signs in. Enter in a
 * field calls `onEnter` once the address is whole.
 */
export function SshAddressFields({
  draft,
  onChange,
  working,
  onEnter,
}: {
  draft: SshDraft
  onChange: (draft: SshDraft) => void
  working: boolean
  onEnter: () => void
}) {
  const { t } = useTranslation('settings')
  const addressId = useId()
  const portId = useId()
  const keyId = useId()
  const errorId = useId()
  const problems = draftProblems(draft)
  const set = (patch: Partial<SshDraft>): void => onChange({ ...draft, ...patch })
  const submit = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (working || isComposing(event) || event.key !== 'Enter') return
    event.preventDefault()
    if (draftAddress(draft)) onEnter()
  }
  const choose = async (): Promise<void> => {
    const path = await window.kettu.hosts.chooseKeyFile()
    if (path) set({ keyFile: path })
  }
  return (
    <>
      <div className="kettu-sd__address-port">
        <SettingsField label={t('hosts.add.ssh.manual.address')} htmlFor={addressId}>
          <input
            id={addressId}
            value={draft.address}
            readOnly={working}
            autoFocus
            aria-invalid={problems.address || undefined}
            placeholder={t('hosts.add.ssh.placeholder')}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            className={DIALOG_MONO_FIELD}
            onChange={(event) => set({ address: event.target.value })}
            onKeyDown={submit}
          />
        </SettingsField>
        <SettingsField label={t('hosts.add.ssh.manual.port')} htmlFor={portId}>
          <input
            id={portId}
            value={draft.port}
            readOnly={working}
            inputMode="numeric"
            aria-invalid={problems.port || undefined}
            aria-describedby={problems.port ? errorId : undefined}
            placeholder={t('hosts.add.ssh.manual.optional')}
            spellCheck={false}
            autoComplete="off"
            className={DIALOG_MONO_FIELD}
            onChange={(event) => set({ port: event.target.value })}
            onKeyDown={submit}
          />
        </SettingsField>
      </div>
      {problems.port && (
        <p id={errorId} role="alert" className="kettu-sd__error">
          {t('hosts.add.ssh.manual.portInvalid')}
        </p>
      )}
      <SettingsField label={t('hosts.add.ssh.manual.signIn')}>
        <RadioGroup
          aria-label={t('hosts.add.ssh.manual.signIn')}
          value={draft.signIn}
          disabled={working}
          onValueChange={(next) => set({ signIn: next as SshDraft['signIn'] })}
          className="kettu-sd__choices"
        >
          <Choice
            value="agent"
            checked={draft.signIn === 'agent'}
            title={t('hosts.add.ssh.manual.agent')}
            description={t('hosts.add.ssh.manual.agentHint')}
          />
          <Choice
            value="key"
            checked={draft.signIn === 'key'}
            title={t('hosts.add.ssh.manual.key')}
            description={t('hosts.add.ssh.manual.keyHint')}
            extra={
              draft.signIn === 'key' && (
                <div className="kettu-sd__stack">
                  <div className="kettu-sd__inline">
                    <input
                      id={keyId}
                      value={draft.keyFile}
                      readOnly={working}
                      aria-label={t('hosts.add.ssh.manual.keyPath')}
                      aria-invalid={problems.key || undefined}
                      placeholder={t('hosts.add.ssh.manual.keyPlaceholder')}
                      spellCheck={false}
                      autoComplete="off"
                      className={DIALOG_MONO_FIELD}
                      onChange={(event) => set({ keyFile: event.target.value })}
                      onKeyDown={submit}
                    />
                    <SetButton
                      icon={<Icon icon={FolderOpenIcon} size={14} />}
                      disabled={working}
                      onClick={() => void choose()}
                    >
                      {t('hosts.add.ssh.manual.choose')}
                    </SetButton>
                  </div>
                  {problems.key && (
                    <p role="alert" className="kettu-sd__error">
                      {t('hosts.add.ssh.manual.keyInvalid')}
                    </p>
                  )}
                </div>
              )
            }
          />
        </RadioGroup>
      </SettingsField>
    </>
  )
}

/** A machine typed by hand: its address, port and how it signs in, then its progress. */
export function SshManualBody({ adding, tabs }: { adding: SshAdding; tabs?: ReactNode }) {
  const { t } = useTranslation(['settings', 'common'])
  const { draft, manual, manualAddress } = adding
  const working = manual.kind === 'working'
  const failure = manual.kind === 'failed' ? manual : null
  const address = draftAddress(draft)
  const steps = stepsOf(manual)
  const shownAddress = manualAddress ?? { target: draft.address.trim() }
  return (
    <>
      <SettingsDialogHeader title={t('hosts.add.title')} />
      <SettingsDialogBody>
        {tabs}
        <SshAddressFields
          draft={draft}
          onChange={adding.setDraft}
          working={working}
          onEnter={adding.startManual}
        />
        {!failure && steps.length === 0 && (
          <p className="kettu-sd__hint">{t('hosts.add.ssh.note')}</p>
        )}
        {steps.length > 0 && (
          <SshProgress steps={steps} failed={failure !== null} target={shownAddress.target} />
        )}
        {failure && (
          <SshFailure
            reason={failure.reason}
            target={shownAddress.target}
            command={sshCommand(shownAddress)}
            detail={failure.detail}
          />
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter
        start={
          !working && (
            <SetButton
              variant="ghost"
              icon={<Icon icon={ArrowLeft01Icon} size={14} />}
              onClick={() => adding.setView('list')}
            >
              {t('hosts.add.ssh.manual.back')}
            </SetButton>
          )
        }
      >
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t(failure ? 'common:actions.close' : 'common:actions.cancel')}
        </DialogClose>
        {!working && (
          <SetButton size="md" variant="primary" disabled={!address} onClick={adding.startManual}>
            {t(failure ? 'hosts.add.retry' : 'hosts.add.ssh.manual.add')}
          </SetButton>
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

/**
 * Why adding over SSH failed, what to try, and the end of the output where it helps: in a
 * disclosure on a list's row, `folded`, so the rows stay short.
 */
function SshFailure({
  reason,
  target,
  command,
  detail,
  folded,
}: {
  reason: AddHostFailure
  target: string
  command: string
  detail: string | null
  folded?: boolean
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
        values={{ target, command }}
        components={{ code: <code className="k-code" /> }}
      />
    )
  } else text = t(`hosts.add.${reason as Exclude<AddHostFailure, SshAddFailure | 'unavailable'>}`)
  const output = detail && WITH_OUTPUT.has(reason) ? detail : null
  const pre = output && (
    <pre data-selectable="" aria-label={t('hosts.add.ssh.output')} className="kettu-sd__output">
      {output}
    </pre>
  )
  return (
    <div role="alert" className="kettu-sd__stack">
      <p className="kettu-sd__error" data-selectable="">
        {text}
      </p>
      {pre &&
        (folded ? (
          <Collapsible>
            <CollapsibleTrigger className="kettu-sd__output-toggle">
              <Icon icon={ArrowDown01Icon} size={12} />
              {t('hosts.add.ssh.output')}
            </CollapsibleTrigger>
            <CollapsibleContent className={PANEL}>
              <div className="kettu-sd__output-body">{pre}</div>
            </CollapsibleContent>
          </Collapsible>
        ) : (
          pre
        ))}
    </div>
  )
}
