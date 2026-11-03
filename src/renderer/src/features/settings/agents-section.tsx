// Settings > Agents: the agents a user picks to work with, each a harness with a configuration
// folder and a name, with its account, sign-in, API key, usage and configuration. Installs and
// updates are Settings > Harnesses'.

import { useId, useState, type FormEvent, type ReactNode } from 'react'
import {
  BotIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
  SquareTerminalIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import {
  AGENT_COLORS,
  AGENT_NAME_CHARS,
  agentColor,
  isAgentColor,
  type AgentColor,
} from '@shared/settings'
import { MULTI_AGENT_HARNESSES, type AgentId, type HarnessId } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { AgentMark, AgentTile } from '@renderer/components/agents/agent-mark'
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
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@renderer/components/ui/empty'
import { Input } from '@renderer/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@renderer/components/ui/radio-group'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { AgentStateLine } from '@renderer/features/agents/agent-state'
import { readiness } from '@renderer/features/agents/readiness'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { addableHarnesses, type AgentsStoreHook } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { useProjectsStore } from '@renderer/stores/projects'
import {
  closeSettings,
  openAgentSettings,
  openHarnessSettings,
  toggleTerminal,
  useViewStore,
} from '@renderer/stores/view'
import { Fact, ListMeter, SignInNotice, SpendGroup, UsageGroup } from './agent-parts'
import {
  currentLimits,
  harnessVersion,
  useAction,
  useAgentReads,
  useHasOtherAgents,
} from './agent-helpers'
import {
  CONFIRM,
  ControlError,
  Masked,
  GROUP_ACTION,
  PathText,
  Pill,
  ROW_BUTTON,
  SettingSelect,
} from './controls'
import { PlaceRow } from './places'
import {
  DIALOG_FIELD,
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from './settings-dialog'
import {
  GroupLabel,
  ItemLine,
  ItemPageHeader,
  ItemRow,
  RowFrame,
  RowGroup,
  RowShell,
  RowText,
} from './rows'
import { useApply } from './use-apply'

/** How long the dialog waits for the host to list an agent it just added, before giving up. */
const ADDED_WAIT_MS = 10_000

/** Resolves once the host lists the agent, which follows the settings change that added it. */
function listed(agents: AgentsStoreHook, agentId: AgentId): Promise<void> {
  return new Promise((resolve, reject) => {
    const known = agents.getState().byId[agentId]
    if (known && known.registered !== false) return resolve()
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`${agentId} did not appear`))
    }, ADDED_WAIT_MS)
    const stop = agents.subscribe((state) => {
      const status = state.byId[agentId]
      if (!status || status.registered === false) return
      clearTimeout(timer)
      stop()
      resolve()
    })
  })
}

/** Runs the agent's terminal sign-in in the built-in terminal of the current project. */
function signInTerminal(status: AgentStatus, command: string): void {
  const view = useViewStore.getState()
  const projectPath = view.projectPath ?? useProjectsStore.getState().projects[0]?.path
  if (!projectPath) return
  closeSettings()
  toggleTerminal(projectPath, true)
  emitAppEvent({ kind: 'sign-in-terminal', projectPath, command, agentId: status.id })
}

function useAddable(): AgentStatus[] {
  const { useAgentsStore } = useHostScope()
  return useAgentsStore(useShallow((s) => addableHarnesses(s.order, s.byId)))
}

