// Settings > Agents: OpenCode's provider accounts, their plan usage and balances. An agent whose
// host does not read providers keeps the account group instead.

import { useId, useMemo, useState, type FormEvent } from 'react'
import {
  Add01Icon,
  ComputerTerminal01Icon,
  Copy01Icon,
  Key01Icon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentProvider, AgentStatus, ProviderBalance } from '@shared/agent-host'
import { Icon } from '@renderer/components/affect/app-shell'
import { useRefresh } from '@renderer/components/refresh'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { toast } from '@renderer/components/ui/toast'
import { currentLocale } from '@renderer/lib/i18n'
import { mediumAgo, money } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { newestLimits } from '@renderer/lib/plan-readings'
import { useNow } from '@renderer/lib/use-now'
import { usePlanReadings } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { UsageGroup } from './agent-parts'
import { useAction } from './agent-helpers'
import { CommandLine, ControlError, FindField, IconAction, Pill, SetButton, Spin } from './controls'
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
  const refresh = useRefresh()
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
    act(() => {
      const asked = request('agents.refreshAccount', { agentId: status.id, force: true })
      // The icon turns to the end of its turn; the rows and the error follow the request alone.
      refresh.run(() => asked).catch(() => {})
      return asked
    })
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
      <section className="k-group" aria-label={t('agents.providers.group')}>
        <GroupLabel
          group={{
            id: 'providers',
            label: t('agents.providers.group'),
            ...(connectedCount > 0 && { count: connectedCount }),
            actions: (
              <>
                <SetButton
                  variant="ghost"
                  icon={<Icon icon={Add01Icon} size={14} />}
                  onClick={() => setAddOpen(true)}
                >
                  {t('agents.providers.add')}
                </SetButton>
                <IconAction
                  label={t('agents.providers.refresh')}
                  icon={RefreshIcon}
                  busy={refresh.phase === 'turning'}
                  onClick={retry}
                />
              </>
            ),
          }}
        />
        {providersError && (
          <Notice
            variant="error"
            title={t('agents.providers.readFailed')}
            action={
              <SetButton loading={busy} onClick={retry}>
                {t('agents.providers.retry')}
              </SetButton>
            }
          >
            {providersError}
          </Notice>
        )}
        {connectedCount === 0 && !providersError ? (
          <p className="k-reading">
            {reading && providers.every((provider) => provider.accounts.length === 0) ? (
              <span className="k-end">
                <Spin />
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
          <p role="alert" className="ui-sg-hint k-error" data-wrap="">
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
      <div className="k-block">
        <div className="k-line">
          <span className="ui-sg-label k-lines">
            <b title={provider.name}>{provider.name}</b>
            {methods && <small title={methods}>{methods}</small>}
          </span>
          <span className="ui-sg-control">
            {provider.loginCommand && !remote && (
              <SetButton
                disabled={busy}
                icon={<Icon icon={ComputerTerminal01Icon} size={14} />}
                onClick={() => onSignIn(provider.loginCommand)}
              >
                {t(
                  provider.accounts.length > 0
                    ? 'agents.providers.again'
                    : 'agents.providers.signIn',
                )}
              </SetButton>
            )}
            {keyMethod && (
              <SetButton
                disabled={busy}
                icon={<Icon icon={Key01Icon} size={14} />}
                onClick={() => onSetKey()}
              >
                {t('agents.providers.setKey')}
              </SetButton>
            )}
          </span>
        </div>
        {provider.accounts.length === 0 ? (
          <p className="k-muted">{t('agents.providers.notConnected')}</p>
        ) : (
          <div className="k-inset k-list">
            {provider.accounts.map((account, index) => {
              const typed = account as ProviderAccount
              const isActive = active === typed
              // Only a real credential can be activated or removed; an env entry has no id.
              const canPick = typed.id !== null
              const accountKey = typed.id ?? index
              const activateKey = `${provider.id}:activate:${accountKey}`
              const logoutKey = `${provider.id}:logout:${accountKey}`
              return (
                <div key={typed.id ?? `${provider.id}-${index}`} className="k-list__row">
                  <span className="k-list__name k-grow-0">
                    {typed.label || t('agents.providers.connected')}
                  </span>
                  <span className="k-muted">{t(METHOD_KEY[typed.method])}</span>
                  {isActive && <Pill tone="success">{t('agents.providers.active')}</Pill>}
                  {typed.needsAuth && (
                    <Pill tone="attention">{t('agents.providers.needsSignIn')}</Pill>
                  )}
                  <span className="k-end k-push">
                    {!isActive && canPick && (
                      <SetButton
                        loading={pending === activateKey}
                        disabled={busy && pending !== activateKey}
                        onClick={() => run(activateKey, () => action('activate', typed.id))}
                      >
                        {t('agents.providers.use')}
                      </SetButton>
                    )}
                    {canPick && (
                      <SetButton
                        variant="ghost"
                        loading={pending === logoutKey}
                        disabled={busy && pending !== logoutKey}
                        onClick={() => run(logoutKey, () => action('logout', typed.id))}
                      >
                        {t('agents.providers.logOut')}
                      </SetButton>
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
  const limits = newestLimits(usePlanReadings(), status)
  if (limits.length > 0) {
    return (
      <>
        <UsageGroup status={status} reading={reading} running={running} />
        <ProviderUsageNotes providers={providers} reading={reading} />
      </>
    )
  }
  return (
    <section className="k-group" aria-label={t('agents.usage')}>
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
                className={usage?.state === 'error' ? 'k-value k-error' : 'k-value'}
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
    <div>
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
            className={usage?.state === 'error' ? 'ui-sg-hint k-error' : 'ui-sg-hint'}
            data-wrap=""
          >
            {usage?.state === 'error' ? `${provider.name}: ${text}` : text}
          </p>
        )
      })}
    </div>
  )
}

/** The providers' remaining balances, each with the provider it belongs to. */
export function ProviderBalances({ providers }: { providers: readonly AgentProvider[] }) {
  const { t } = useTranslation('settings')
  const now = useNow()
  const withBalances = providers.filter((provider) => (provider.usage?.balances.length ?? 0) > 0)
  const rows = withBalances.flatMap((provider) =>
    (provider.usage?.balances ?? []).map((balance) => ({ provider, balance })),
  )
  if (rows.length === 0) return null
  const stale = withBalances.filter((provider) => provider.usage?.state === 'error')
  return (
    <section className="k-group" aria-label={t('agents.providers.usage.balances')}>
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
            <span className="k-figure" data-selectable="">
              {balanceText(balance)}
            </span>
          </RowFrame>
        ))}
      </RowGroup>
      {stale.map((provider) => (
        <p key={provider.id} className="ui-sg-hint k-error" data-wrap="">
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
          <FindField
            value={query}
            onChange={setQuery}
            label={t('agents.providers.searchPlaceholder')}
            clearLabel={t('page.clearSearch')}
            autoFocus
          />
          <div className="kettu-sd__picklist">
            {shown.length === 0 ? (
              <p className="k-muted">{t('agents.providers.noMatches')}</p>
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
          <DialogClose render={<SetButton size="md" />}>{t('common:actions.close')}</DialogClose>
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
    <div className="kettu-sd__row">
      <span className="ui-sg-label k-lines">
        <b>{provider.name}</b>
        <small>
          {methods}
          {provider.accounts.length > 0 && ` · ${t('agents.providers.connected')}`}
        </small>
      </span>
      <span className="k-end">
        {provider.loginCommand && !remote && (
          <SetButton icon={<Icon icon={ComputerTerminal01Icon} size={14} />} onClick={onSignIn}>
            {t(provider.accounts.length > 0 ? 'agents.providers.again' : 'agents.providers.signIn')}
          </SetButton>
        )}
        {provider.loginCommand && remote && (
          <SetButton
            icon={<Icon icon={Copy01Icon} size={14} />}
            onClick={() => {
              const command = provider.loginCommand
              if (!command) return
              void navigator.clipboard.writeText(command).then(
                () => toast(t('agents.providers.copied')),
                () => toast(t('agents.providers.copyFailed'), undefined, { tone: 'warning' }),
              )
            }}
          >
            {t('agents.providers.copyCommand')}
          </SetButton>
        )}
        {keyMethod && (
          <SetButton icon={<Icon icon={Key01Icon} size={14} />} onClick={onSetKey}>
            {t('agents.providers.setKey')}
          </SetButton>
        )}
        {!provider.loginCommand && !keyMethod && (
          <span className="k-muted">{t('agents.providers.unavailable')}</span>
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
            <div className="kettu-sd__field">
              <label htmlFor={id}>{t('agents.providers.key.label')}</label>
              <input
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
            <DialogClose render={<SetButton size="md" variant="ghost" />}>
              {t('common:actions.cancel')}
            </DialogClose>
            <SetButton
              size="md"
              variant="primary"
              type="submit"
              loading={busy}
              disabled={!key.trim() && !busy}
            >
              {t('agents.providers.key.save')}
            </SetButton>
          </SettingsDialogFooter>
        </form>
      </SettingsDialogContent>
    </Dialog>
  )
}
