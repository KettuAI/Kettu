// Settings > Agents: the agents a user picks to work with, each a harness with a configuration
// folder and a name, with its account, sign-in, API key, usage and configuration. Installs and
// updates are Settings > Harnesses'.

import { useState, type FormEvent, type ReactNode } from 'react'
import {
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RotateCwIcon,
  SquareTerminalIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatus } from '@shared/agent-host'
import { AGENT_NAME_CHARS } from '@shared/settings'
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
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Checkbox } from '@renderer/components/ui/checkbox'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  useComboboxFilter,
} from '@renderer/components/ui/combobox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Field, FieldDescription, FieldError, FieldLabel } from '@renderer/components/ui/field'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { AgentStateLine } from '@renderer/features/agents/agent-state'
import { readiness } from '@renderer/features/agents/readiness'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import {
  hasProgram,
  isInstalled,
  usableAgents,
  type AgentsStoreHook,
} from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { useProjectsStore } from '@renderer/stores/projects'
import {
  closeSettings,
  openAgentSettings,
  openHarnessSettings,
  toggleTerminal,
  useViewStore,
} from '@renderer/stores/view'
import { ConfigFrame, ConfigRow, Fact, SignInNotice, UsageGroup, UsageMeters } from './agent-parts'
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
  GROUP_ACTION,
  Masked,
  PathText,
  Segmented,
  SettingSwitch,
} from './controls'
import { ConfigNote, ConfigPath } from './places'
import { GroupLabel, ItemPageHeader, ItemRow, RowFrame, RowGroup, RowShell, RowText } from './rows'
import { useApply } from './use-apply'

/** How long the dialog waits for the host to list an agent it just added, before giving up. */
const ADDED_WAIT_MS = 10_000

