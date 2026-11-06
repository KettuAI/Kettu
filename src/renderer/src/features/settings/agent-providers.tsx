// Settings > Agents: OpenCode's provider accounts, their plan usage and balances. An agent whose
// host does not read providers keeps the account group instead.

import { useId, useMemo, useState, type FormEvent } from 'react'
import {
  CircleAlertIcon,
  CopyIcon,
  KeyRoundIcon,
  PlusIcon,
  RotateCwIcon,
  SearchIcon,
  SquareTerminalIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentProvider, AgentStatus, ProviderBalance } from '@shared/agent-host'
import { CommandLine } from '@renderer/components/command-line'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@renderer/components/ui/input-group'
import { Button } from '@renderer/components/ui/button'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { currentLocale } from '@renderer/lib/i18n'
import { mediumAgo, money } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useHostScope } from '@renderer/stores/host-scope'
import { UsageGroup } from './agent-parts'
import { useAction } from './agent-helpers'
import { ControlError, GROUP_ACTION, IconAction, Pill, ROW_BUTTON } from './controls'
import {
  activeProviderAccount,
  connectedProviders,
  filterProviders,
  providerKeyAction,
  type ProviderAccount,
} from './provider-accounts'
import { GroupLabel, Notice, RowFrame, RowGroup, RowShell, RowText } from './rows'
import {
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
} from './settings-dialog'

type MethodType = AgentProvider['methods'][number]['type']

const METHOD_KEY = {
  key: 'agents.providers.methods.key',
  oauth: 'agents.providers.methods.oauth',
  command: 'agents.providers.methods.command',
  external: 'agents.providers.methods.external',
  env: 'agents.providers.methods.env',
} as const satisfies Record<MethodType, string>

/** A balance in its currency, or as the amount and the currency code when it has no symbol. */
function balanceText(balance: ProviderBalance): string {
  try {
    return money(balance.amount, balance.currency)
  } catch {
    return `${balance.amount.toLocaleString(currentLocale())} ${balance.currency}`.trim()
  }
}

/** The providers group, its usage meters and the balances beneath them. */
export function AgentProviders({
  status,
  reading,
  running,
  onSignIn,
}: {
  status: AgentStatus
  reading: boolean
  running: boolean
  /** Runs a sign-in command in the built-in terminal of this computer. */
  onSignIn: (command: string) => void
}) {
  const { hostId, request } = useHostScope()
  const { t } = useTranslation('settings')
  const [act, busy, error] = useAction()
  const [pending, setPending] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [keyTarget, setKeyTarget] = useState<AgentProvider | null>(null)
  const providers = status.providers ?? []
  const connected = connectedProviders(providers)
  const connectedCount = connected.length
  const remote = hostId !== null
  const providersError = status.providersError ?? null

  if (status.providers === undefined) return null

  const retry = (): void => {
    act(() => request('agents.refreshAccount', { agentId: status.id, force: true }))
  }

  // The agents' native calls can take a while; the row that started one keeps its spinner.
  const run = (key: string, call: () => Promise<unknown>): void => {
    setPending(key)
    act(() => call().finally(() => setPending(null)))
  }

  const signIn = (command: string): void => {
    if (remote) return
    onSignIn(command)
  }

  return (
    <>
      <section className="flex flex-col">
        <GroupLabel
          group={{
            id: 'providers',
            label: t('agents.providers.group'),
            ...(connectedCount > 0 && { count: connectedCount }),
            actions: (
              <>
                <Button variant="ghost" className={GROUP_ACTION} onClick={() => setAddOpen(true)}>
                  <PlusIcon data-icon="inline-start" />
                  {t('agents.providers.add')}
                </Button>
                <IconAction
                  label={t('agents.providers.refresh')}
                  disabled={busy}
                  busy={busy}
                  onClick={retry}
                >
                  {busy ? <Spinner className="size-3.5" /> : <RotateCwIcon />}
                </IconAction>
              </>
            ),
          }}
        />
        {providersError && (
          <Notice
            variant="error"
            icon={<CircleAlertIcon />}
            title={t('agents.providers.readFailed')}
            action={
              <Button variant="outline" className={ROW_BUTTON} disabled={busy} onClick={retry}>
                {busy && <Spinner data-icon="inline-start" />}
                {t('agents.providers.retry')}
              </Button>
            }
          >
            {providersError}
          </Notice>
        )}
        {connectedCount === 0 && !providersError ? (
          <p className="py-1 text-group text-tertiary">
            {reading && providers.every((provider) => provider.accounts.length === 0) ? (
              <span className="flex items-center gap-2">
                <Spinner className="size-3.5" />
                {t('agents.providers.reading')}
              </span>
            ) : (
              t(providers.length === 0 ? 'agents.providers.noneReported' : 'agents.providers.none')
            )}
          </p>
        ) : (
          <RowGroup>
            {connected.map((provider) => (
              <ProviderRow
                key={provider.id}
                status={status}
                provider={provider}
                remote={remote}
                busy={busy}
                pending={pending}
                run={run}
                onSignIn={signIn}
                onSetKey={() => setKeyTarget(provider)}
              />
            ))}
          </RowGroup>
        )}
        {error && (
          <p role="alert" className="pt-2 text-hint text-danger">
            {error}
          </p>
        )}
      </section>

      {connectedCount > 0 && (
        <ProviderUsage status={status} providers={connected} reading={reading} running={running} />
      )}
      <ProviderBalances providers={connected} />

      <AddProviderDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        providers={providers}
        remote={remote}
        onSignIn={(command) => {
          setAddOpen(false)
          signIn(command)
        }}
        onSetKey={(provider) => {
          setAddOpen(false)
          setKeyTarget(provider)
        }}
      />

      <ProviderKeyDialog
        status={status}
        target={keyTarget}
        onOpenChange={(open) => {
          if (!open) setKeyTarget(null)
        }}
      />
    </>
  )
}