/** One agent in the list: its harness's mark, its name, its harness and account, its usage. */
export function AgentListItem({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const dot = useScopedDot(status)
  const hasOthers = useHasOtherAgents(status)
  const details = useAgentsStore((s) => s.details[status.id])
  const now = useNow()
  const r = readiness(status)
  const reading = useAgentReads(status)
  const account = status.account?.kind === 'none' ? null : status.account
  const limits = currentLimits(status.limits, now)
  const folder = details?.config.find((item) => item.id === 'folder')?.path
  // What it needs first; then what it is signed in with; else where it keeps its configuration.
  const summary: ReactNode =
    r.kind === 'missing' || r.kind === 'failed'
      ? r.message
      : r.kind === 'sign-in'
        ? t('agents.needsSignInLine')
        : account
          ? account.label
          : reading && status.capabilities.account
            ? t('agents.readingAccount')
            : (folder ?? null)
  const end: ReactNode =
    r.kind === 'sign-in' ? (
      <Pill tone="attention">{t('agents.signInPill')}</Pill>
    ) : limits.length > 0 ? (
      <ListMeter limits={limits} />
    ) : status.capabilities.reports ? (
      <span className="text-group text-tertiary">
        {t(reading ? 'agents.readingUsage' : 'agents.usageOnceRunning')}
      </span>
    ) : (
      <span className="text-group text-tertiary">{t('agents.noUsage')}</span>
    )
  return (
    <ItemRow
      item={status.id}
      label={status.name}
      onOpen={() => openAgentSettings(status.id)}
      tile={<AgentTile agent={status.id} size={30} glyph={16} dot={dot} />}
      name={
        <>
          <span className="truncate">{status.name}</span>
          {status.isDefault && hasOthers && <Pill>{t('agents.default')}</Pill>}
        </>
      }
      right={<span className="pointer-events-auto flex items-center">{end}</span>}
    >
      <ItemLine>
        {status.harnessName}
        {summary && ' · '}
        {summary}
      </ItemLine>
    </ItemRow>
  )
}

/** The list's own actions: add an agent, and hide the account details. */
export function AgentsGroupActions() {
  const { useSettingsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const hidden = useSettingsStore((s) => s.settings.privacy.hideAccount)
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              aria-pressed={hidden}
              onClick={() => apply({ privacy: { hideAccount: !hidden } })}
              className="h-7 gap-1.5 rounded-segment px-2 text-hint font-normal has-data-[icon=inline-start]:pl-2 text-secondary aria-pressed:text-primary [&_svg:not([class*='size-'])]:size-3.5"
            />
          }
        >
          {hidden ? <EyeOffIcon data-icon="inline-start" /> : <EyeIcon data-icon="inline-start" />}
          {t(hidden ? 'agents.showAccounts' : 'agents.hideAccounts')}
        </TooltipTrigger>
        <TooltipContent>{t('agents.hideAccountsHint')}</TooltipContent>
      </Tooltip>
    </>
  )
}

/** Adding stays discoverable before the first harness is installed. */
function AddAgentButton({
  className,
  row,
  primary = false,
}: {
  className?: string
  row?: boolean
  primary?: boolean
}) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const addable = useAddable()
  const add = (): void => {
    if (addable.length === 0) openHarnessSettings(null)
    else setOpen(true)
  }
  return (
    <>
      {row ? (
        <button
          type="button"
          onClick={add}
          className="group/add flex w-full items-center gap-3.5 rounded-lg py-3.25 text-left text-row text-secondary outline-none transition-colors duration-(--duration-fast) hover:text-primary focus-ring"
        >
          <span className="grid size-7.5 shrink-0 place-items-center rounded-xl shadow-[inset_0_0_0_var(--hairline)_var(--border-default)] transition-shadow duration-(--duration-fast) group-hover/add:shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)]">
            <PlusIcon className="size-3.75" />
          </span>
          {t('agents.add.button')}
        </button>
      ) : (
        <Button variant={primary ? 'default' : 'ghost'} className={className} onClick={add}>
          <PlusIcon data-icon="inline-start" />
          {t('agents.add.button')}
        </Button>
      )}
      <AddAgentDialog open={open} onOpenChange={setOpen} harnesses={addable} />
    </>
  )
}

/** The row at the list's end that adds an agent. */
export function AddAgentRow() {
  return <AddAgentButton row />
}

export function NoAgents() {
  const { t } = useTranslation('settings')
  const addable = useAddable()
  return (
    <Empty className="min-h-72">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <BotIcon />
        </EmptyMedia>
        <EmptyTitle>{t('agents.empty.title')}</EmptyTitle>
        <EmptyDescription>
          {t(addable.length > 0 ? 'agents.empty.installed' : 'agents.empty.description')}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <AddAgentButton primary />
        <Button variant="ghost" onClick={() => openHarnessSettings(null)}>
          {t('agents.empty.harnesses')}
        </Button>
      </EmptyContent>
    </Empty>
  )
}

/** Under the list: installation and registration are separate choices. */
export function AgentsFooter() {
  const { t } = useTranslation('settings')
  return (
    <p className="mt-2.5 text-hint text-tertiary">
      {t('agents.footerBefore')}
      <button
        type="button"
        onClick={() => openHarnessSettings(null)}
        className="rounded-sm outline-none hover:text-primary focus-ring"
      >
        {t('sections.harnesses')}
      </button>
      {t('agents.footerAfter')}
      <span className="block">{t('agents.registrationNote')}</span>
    </p>
  )
}