/** Resolves once the host lists the agent, which follows the settings change that added it. */
function listed(agents: AgentsStoreHook, agentId: AgentId): Promise<void> {
  return new Promise((resolve, reject) => {
    if (agents.getState().byId[agentId]) return resolve()
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`${agentId} did not appear`))
    }, ADDED_WAIT_MS)
    const stop = agents.subscribe((state) => {
      if (!state.byId[agentId]) return
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

/** The harnesses agents can be added to, that are installed. */
function useAddable(): AgentStatus[] {
  const { useAgentsStore } = useHostScope()
  return useAgentsStore(
    useShallow((s) =>
      MULTI_AGENT_HARNESSES.flatMap((id) => {
        const status = s.byId[id]
        return status && isInstalled(status) ? [status] : []
      }),
    ),
  )
}

/** One agent in the list: its harness's mark, its name, who it is signed in as, its usage. */
export function AgentListItem({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const hasOthers = useHasOtherAgents(status)
  const details = useAgentsStore((s) => s.details[status.id])
  const now = useNow()
  const r = readiness(status)
  const reading = useAgentReads(status)
  const account = status.account?.kind === 'none' ? null : status.account
  const limits = currentLimits(status.limits, now)
  const folder = details?.config.find((item) => item.id === 'folder')?.path
  // What it needs first; then who it is signed in as; else where it keeps its configuration.
  const summary: ReactNode =
    r.kind === 'missing' || r.kind === 'failed' ? (
      r.message
    ) : r.kind === 'sign-in' ? (
      t('agents.needsSignIn', { name: status.name })
    ) : account ? (
      <>
        {account.label}
        {account.email && (
          <>
            {' · '}
            <span className="text-primary">
              <Masked>{account.email}</Masked>
            </span>
          </>
        )}
      </>
    ) : reading && status.capabilities.account ? (
      t('agents.readingAccount')
    ) : folder ? (
      <PathText path={folder} />
    ) : null
  const usage =
    limits.length > 0 ? (
      <UsageMeters limits={limits} />
    ) : status.capabilities.reports ? (
      <span className="text-xs text-tertiary">
        {t(reading ? 'agents.readingUsage' : 'agents.usageOnceRunning')}
      </span>
    ) : (
      <span className="text-xs text-tertiary">{t('agents.noUsage')}</span>
    )
  return (
    <ItemRow
      item={status.id}
      label={status.name}
      onOpen={() => openAgentSettings(status.id)}
      tile={<AgentTile agent={status.id} size={30} glyph={16} />}
      name={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{status.name}</span>
          {!status.isDefault && (
            <span className="shrink-0 text-xs font-normal text-tertiary">{status.harnessName}</span>
          )}
          {status.isDefault && hasOthers && (
            <Badge variant="secondary">{t('agents.default')}</Badge>
          )}
          {status.hidden && <Badge variant="outline">{t('agents.hiddenTag')}</Badge>}
        </span>
      }
      right={
        <span className="pointer-events-auto flex">
          <AgentStateLine status={status} className="text-command" />
        </span>
      }
    >
      {summary && (
        <span className="flex min-h-4.5 min-w-0 items-center text-command leading-4.5 text-secondary">
          <span className="min-w-0 truncate">{summary}</span>
        </span>
      )}
      <div className="mt-1.25 flex flex-wrap gap-x-5.5 gap-y-1">{usage}</div>
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
      <AddAgentButton className={GROUP_ACTION} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="quiet"
              size="sm"
              aria-pressed={hidden}
              onClick={() => apply({ privacy: { hideAccount: !hidden } })}
              className={cn(
                GROUP_ACTION,
                'aria-pressed:bg-transparent aria-pressed:text-primary aria-pressed:shadow-none aria-pressed:hover:bg-hover',
              )}
            />
          }
        >
          {hidden ? <EyeIcon data-icon="inline-start" /> : <EyeOffIcon data-icon="inline-start" />}
          {t(hidden ? 'agents.showAccounts' : 'agents.hideAccounts')}
        </TooltipTrigger>
        <TooltipContent>{t('agents.hideAccountsHint')}</TooltipContent>
      </Tooltip>
    </>
  )
}

/** Add agent, which opens its dialog; hidden while no installed harness can carry another. */
function AddAgentButton({ className, row }: { className?: string; row?: boolean }) {
  const { t } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  const addable = useAddable()
  if (addable.length === 0) return null
  return (
    <>
      {row ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="-mx-3 flex w-[calc(100%+1.5rem)] items-center gap-3 rounded-[inherit] py-3 pr-3 pl-4 text-left text-ui text-secondary outline-none transition-colors duration-(--duration-fast) hover:bg-hover hover:text-primary focus-visible:shadow-[inset_0_0_0_2px_var(--focus)]"
        >
          <span className="grid size-7.5 shrink-0 place-items-center rounded-lg border border-dashed border-strong">
            <PlusIcon className="size-4" />
          </span>
          {t('agents.add.button')}
        </button>
      ) : (
        <Button variant="quiet" size="sm" className={className} onClick={() => setOpen(true)}>
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

/** Under the list: other programs are installed in Settings > Harnesses. */
export function AgentsFooter() {
  const { t } = useTranslation('settings')
  return (
    <p className="mt-3.5 px-1 text-command text-tertiary">
      {t('agents.footerBefore')}
      <button
        type="button"
        onClick={() => openHarnessSettings(null)}
        className="rounded-sm text-secondary underline-offset-2 outline-none hover:text-primary hover:underline focus-ring"
      >
        {t('sections.harnesses')}
      </button>
      {t('agents.footerAfter')}
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
  const { api, request, useAgentsStore } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const [harness, setHarness] = useState<HarnessId>(harnesses[0]?.harnessId ?? 'claude-code')
  const [name, setName] = useState('')
  const [folder, setFolder] = useState<'new' | 'existing'>('new')
  const [picked, setPicked] = useState<string | null>(null)
  const [login, setLogin] = useState<Login>('terminal')
  const [key, setKey] = useState({ baseUrl: '', key: '', model: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = harnesses.find((h) => h.harnessId === harness) ?? harnesses[0]
  const trimmed = name.trim()
  const tooLong = [...trimmed].length > AGENT_NAME_CHARS
  const providers = chosen?.apiKey?.providers ?? false
  const valid =
    trimmed.length > 0 &&
    !tooLong &&
    (folder === 'new' || picked !== null) &&
    (login === 'terminal' || key.key.trim().length > 0)

  const reset = (): void => {
    setName('')
    setFolder('new')
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
      const id = await api.settings.addAgent(
        chosen.harnessId,
        trimmed,
        folder === 'new' ? null : picked,
      )
      await listed(useAgentsStore, id)
      if (login === 'api-key') {
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
      <DialogContent className="sm:max-w-lg">
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{t('agents.add.title')}</DialogTitle>
            <DialogDescription>{t('agents.add.description')}</DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 flex-col gap-4">
            <Field>
              <FieldLabel>{t('agents.add.harness')}</FieldLabel>
              <div>
                <Segmented
                  label={t('agents.add.harness')}
                  value={chosen?.harnessId ?? harness}
                  options={harnesses.map((h) => ({ value: h.harnessId, label: h.harnessName }))}
                  onChange={(next) => {
                    setHarness(next)
                    setPicked(null)
                    setFolder('new')
                  }}
                />
              </div>
              <FieldDescription>{t('agents.add.harnessHint')}</FieldDescription>
            </Field>
            <Field data-invalid={tooLong || undefined}>
              <FieldLabel htmlFor="agent-name">{t('agents.add.name')}</FieldLabel>
              <Input
                id="agent-name"
                value={name}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                placeholder={t('agents.add.namePlaceholder')}
                aria-invalid={tooLong || undefined}
                onChange={(event) => setName(event.target.value)}
              />
              {tooLong && (
                <FieldError>{t('agents.add.nameTooLong', { count: AGENT_NAME_CHARS })}</FieldError>
              )}
            </Field>
            <Field>
              <FieldLabel>{t('agents.add.folder')}</FieldLabel>
              <Choice
                checked={folder === 'new'}
                onSelect={() => setFolder('new')}
                title={t('agents.add.folderNew')}
                description={t('agents.add.folderNewHint')}
              />
              <Choice
                checked={folder === 'existing'}
                onSelect={() => (picked ? setFolder('existing') : void pick())}
                title={t('agents.add.folderExisting')}
                description={t('agents.add.folderExistingHint', {
                  variable: chosen?.harnessId === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR',
                })}
                extra={
                  <span className="flex min-w-0 items-center gap-2">
                    {picked && <PathText path={picked} />}
                    <Button type="button" variant="outline" size="xs" onClick={() => void pick()}>
                      <FolderIcon data-icon="inline-start" />
                      {t('agents.add.choose')}
                    </Button>
                  </span>
                }
              />
            </Field>
            <Field>
              <FieldLabel>{t('agents.add.login')}</FieldLabel>
              <Choice
                checked={login === 'terminal'}
                onSelect={() => setLogin('terminal')}
                title={t('agents.add.loginTerminal')}
                description={t('agents.add.loginTerminalHint')}
              />
              <Choice
                checked={login === 'api-key'}
                onSelect={() => setLogin('api-key')}
                title={t('agents.add.loginKey')}
                description={t(
                  providers ? 'agents.add.loginKeyHint' : 'agents.add.loginKeyHintOpenAi',
                )}
              />
              {login === 'api-key' && chosen && (
                <ApiKeyFields status={chosen} value={key} onChange={setKey} />
              )}
            </Field>
            {error && <p className="text-xs text-danger">{error}</p>}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <Button type="submit" disabled={!valid || busy}>
              {busy && <Spinner data-icon="inline-start" />}
              {t('agents.add.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** One choice of a few, with what it does under it and anything it needs beside it. */
function Choice({
  checked,
  onSelect,
  title,
  description,
  extra,
}: {
  checked: boolean
  onSelect: () => void
  title: string
  description: string
  extra?: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1.5 rounded-lg px-2.5 py-2 transition-colors duration-(--duration-fast)',
        checked ? 'bg-selected' : 'hover:bg-hover',
      )}
    >
      <button
        type="button"
        role="radio"
        aria-checked={checked}
        onClick={onSelect}
        className="flex items-start gap-2.5 rounded-sm text-left outline-none focus-ring"
      >
        <span
          aria-hidden
          className={cn(
            'mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border',
            checked ? 'border-primary' : 'border-strong',
          )}
        >
          {checked && <span className="size-1.75 rounded-full bg-primary" />}
        </span>
        <span className="flex min-w-0 flex-col gap-px">
          <span className="text-ui font-medium text-primary">{title}</span>
          <span className="text-xs text-secondary">{description}</span>
        </span>
      </button>
      {extra && <div className="pl-6">{extra}</div>}
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
    <div className="flex flex-col gap-3 rounded-lg bg-subtle px-3 py-3">
      {providers && (
        <Field>
          <FieldLabel htmlFor="agent-base-url">{t('agents.key.baseUrl')}</FieldLabel>
          <Input
            id="agent-base-url"
            value={value.baseUrl}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder="https://api.anthropic.com"
            onChange={(event) => onChange({ ...value, baseUrl: event.target.value })}
          />
          <FieldDescription>{t('agents.key.baseUrlHint')}</FieldDescription>
        </Field>
      )}
      <Field>
        <FieldLabel htmlFor="agent-key">{t('agents.key.key')}</FieldLabel>
        <Input
          id="agent-key"
          type="password"
          value={value.key}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          onChange={(event) => onChange({ ...value, key: event.target.value })}
        />
      </Field>
      {providers && (
        <Field>
          <FieldLabel htmlFor="agent-model">{t('agents.key.model')}</FieldLabel>
          <Input
            id="agent-model"
            value={value.model}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder={t('agents.key.modelPlaceholder', { name: status.harnessName })}
            onChange={(event) => onChange({ ...value, model: event.target.value })}
          />
        </Field>
      )}
      <p className="text-xs text-tertiary">
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
  return (
    <ItemPageHeader
      back={t('sections.agents')}
      onBack={() => openAgentSettings(null)}
      item={status?.id ?? 'agent'}
      icon={status && <AgentMark agent={status.id} size={22} />}
      title={status ? <AgentTitle status={status} /> : null}
      actions={actions}
    >
      {status && <AgentPageLine status={status} />}
    </ItemPageHeader>
  )
}

/** The agent's name, which an added agent can change, and whether it is the default one. */
function AgentTitle({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const hasOthers = useHasOtherAgents(status)
  const [renaming, setRenaming] = useState(false)
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <AgentPicker status={status} />
      {status.isDefault ? (
        hasOthers && (
          <Badge variant="secondary" className="font-sans">
            {t('agents.default')}
          </Badge>
        )
      ) : (
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={t('agents.rename.button')}
          title={t('agents.rename.button')}
          className="text-tertiary"
          onClick={() => setRenaming(true)}
        >
          <PencilIcon />
        </Button>
      )}
      {!status.isDefault && (
        <RenameDialog status={status} open={renaming} onOpenChange={setRenaming} />
      )}
    </span>
  )
}

/** The line under an agent's title: its state and its harness. */
function AgentPageLine({ status }: { status: AgentStatus }) {
  const { t } = useTranslation(['settings', 'agents'])
  const ready = readiness(status).kind === 'ready'
  return (
    <p className="flex min-w-0 items-center gap-1.75 text-command leading-4.5 text-tertiary">
      {ready ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-secondary">
          <span aria-hidden className="size-1.5 rounded-full bg-success" />
          {t('agents:state.ready')}
        </span>
      ) : (
        <AgentStateLine status={status} className="text-command" />
      )}
      <span aria-hidden>·</span>
      <span className="truncate">{t('agents.onHarness', { harness: status.harnessName })}</span>
    </p>
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
          size="sm"
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

      <div className="flex flex-col gap-7">
        {(r.kind === 'failed' || r.kind === 'missing') && (
          <p
            className={cn(
              '-mt-4 px-1 text-xs',
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
        )}
        {error && <p className="-mt-4 px-1 text-xs text-danger">{error}</p>}

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
                    size="sm"
                    variant="quiet"
                    className="text-secondary"
                    disabled={busy}
                    onClick={() => act(() => request('agents.logout', { agentId: status.id }))}
                  >
                    {t('agents.signOut')}
                  </Button>
                )}
                {terminalSignIn?.command && hostId === null && (
                  <Button
                    size="sm"
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

        <UsageGroup status={status} reading={reading} running={running} />

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
      {set && (
        <Button
          size="sm"
          variant="quiet"
          className="text-secondary"
          disabled={busy}
          onClick={() => act(() => request('agents.clearApiKey', { agentId: status.id }))}
        >
          {t('agents.key.clear')}
        </Button>
      )}
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <KeyRoundIcon data-icon="inline-start" />
        {t(set ? 'agents.key.replace' : 'agents.key.setButton')}
      </Button>
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
      <DialogContent className="sm:max-w-md">
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{t('agents.key.title', { name: status.name })}</DialogTitle>
            {status.isDefault && (
              <DialogDescription>
                {t('agents.key.defaultWarning', {
                  name: status.harnessName,
                  command: status.cli?.command ?? '',
                })}
              </DialogDescription>
            )}
          </DialogHeader>
          <ApiKeyFields status={status} value={value} onChange={setValue} />
          {error && <p className="text-xs text-danger">{error}</p>}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <Button type="submit" disabled={!value.key.trim() || busy}>
              {busy && <Spinner data-icon="inline-start" />}
              {t('agents.key.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
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
        <RowFrame
          text={
            <RowText
              name={t('agents.harness')}
              description={
                <span className="flex items-center gap-1.5">
                  <AgentMark agent={status.harnessId} size={12} />
                  {status.harnessName}
                  {version && <span className="font-mono text-tertiary">{version}</span>}
                </span>
              }
            />
          }
        >
          <Button size="sm" variant="outline" onClick={() => openHarnessSettings(status.harnessId)}>
            {t('agents.openHarnessButton')}
          </Button>
        </RowFrame>
        {details?.config.map((item) =>
          item.id === 'folder' ? (
            <ConfigFrame
              key={item.id}
              name={t('agents.config.folder')}
              description={t(
                status.configDir?.created
                  ? 'agents.folderCreated'
                  : status.isDefault
                    ? 'agents.folderDefault'
                    : 'agents.folderOwn',
                { name: status.harnessName },
              )}
            >
              <ConfigPath item={item} />
              {/* An added agent's line already says whose folder it is. */}
              {status.isDefault && <ConfigNote item={item} />}
            </ConfigFrame>
          ) : (
            <ConfigRow key={item.id} item={item} status={status} />
          ),
        )}
        {details && details.config.length === 0 && (
          <RowShell>
            <p className="py-3 text-xs text-secondary">{t('agents.noConfig')}</p>
          </RowShell>
        )}
      </RowGroup>
    </section>
  )
}

/** Delete an added agent; a default agent is only hidden from the agent menu. */
function DangerGroup({ status }: { status: AgentStatus }) {
  const { t } = useTranslation('settings')
  const [apply, error] = useApply()
  const [removing, setRemoving] = useState(false)
  if (status.isDefault) {
    return (
      <section className="flex flex-col">
        <RowGroup>
          <RowFrame
            text={
              <RowText
                name={t('agents.hide.name')}
                description={t('agents.hide.description', { name: status.harnessName })}
              />
            }
          >
            <ControlError error={error} />
            <SettingSwitch
              label={t('agents.hide.name')}
              checked={status.hidden}
              onChange={(hidden) => apply({ agents: { [status.harnessId]: { hidden } } })}
            />
          </RowFrame>
        </RowGroup>
      </section>
    )
  }
  return (
    <section className="flex flex-col">
      <RowGroup>
        <RowFrame
          text={
            <RowText name={t('agents.remove.name')} description={t('agents.remove.description')} />
          }
        >
          <Button size="sm" variant="destructive" onClick={() => setRemoving(true)}>
            {t('agents.remove.button')}
          </Button>
        </RowFrame>
      </RowGroup>
      <RemoveDialog status={status} open={removing} onOpenChange={setRemoving} />
    </section>
  )
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
      <DialogContent className="sm:max-w-md">
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>{t('agents.rename.title')}</DialogTitle>
          </DialogHeader>
          <Field data-invalid={tooLong || error !== null || undefined}>
            <FieldLabel htmlFor="agent-rename" className="sr-only">
              {t('agents.add.name')}
            </FieldLabel>
            <Input
              id="agent-rename"
              value={name}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              aria-invalid={tooLong || error !== null || undefined}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
            />
            {tooLong && (
              <FieldError>{t('agents.add.nameTooLong', { count: AGENT_NAME_CHARS })}</FieldError>
            )}
            {error && <FieldError>{error}</FieldError>}
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <Button type="submit" disabled={!valid || busy}>
              {t('agents.rename.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** The agent's name as the page's title, opening a searchable list of the agents. */
function AgentPicker({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId).filter(hasProgram)))
  const { contains } = useComboboxFilter()
  const name = (id: AgentId) => agents.find((a) => a.id === id)?.name ?? id
  return (
    <Combobox
      items={agents.map((a) => a.id)}
      value={status.id}
      onValueChange={(id: AgentId | null) => {
        if (id) openAgentSettings(id)
      }}
      itemToStringLabel={name}
      filter={(id: AgentId, query: string) => contains(name(id), query)}
    >
      <ComboboxTrigger className="-mx-1.5 flex min-w-0 items-center gap-1.25 rounded-lg pr-1.25 pl-1.5 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring data-popup-open:bg-hover [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:transition-transform [&>svg]:duration-(--duration-base) data-popup-open:[&>svg]:rotate-180">
        <span className="truncate">{status.name}</span>
      </ComboboxTrigger>
      <ComboboxContent className="w-72">
        <ComboboxInput
          showTrigger={false}
          placeholder={t('agents.search')}
          aria-label={t('agents.search')}
          spellCheck={false}
        />
        <ComboboxEmpty>{t('agents.noMatch')}</ComboboxEmpty>
        <ComboboxList>
          {(id: AgentId) => {
            const agent = agents.find((a) => a.id === id)
            return (
              agent && (
                <ComboboxItem key={id} value={id}>
                  <AgentMark agent={id} size={14} />
                  <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                  <AgentStateLine status={agent} className="shrink-0 text-tertiary" />
                </ComboboxItem>
              )
            )
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}