function ProviderRow({
  status,
  provider,
  remote,
  busy,
  pending,
  run,
  onSignIn,
  onSetKey,
}: {
  status: AgentStatus
  provider: AgentProvider
  remote: boolean
  busy: boolean
  pending: string | null
  run: (key: string, call: () => Promise<unknown>) => void
  onSignIn: (command: string) => void
  onSetKey: () => void
}) {
  const { request } = useHostScope()
  const { t } = useTranslation('settings')
  const active = activeProviderAccount(provider)
  const keyMethod = provider.methods.some((method) => method.type === 'key')
  const methods = provider.methods.map((method) => t(METHOD_KEY[method.type])).join(' · ')
  const action = (action: 'logout' | 'activate', credentialId: string | null) =>
    request('agents.providerAction', {
      agentId: status.id,
      providerId: provider.id,
      action,
      ...(credentialId !== null && { credentialId }),
    })
  return (
    <RowShell>
      <div className="flex flex-col gap-2 py-3.75">
        <div className="flex min-h-7 min-w-0 flex-wrap items-center gap-2.5">
          <div className="flex min-w-30 flex-1 flex-col gap-1">
            <span
              className="truncate text-label leading-[normal] font-medium"
              title={provider.name}
            >
              {provider.name}
            </span>
            {methods && (
              <span className="truncate text-hint text-tertiary" title={methods}>
                {methods}
              </span>
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {provider.loginCommand && !remote && (
              <Button
                variant="outline"
                className={ROW_BUTTON}
                disabled={busy}
                onClick={() => onSignIn(provider.loginCommand)}
              >
                <SquareTerminalIcon data-icon="inline-start" />
                {t(
                  provider.accounts.length > 0
                    ? 'agents.providers.again'
                    : 'agents.providers.signIn',
                )}
              </Button>
            )}
            {keyMethod && (
              <Button
                variant="outline"
                className={ROW_BUTTON}
                disabled={busy}
                onClick={() => onSetKey()}
              >
                <KeyRoundIcon data-icon="inline-start" />
                {t('agents.providers.setKey')}
              </Button>
            )}
          </div>
        </div>
        {provider.accounts.length === 0 ? (
          <p className="text-group text-tertiary">{t('agents.providers.notConnected')}</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {provider.accounts.map((account, index) => {
              const typed = account as ProviderAccount
              const isActive = active === typed
              // Only a real credential can be activated or removed; an env entry has no id.
              const canPick = typed.id !== null
              const accountKey = typed.id ?? index
              const activateKey = `${provider.id}:activate:${accountKey}`
              const logoutKey = `${provider.id}:logout:${accountKey}`
              return (
                <div
                  key={typed.id ?? `${provider.id}-${index}`}
                  className="flex min-h-7 min-w-0 items-center gap-2"
                >
                  <span className="truncate text-lede leading-[normal] text-secondary">
                    {typed.label || t('agents.providers.connected')}
                  </span>
                  <span className="text-hint text-tertiary">{t(METHOD_KEY[typed.method])}</span>
                  {isActive && <Pill tone="success">{t('agents.providers.active')}</Pill>}
                  {typed.needsAuth && (
                    <Pill tone="attention">{t('agents.providers.needsSignIn')}</Pill>
                  )}
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {!isActive && canPick && (
                      <Button
                        variant="outline"
                        className={ROW_BUTTON}
                        disabled={busy}
                        onClick={() => run(activateKey, () => action('activate', typed.id))}
                      >
                        {pending === activateKey && <Spinner data-icon="inline-start" />}
                        {t('agents.providers.use')}
                      </Button>
                    )}
                    {canPick && (
                      <Button
                        variant="ghost"
                        className={GROUP_ACTION}
                        disabled={busy}
                        onClick={() => run(logoutKey, () => action('logout', typed.id))}
                      >
                        {pending === logoutKey && <Spinner data-icon="inline-start" />}
                        {t('agents.providers.logOut')}
                      </Button>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        )}
        {(remote || provider.accounts.length === 0) && provider.loginCommand && (
          <CommandLine command={provider.loginCommand} label={t('agents.providers.command')} />
        )}
      </div>
    </RowShell>
  )
}

/** One provider's line when its usage is not a set of meters: reading, unsupported or failed. */
function ProviderUsage({
  status,
  providers,
  reading,
  running,
}: {
  status: AgentStatus
  providers: readonly AgentProvider[]
  reading: boolean
  running: boolean
}) {
  const { t } = useTranslation('settings')
  if (status.limits.length > 0) {
    return (
      <>
        <UsageGroup status={status} reading={reading} running={running} />
        <ProviderUsageNotes providers={providers} reading={reading} />
      </>
    )
  }
  return (
    <section className="flex flex-col">
      <GroupLabel group={{ id: 'provider-usage', label: t('agents.usage') }} />
      <RowGroup>
        {providers.map((provider) => {
          const usage = provider.usage
          const state =
            usage === null
              ? reading
                ? 'agents.providers.usage.reading'
                : 'agents.providers.usage.unknown'
              : usage.state === 'unsupported'
                ? 'agents.providers.usage.unsupported'
                : usage.state === 'error'
                  ? 'agents.providers.usage.failed'
                  : 'agents.providers.usage.none'
          const message =
            usage?.state === 'error'
              ? (usage.error ?? t(state, { name: provider.name }))
              : t(state, { name: provider.name })
          return (
            <RowFrame key={provider.id} text={<RowText name={provider.name} />}>
              <span
                className={cn(
                  'max-w-70 truncate text-hint leading-[normal]',
                  usage?.state === 'error' ? 'text-danger' : 'text-tertiary',
                )}
                title={usage?.error ?? undefined}
              >
                {message}
              </span>
            </RowFrame>
          )
        })}
      </RowGroup>
    </section>
  )
}

/** What the meters leave out: providers whose usage is unsupported, failed or still unread. */
function ProviderUsageNotes({
  providers,
  reading,
}: {
  providers: readonly AgentProvider[]
  reading: boolean
}) {
  const { t } = useTranslation('settings')
  const notes = providers.filter((provider) => provider.usage?.state !== 'ready')
  if (notes.length === 0) return null
  return (
    <div className="flex flex-col gap-1 pt-2">
      {notes.map((provider) => {
        const usage = provider.usage
        const text =
          usage === null
            ? t(reading ? 'agents.providers.usage.reading' : 'agents.providers.usage.unknown')
            : usage.state === 'unsupported'
              ? t('agents.providers.usage.unsupported', { name: provider.name })
              : usage.state === 'error'
                ? (usage.error ?? t('agents.providers.usage.failed', { name: provider.name }))
                : null
        if (!text) return null
        return (
          <p
            key={provider.id}
            className={cn(
              'text-hint text-pretty',
              usage?.state === 'error' ? 'text-danger' : 'text-tertiary',
            )}
          >
            {usage?.state === 'error' ? `${provider.name}: ${text}` : text}
          </p>
        )
      })}
    </div>
  )
}

/** The providers' remaining balances, each with the provider it belongs to. */
function ProviderBalances({ providers }: { providers: readonly AgentProvider[] }) {
  const { t } = useTranslation('settings')
  const now = useNow()
  const withBalances = providers.filter((provider) => (provider.usage?.balances.length ?? 0) > 0)
  const rows = withBalances.flatMap((provider) =>
    (provider.usage?.balances ?? []).map((balance) => ({ provider, balance })),
  )
  if (rows.length === 0) return null
  const stale = withBalances.filter((provider) => provider.usage?.state === 'error')
  return (
    <section className="flex flex-col">
      <GroupLabel
        group={{
          id: 'provider-balances',
          label: t('agents.providers.usage.balances'),
        }}
      />
      <RowGroup>
        {rows.map(({ provider, balance }, index) => (
          <RowFrame
            key={`${provider.id}-${balance.label}-${index}`}
            text={
              <RowText
                name={balance.label}
                description={`${provider.name} · ${t('agents.providers.usage.observed', { ago: mediumAgo(provider.usage!.observedAt, now) })}`}
              />
            }
          >
            <span className="font-display text-sheet-title font-semibold" data-selectable="">
              {balanceText(balance)}
            </span>
          </RowFrame>
        ))}
      </RowGroup>
      {stale.map((provider) => (
        <p key={provider.id} className="mt-2 text-hint text-pretty text-danger">
          {provider.name}:{' '}
          {provider.usage!.observedAt > 0
            ? t('agents.providers.usage.balancesStale', {
                ago: mediumAgo(provider.usage!.observedAt, now),
              })
            : t('agents.providers.usage.balancesStaleNoTime')}
        </p>
      ))}
    </section>
  )
}

function AddProviderDialog({
  open,
  onOpenChange,
  providers,
  remote,
  onSignIn,
  onSetKey,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  providers: readonly AgentProvider[]
  remote: boolean
  onSignIn: (command: string) => void
  onSetKey: (provider: AgentProvider) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  const [query, setQuery] = useState('')
  const shown = useMemo(() => filterProviders(providers, query), [providers, query])
  const close = (): void => {
    onOpenChange(false)
    setQuery('')
  }
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <SettingsDialogContent className="sm:max-w-135">
        <SettingsDialogHeader title={t('agents.providers.addTitle')}>
          {t('agents.providers.addDescription')}
        </SettingsDialogHeader>
        <SettingsDialogBody>
          <InputGroup className="h-8">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder={t('agents.providers.searchPlaceholder')}
              aria-label={t('agents.providers.search')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </InputGroup>
          <div className="-mx-1 max-h-96 min-h-0 overflow-y-auto px-1">
            {shown.length === 0 ? (
              <p className="py-3 text-group text-tertiary">{t('agents.providers.noMatches')}</p>
            ) : (
              shown.map((provider) => (
                <AddProviderRow
                  key={provider.id}
                  provider={provider}
                  remote={remote}
                  onSignIn={() => {
                    if (!provider.loginCommand) return
                    close()
                    onSignIn(provider.loginCommand)
                  }}
                  onSetKey={() => {
                    close()
                    onSetKey(provider)
                  }}
                />
              ))
            )}
          </div>
        </SettingsDialogBody>
        <SettingsDialogFooter>
          <DialogClose render={<Button type="button" variant="ghost" className={ROW_BUTTON} />}>
            {t('common:actions.close')}
          </DialogClose>
        </SettingsDialogFooter>
      </SettingsDialogContent>
    </Dialog>
  )
}

function AddProviderRow({
  provider,
  remote,
  onSignIn,
  onSetKey,
}: {
  provider: AgentProvider
  remote: boolean
  onSignIn: () => void
  onSetKey: () => void
}) {
  const { t } = useTranslation('settings')
  const keyMethod = provider.methods.some((method) => method.type === 'key')
  const methods = provider.methods.map((method) => t(METHOD_KEY[method.type])).join(' · ')
  return (
    <div className="flex min-w-0 items-center gap-3 py-2.5 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-lede leading-[normal] font-medium text-primary">
          {provider.name}
        </span>
        <span className="truncate text-hint text-tertiary">
          {methods}
          {provider.accounts.length > 0 && ` · ${t('agents.providers.connected')}`}
        </span>
      </div>
      <span className="flex shrink-0 items-center gap-1.5">
        {provider.loginCommand && !remote && (
          <Button variant="outline" className={ROW_BUTTON} onClick={onSignIn}>
            <SquareTerminalIcon data-icon="inline-start" />
            {t(provider.accounts.length > 0 ? 'agents.providers.again' : 'agents.providers.signIn')}
          </Button>
        )}
        {provider.loginCommand && remote && (
          <Button
            variant="outline"
            className={ROW_BUTTON}
            onClick={() => {
              const command = provider.loginCommand
              if (!command) return
              void navigator.clipboard.writeText(command).then(
                () => toast(t('agents.providers.copied')),
                () => toast(t('agents.providers.copyFailed'), undefined, { tone: 'warning' }),
              )
            }}
          >
            <CopyIcon data-icon="inline-start" />
            {t('agents.providers.copyCommand')}
          </Button>
        )}
        {keyMethod && (
          <Button variant="outline" className={ROW_BUTTON} onClick={onSetKey}>
            <KeyRoundIcon data-icon="inline-start" />
            {t('agents.providers.setKey')}
          </Button>
        )}
        {!provider.loginCommand && !keyMethod && (
          <span className="text-hint text-tertiary">{t('agents.providers.unavailable')}</span>
        )}
      </span>
    </div>
  )
}

function ProviderKeyDialog({
  status,
  target,
  onOpenChange,
}: {
  status: AgentStatus
  target: AgentProvider | null
  onOpenChange: (open: boolean) => void
}) {
  const { request } = useHostScope()
  const { t } = useTranslation(['settings', 'common'])
  const id = useId()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = (): void => {
    onOpenChange(false)
    setKey('')
    setError(null)
    setBusy(false)
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!target || !key.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await request(
        'agents.providerAction',
        providerKeyAction({
          agentId: status.id,
          providerId: target.id,
          key: key.trim(),
        }),
      )
      close()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <Dialog open={target !== null} onOpenChange={(next) => (next ? undefined : close())}>
      <SettingsDialogContent>
        <form className="contents" onSubmit={(event) => void submit(event)}>
          <SettingsDialogHeader
            title={t('agents.providers.key.title', { name: target?.name ?? '' })}
          >
            {t('agents.providers.key.description')}
          </SettingsDialogHeader>
          <SettingsDialogBody>
            <div className="flex min-w-0 flex-col gap-1.75">
              <label htmlFor={id} className="text-control leading-[normal] font-medium">
                {t('agents.providers.key.label')}
              </label>
              <Input
                id={id}
                type="password"
                value={key}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                className={DIALOG_MONO_FIELD}
                onChange={(event) => setKey(event.target.value)}
              />
            </div>
            <ControlError error={error} />
          </SettingsDialogBody>
          <SettingsDialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" className={ROW_BUTTON} />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <Button type="submit" className={ROW_BUTTON} disabled={!key.trim() || busy}>
              {busy && <Spinner data-icon="inline-start" />}
              {t('agents.providers.key.save')}
            </Button>
          </SettingsDialogFooter>
        </form>
      </SettingsDialogContent>
    </Dialog>
  )
}