type Login = 'terminal' | 'api-key'

/**
 * Adding an agent: its harness, its name, its folder (a new one or an existing one picked in the
 * dialog), and how it signs in: in a terminal, or with an API key the harness keeps.
 */
function AddAgentDialog({
  open,
  onOpenChange,
  harnesses,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  harnesses: AgentStatus[]
}) {
  const { api, request, useAgentsStore, useSettingsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [harness, setHarness] = useState<HarnessId>(harnesses[0]?.harnessId ?? 'claude-code')
  const [name, setName] = useState('')
  const [folder, setFolder] = useState<'default' | 'new' | 'existing'>('default')
  const [picked, setPicked] = useState<string | null>(null)
  const [login, setLogin] = useState<Login>('terminal')
  const [key, setKey] = useState({ baseUrl: '', key: '', model: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = harnesses.find((h) => h.harnessId === harness) ?? harnesses[0]
  const canUseDefault = chosen?.registered === false
  const multiple = !!chosen && MULTI_AGENT_HARNESSES.includes(chosen.harnessId)
  const selectedFolder = folder === 'default' && !canUseDefault ? 'new' : folder
  const useDefault = selectedFolder === 'default'
  const trimmed = useDefault ? (chosen?.harnessName ?? '') : name.trim()
  const tooLong = [...trimmed].length > AGENT_NAME_CHARS
  const providers = chosen?.apiKey?.providers ?? false
  const valid =
    !!chosen &&
    trimmed.length > 0 &&
    !tooLong &&
    (useDefault || multiple) &&
    (selectedFolder !== 'existing' || picked !== null) &&
    (useDefault || login === 'terminal' || key.key.trim().length > 0)

  const reset = (): void => {
    setName('')
    setFolder('default')
    setPicked(null)
    setLogin('terminal')
    setKey({ baseUrl: '', key: '', model: '' })
    setError(null)
    setBusy(false)
  }

  const pick = async (): Promise<void> => {
    try {
      const path = await api.dialogs.chooseAgentFolder()
      if (path) {
        setPicked(path)
        setFolder('existing')
      }
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy || !chosen) return
    setBusy(true)
    setError(null)
    try {
      const id = useDefault
        ? chosen.harnessId
        : await api.settings.addAgent(
            chosen.harnessId,
            trimmed,
            selectedFolder === 'new' ? null : picked,
          )
      if (useDefault) {
        await useSettingsStore.getState().update({
          agents: { [chosen.harnessId]: { enabled: true, hidden: false } },
        })
      }
      await listed(useAgentsStore, id)
      if (!useDefault && login === 'api-key') {
        await request('agents.setApiKey', {
          agentId: id,
          key: key.key.trim(),
          ...(providers && key.baseUrl.trim() ? { baseUrl: key.baseUrl.trim() } : {}),
          ...(providers && key.model.trim() ? { model: key.model.trim() } : {}),
        })
      }
      onOpenChange(false)
      reset()
      openAgentSettings(id)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <SettingsDialogContent className="sm:max-w-135">
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <SettingsDialogHeader title={t('agents.add.title')}>
            {t('agents.add.description')}
          </SettingsDialogHeader>
          <SettingsDialogBody className="gap-4">
            <SettingsField label={t('agents.add.harness')}>
              <SettingSelect
                label={t('agents.add.harness')}
                className="w-full"
                value={chosen?.harnessId ?? harness}
                options={harnesses.map((h) => ({
                  value: h.harnessId,
                  label: h.harnessName,
                  icon: <AgentMark agent={h.harnessId} size={15} />,
                }))}
                onChange={(next) => {
                  setHarness(next)
                  setPicked(null)
                  setFolder('default')
                }}
              />
            </SettingsField>
            {!useDefault && (
              <SettingsField
                label={t('agents.add.name')}
                htmlFor="agent-name"
                hint={
                  tooLong && (
                    <span className="text-danger">
                      {t('agents.add.nameTooLong', { count: AGENT_NAME_CHARS })}
                    </span>
                  )
                }
              >
                <Input
                  id="agent-name"
                  value={name}
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t('agents.add.namePlaceholder')}
                  aria-invalid={tooLong || undefined}
                  className={DIALOG_FIELD}
                  onChange={(event) => setName(event.target.value)}
                />
              </SettingsField>
            )}
            <SettingsField label={t('agents.add.folder')}>
              <RadioGroup
                aria-label={t('agents.add.folder')}
                value={selectedFolder}
                onValueChange={(next) => setFolder(next as typeof folder)}
                className="gap-5"
              >
                {canUseDefault && (
                  <Choice
                    value="default"
                    checked={useDefault}
                    title={t('agents.add.folderDefault')}
                    description={t('agents.add.folderDefaultHint', {
                      name: chosen?.harnessName ?? '',
                    })}
                  />
                )}
                {multiple && (
                  <>
                    <Choice
                      value="new"
                      checked={selectedFolder === 'new'}
                      title={t('agents.add.folderNew')}
                      description={t('agents.add.folderNewHint')}
                    />
                    <Choice
                      value="existing"
                      checked={selectedFolder === 'existing'}
                      title={t('agents.add.folderExisting')}
                      description={t('agents.add.folderExistingHint')}
                      extra={
                        selectedFolder === 'existing' && (
                          <span className="flex min-w-0 items-center gap-2">
                            {picked && <PathText path={picked} />}
                            <Button
                              type="button"
                              variant="outline"
                              className={ROW_BUTTON}
                              onClick={() => void pick()}
                            >
                              <FolderIcon data-icon="inline-start" className="size-3.5" />
                              {t('agents.add.choose')}
                            </Button>
                          </span>
                        )
                      }
                    />
                  </>
                )}
              </RadioGroup>
            </SettingsField>
            {!useDefault && (
              <SettingsField label={t('agents.add.login')}>
                <RadioGroup
                  aria-label={t('agents.add.login')}
                  value={login}
                  onValueChange={(next) => setLogin(next as Login)}
                  className="gap-5"
                >
                  <Choice
                    value="terminal"
                    checked={login === 'terminal'}
                    title={t('agents.add.loginTerminal')}
                    description={t('agents.add.loginTerminalHint', {
                      name: chosen?.harnessName ?? '',
                    })}
                  />
                  <Choice
                    value="api-key"
                    checked={login === 'api-key'}
                    title={t('agents.add.loginKey')}
                    description={t(
                      providers ? 'agents.add.loginKeyHint' : 'agents.add.loginKeyHintOpenAi',
                    )}
                    extra={
                      login === 'api-key' &&
                      chosen && <ApiKeyFields status={chosen} value={key} onChange={setKey} />
                    }
                  />
                </RadioGroup>
              </SettingsField>
            )}
            {error && <p className="text-hint text-danger">{error}</p>}
          </SettingsDialogBody>
          <SettingsDialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" className={ROW_BUTTON} />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <Button type="submit" className={ROW_BUTTON} disabled={!valid || busy}>
              {busy && <Spinner data-icon="inline-start" />}
              {t('agents.add.submit')}
            </Button>
          </SettingsDialogFooter>
        </form>
      </SettingsDialogContent>
    </Dialog>
  )
}

/** One choice of a few as a tile, with what it does under it and anything it needs inside. */
function Choice({
  value,
  checked,
  title,
  description,
  extra,
}: {
  value: string
  checked: boolean
  title: string
  description: string
  extra?: ReactNode
}) {
  const id = useId()
  return (
    <div
      className={cn(
        'flex flex-col gap-2.5 rounded-2xl px-3 py-2.75 transition-[background-color,box-shadow] duration-(--duration-fast)',
        checked
          ? 'bg-subtle shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]'
          : 'shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)] hover:shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]',
      )}
    >
      <label htmlFor={id} className="flex items-start gap-2.5 text-left">
        <RadioGroupItem id={id} value={value} className="mt-0.5" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-lede leading-[normal] text-primary">{title}</span>
          <span className="text-hint text-tertiary">{description}</span>
        </span>
      </label>
      {extra && <div className="pl-6.5">{extra}</div>}
    </div>
  )
}

interface KeyValue {
  baseUrl: string
  key: string
  model: string
}

/** The provider's address, the key and the model; Codex takes only an OpenAI key. */
function ApiKeyFields({
  status,
  value,
  onChange,
}: {
  status: AgentStatus
  value: KeyValue
  onChange: (value: KeyValue) => void
}) {
  const { t } = useTranslation('settings')
  const providers = status.apiKey?.providers ?? false
  return (
    <div className="flex flex-col gap-2">
      <Input
        id="agent-key"
        type="password"
        value={value.key}
        autoComplete="off"
        spellCheck={false}
        aria-label={t('agents.key.key')}
        placeholder={t('agents.key.key')}
        className={DIALOG_MONO_FIELD}
        onChange={(event) => onChange({ ...value, key: event.target.value })}
      />
      {providers && (
        <>
          <Input
            id="agent-base-url"
            value={value.baseUrl}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('agents.key.baseUrl')}
            placeholder={t('agents.key.baseUrlOptional')}
            className={DIALOG_MONO_FIELD}
            onChange={(event) => onChange({ ...value, baseUrl: event.target.value })}
          />
          <Input
            id="agent-model"
            value={value.model}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('agents.key.model')}
            placeholder={t('agents.key.modelOptional')}
            className={DIALOG_MONO_FIELD}
            onChange={(event) => onChange({ ...value, model: event.target.value })}
          />
        </>
      )}
      <p className="text-hint text-tertiary">
        {t(providers ? 'agents.key.noteClaude' : 'agents.key.noteCodex', {
          command: status.cli?.command ?? '',
        })}
      </p>
    </div>
  )
}

/** An agent's own page: its account, API key, usage and configuration. */
export function AgentPage({ agentId }: { agentId: AgentId }) {
  const { useAgentsStore } = useHostScope()
  const status = useAgentsStore((s) => s.byId[agentId])
  if (!status) return <AgentPageHeader status={null} />
  return <AgentPageBody status={status} />
}

/** The page's header, without an agent once it is gone from the list. */
function AgentPageHeader({ status, actions }: { status: AgentStatus | null; actions?: ReactNode }) {
  const { t } = useTranslation('settings')
  const dot = useScopedDot(status ?? null)
  return (
    <ItemPageHeader
      back={t('sections.agents')}
      onBack={() => openAgentSettings(null)}
      item={status?.id ?? 'agent'}
      icon={status && <AgentTile agent={status.id} size={40} glyph={22} dot={dot} />}
      title={status?.name ?? null}
      subtitle={status && <AgentSubtitle status={status} />}
      actions={actions}
    >
      {status && <AgentPageLine status={status} />}
    </ItemPageHeader>
  )
}

/** Beside the mark: the harness and how the agent signs in, and renaming an added agent. */
function AgentSubtitle({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const hasOthers = useHasOtherAgents(status)
  const [renaming, setRenaming] = useState(false)
  const account = status.account?.kind === 'none' ? null : status.account
  return (
    <>
      {/* As tall as the rename button, whether or not it shows. */}
      <span className="truncate leading-6.5">
        {status.harnessName}
        {account && ` · ${account.label}`}
      </span>
      {status.isDefault ? (
        hasOthers && <Pill>{t('agents.default')}</Pill>
      ) : (
        <>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('agents.rename.button')}
            title={t('agents.rename.button')}
            className="size-6.5 rounded-segment text-tertiary"
            onClick={() => setRenaming(true)}
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <RenameDialog status={status} open={renaming} onOpenChange={setRenaming} />
        </>
      )}
    </>
  )
}

/** The line under it: the agent's state and the harness it runs on. */
function AgentPageLine({ status }: { status: AgentStatus }) {
  const { t } = useTranslation(['settings', 'agents'])
  const ready = readiness(status).kind === 'ready'
  const version = harnessVersion(status)
  const harness = t('agents.onHarness', {
    harness: version ? `${status.harnessName} ${version}` : status.harnessName,
  })
  return ready ? (
    <span className="flex min-h-4.5 min-w-0 items-center gap-1.5 leading-[normal]">
      <span aria-hidden className="size-1.75 shrink-0 rounded-full bg-success" />
      <span className="truncate">
        {t('agents:state.ready')} · {harness}
      </span>
    </span>
  ) : (
    <span className="flex min-h-4.5 min-w-0 items-center gap-1 leading-[normal]">
      <AgentStateLine status={status} className="text-hint leading-[normal]" />
      <span className="truncate">· {harness}</span>
    </span>
  )
}

function AgentPageBody({ status }: { status: AgentStatus }) {
  const { hostId, request } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [act, busy, error] = useAction()
  const r = readiness(status)
  const reading = useAgentReads(status)
  const running = status.state === 'ready'
  const terminalSignIn = status.authMethods.find((m) => m.type === 'terminal' && m.command)

  const actions = (
    <>
      {r.kind === 'failed' && (
        <Button
          className={ROW_BUTTON}

          variant="outline"
          disabled={busy}
          onClick={() => act(() => request('agents.retry', { agentId: status.id }))}
        >
          {busy ? <Spinner data-icon="inline-start" /> : <RotateCwIcon data-icon="inline-start" />}
          {t('common:actions.retry')}
        </Button>
      )}
    </>
  )

  return (
    <div className="flex flex-col">
      <AgentPageHeader status={status} actions={actions} />

      <div className="flex flex-col">
        {(r.kind === 'failed' || r.kind === 'missing') && (
          <p
            className={cn(
              'mt-4 text-group',
              r.kind === 'failed' ? 'text-danger' : 'text-secondary',
            )}
            data-selectable=""
          >
            {r.message}{' '}
            {r.kind === 'missing' && (
              <button
                type="button"
                onClick={() => openHarnessSettings(status.harnessId)}
                className="rounded-sm text-primary underline-offset-2 outline-none hover:underline focus-ring"
              >
                {t('agents.openHarness', { harness: status.harnessName })}
              </button>
            )}
          </p>
        )}
        {r.kind === 'sign-in' && status.authMethods.length > 0 && (
          <div className="mt-5">
            <SignInNotice
              status={status}
              busy={busy}
              {...(hostId === null && {
                onTerminal: (command: string) => signInTerminal(status, command),
              })}
              onAuthenticate={(methodId) =>
                act(() => request('agents.authenticate', { agentId: status.id, methodId }))
              }
            />
          </div>
        )}
        {error && <p className="mt-4 text-group text-danger">{error}</p>}

        <section className="flex flex-col">
          <GroupLabel group={{ id: 'account', label: t('agents.account') }} />
          <RowGroup>
            {/* A subscription's label is its plan; the other kinds name how the agent signs in. */}
            <Fact
              name={t(status.account?.kind === 'account' ? 'agents.plan' : 'agents.loginMethod')}
            >
              {status.account?.kind === 'none' ? null : status.account?.label}
            </Fact>
            {status.account?.email && (
              <Fact name={t('agents.email')}>
                <Masked>{status.account.email}</Masked>
              </Fact>
            )}
            {status.apiKey && <ApiKeyRow status={status} />}
            {((terminalSignIn && hostId === null) ||
              (status.canLogout && status.signIn === 'signed-in')) && (
              <RowFrame
                text={
                  <RowText name={t('agents.signInRow')} description={t('agents.signInRowHint')} />
                }
              >
                {status.canLogout && status.signIn === 'signed-in' && (
                  <Button
                    variant="ghost"
                    className={cn(ROW_BUTTON, 'text-secondary')}
                    disabled={busy}
                    onClick={() => act(() => request('agents.logout', { agentId: status.id }))}
                  >
                    {t('agents.signOut')}
                  </Button>
                )}
                {terminalSignIn?.command && hostId === null && (
                  <Button
                    className={ROW_BUTTON}

                    variant="outline"
                    onClick={() => signInTerminal(status, terminalSignIn.command!)}
                  >
                    <SquareTerminalIcon data-icon="inline-start" />
                    {t('agents.signInAgain')}
                  </Button>
                )}
              </RowFrame>
            )}
          </RowGroup>
        </section>

        {status.account?.kind === 'api_key' ? (
          <SpendGroup status={status} />
        ) : (
          <UsageGroup status={status} reading={reading} running={running} />
        )}

        <ConfigurationGroup status={status} />

        <DangerGroup status={status} />
      </div>
    </div>
  )
}

/** Whether Kettu handed the harness a key, and setting, replacing or clearing it. */
function ApiKeyRow({ status }: { status: AgentStatus }) {
  const { request } = useHostScope()
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const [act, busy, error] = useAction()
  const set = !!status.apiKey?.set
  return (
    <RowFrame
      text={
        <RowText
          name={t('agents.key.row')}
          description={
            set
              ? t('agents.key.set', { name: status.harnessName })
              : t(status.apiKey?.providers ? 'agents.key.notSet' : 'agents.key.notSetOpenAi')
          }
        />
      }
    >
      <ControlError error={error} />
      <Button className={ROW_BUTTON} variant="outline" onClick={() => setOpen(true)}>
        {t(set ? 'agents.key.replace' : 'agents.key.setButton')}
      </Button>
      {set && (
        <Button
          variant="ghost"
          className={GROUP_ACTION}
          disabled={busy}
          onClick={() => act(() => request('agents.clearApiKey', { agentId: status.id }))}
        >
          {t('agents.key.clear')}
        </Button>
      )}
      <ApiKeyDialog status={status} open={open} onOpenChange={setOpen} />
    </RowFrame>
  )
}

function ApiKeyDialog({
  status,
  open,
  onOpenChange,
}: {
  status: AgentStatus
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { request } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [value, setValue] = useState<KeyValue>({ baseUrl: '', key: '', model: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const providers = status.apiKey?.providers ?? false
  const close = (): void => {
    onOpenChange(false)
    setValue({ baseUrl: '', key: '', model: '' })
    setError(null)
    setBusy(false)
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!value.key.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await request('agents.setApiKey', {
        agentId: status.id,
        key: value.key.trim(),
        ...(providers && value.baseUrl.trim() ? { baseUrl: value.baseUrl.trim() } : {}),
        ...(providers && value.model.trim() ? { model: value.model.trim() } : {}),
      })
      close()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <SettingsDialogContent>
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <SettingsDialogHeader title={t('agents.key.title', { name: status.name })}>
            {status.isDefault &&
              t('agents.key.defaultWarning', {
                name: status.harnessName,
                command: status.cli?.command ?? '',
              })}
          </SettingsDialogHeader>
          <SettingsDialogBody>
            <ApiKeyFields status={status} value={value} onChange={setValue} />
            {error && <p className="text-hint text-danger">{error}</p>}
          </SettingsDialogBody>
          <SettingsDialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" className={ROW_BUTTON} />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <Button type="submit" className={ROW_BUTTON} disabled={!value.key.trim() || busy}>
              {busy && <Spinner data-icon="inline-start" />}
              {t('agents.key.save')}
            </Button>
          </SettingsDialogFooter>
        </form>
      </SettingsDialogContent>
    </Dialog>
  )
}

/** Where the agent reads its configuration, and the harness it runs on. */
function ConfigurationGroup({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const details = useAgentsStore((s) => s.details[status.id])
  const version = harnessVersion(status)
  return (
    <section className="flex flex-col">
      <GroupLabel group={{ id: 'configuration', label: t('agents.configuration') }} />
      <RowGroup>
        <RowFrame text={<RowText name={t('agents.harness')} />}>
          <span className="text-lede text-secondary">
            {version ? `${status.harnessName} ${version}` : status.harnessName}
          </span>
          <Button
            variant="ghost"
            className={GROUP_ACTION}
            onClick={() => openHarnessSettings(status.harnessId)}
          >
            {t('agents.openHarnessButton')}
          </Button>
        </RowFrame>
        {details?.config.map((item) => (
          <PlaceRow
            key={item.id}
            name={t(`agents.config.${item.id}`)}
            item={item}
            note={item.id === 'folder' && status.configDir?.created && t('agents.createdByKettu')}
          />
        ))}
        {details && details.config.length === 0 && (
          <RowShell>
            <p className="py-3.75 text-group text-tertiary">{t('agents.noConfig')}</p>
          </RowShell>
        )}
      </RowGroup>
    </section>
  )
}

/** Remove an agent; a default one simply stops being registered. */
function DangerGroup({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const [removing, setRemoving] = useState(false)
  return (
    <section className="flex flex-col pt-4">
      <RowGroup>
        {status.color && <ColorRow status={status} />}
        <RowFrame
          text={
            <RowText name={t('agents.remove.name')} description={t('agents.remove.description')} />
          }
        >
          <Button
            variant="destructive-outline"
            className={ROW_BUTTON}
            onClick={() => setRemoving(true)}
          >
            {t('agents.remove.buttonEllipsis')}
          </Button>
        </RowFrame>
      </RowGroup>
      <RemoveDialog status={status} open={removing} onOpenChange={setRemoving} />
    </section>
  )
}

/** The dot an added agent's mark carries, chosen from the palette. */
function ColorRow({ status }: { status: AgentStatus }) {
  const { api } = useHostScope()
  const { t } = useTranslation('settings')
  const color = useScopedDot(status)
  const [act, busy, error] = useAction()
  return (
    <RowFrame
      text={<RowText name={t('agents.color.name')} description={t('agents.color.description')} />}
    >
      <ControlError error={error} />
      <RadioGroup
        aria-label={t('agents.color.name')}
        value={color}
        disabled={busy}
        onValueChange={(next) => {
          if (isAgentColor(next)) act(() => api.settings.setAgentColor(status.id, next))
        }}
        className="flex w-auto gap-2.5"
      >
        {AGENT_COLORS.map((option) => (
          <RadioGroupItem
            key={option}
            value={option}
            aria-label={t(`agents.color.${option}`)}
            title={t(`agents.color.${option}`)}
            style={{ backgroundColor: `var(--agent-${option})` }}
            className="size-4.5 shadow-none data-checked:border-0 data-checked:shadow-[0_0_0_2px_var(--bg-surface),0_0_0_3.5px_var(--control-on)]"
          />
        ))}
      </RadioGroup>
    </RowFrame>
  )
}

/**
 * An added agent's dot as the scoped host's settings have it, so a choice shows at once. A host
 * from before colors reports none and has no dot to choose.
 */
function useScopedDot(status: AgentStatus | null): AgentColor | null {
  const { useSettingsStore } = useHostScope()
  const id = status?.color ? status.id : null
  return useSettingsStore((s) => (id ? agentColor(s.settings.addedAgents, id) : null))
}

function RemoveDialog({
  status,
  open,
  onOpenChange,
}: {
  status: AgentStatus
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { api } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const created = !!status.configDir?.created
  const [trash, setTrash] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await api.settings.removeAgent(status.id, created && trash)
      onOpenChange(false)
      openAgentSettings(null)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className={CONFIRM}>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('agents.remove.title', { name: status.name })}</AlertDialogTitle>
          <AlertDialogDescription>{t('agents.remove.body')}</AlertDialogDescription>
        </AlertDialogHeader>
        {created ? (
          <label className="flex items-start gap-2.5 rounded-code bg-subtle px-3 py-2.5 text-left">
            <Checkbox
              checked={trash}
              onCheckedChange={(value) => setTrash(value === true)}
              className="mt-0.5"
            />
            <span className="flex flex-col gap-px">
              <span className="text-ui font-medium text-primary">{t('agents.remove.trash')}</span>
              <span className="text-xs text-secondary">{t('agents.remove.trashHint')}</span>
            </span>
          </label>
        ) : status.isDefault ? (
          <p className="text-xs text-secondary">
            {t('agents.remove.keepsDefault', { name: status.harnessName })}
          </p>
        ) : (
          <p className="text-xs text-secondary">{t('agents.remove.keepsFolder')}</p>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>
            {t('agents.remove.button')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function RenameDialog({
  status,
  open,
  onOpenChange,
}: {
  status: AgentStatus
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { api } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [name, setName] = useState(status.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = name.trim()
  const tooLong = [...trimmed].length > AGENT_NAME_CHARS
  const valid = trimmed.length > 0 && !tooLong
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!valid || busy) return
    if (trimmed === status.name) return onOpenChange(false)
    setBusy(true)
    try {
      await api.settings.renameAgent(status.id, trimmed)
      onOpenChange(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setName(status.name)
        setError(null)
        onOpenChange(next)
      }}
    >
      <SettingsDialogContent className="sm:max-w-110">
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <SettingsDialogHeader title={t('agents.rename.title')} />
          <SettingsDialogBody>
            <SettingsField
              label={t('agents.add.name')}
              htmlFor="agent-rename"
              hint={
                (tooLong || error) && (
                  <span className="text-danger">
                    {tooLong ? t('agents.add.nameTooLong', { count: AGENT_NAME_CHARS }) : error}
                  </span>
                )
              }
            >
              <Input
                id="agent-rename"
                value={name}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                className={DIALOG_FIELD}
                aria-invalid={tooLong || error !== null || undefined}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => {
                  setName(event.target.value)
                  setError(null)
                }}
              />
            </SettingsField>
          </SettingsDialogBody>
          <SettingsDialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" className={ROW_BUTTON} />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <Button type="submit" className={ROW_BUTTON} disabled={!valid || busy}>
              {t('agents.rename.save')}
            </Button>
          </SettingsDialogFooter>
        </form>
      </SettingsDialogContent>
    </Dialog>
  )
}
