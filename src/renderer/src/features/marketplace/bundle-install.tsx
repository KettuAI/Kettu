// An MCP bundle's Install and Update: the host downloads, checks and stages it first, then the
// form says what it runs and asks for the bundle's values; nothing runs and no setting is
// written until the user confirms. Values for its environment go to the key store, values for
// its arguments to the host, which writes them into the server's command line.

import { useState, type FormEvent, type ReactNode } from 'react'
import {
  CommandLineIcon,
  Delete02Icon,
  PackageIcon,
  PlusSignIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  kettuId,
  type BundleInput,
  type BundlePlan,
  type BundleRef,
} from '@shared/market-community'
import type { MarketListing } from '@shared/market-publish'
import type { CatalogServer, MarketServer } from '@shared/marketplace'
import { Icon, Popover } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { TextField } from '@renderer/components/affect/text-field'
import { toast } from '@renderer/components/ui/toast'
import { IconAction, SetButton, SettingSwitch } from '@renderer/features/settings/controls'
import { bytes } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { useTextFieldLabels } from '@renderer/lib/text-field-labels'
import { useHostScope, type HostScope } from '@renderer/stores/host-scope'
import { installServer, updateCommunityServer, type AgentChoice } from './actions'
import { useInstalling } from './hooks'
import { AgentPicker, InputLabel } from './install'
import { McpConfirmation } from './mcp-confirmation'

const tm = i18n.getFixedT(null, 'marketplace')

function warn(message: string): void {
  toast(message, undefined, { tone: 'warning' })
}

/** The values for the host's arguments and for the key store, from the form's values by key. */
function split(plan: BundlePlan, values: Record<string, string>) {
  const args: Record<string, string> = {}
  const env: Record<string, string> = {}
  for (const input of plan.inputs) {
    const value = values[input.key]?.trim() ?? ''
    if (input.env && value) env[input.env] = value
    if (input.args) args[input.key] = value
  }
  return { args, env }
}

async function commit(
  scope: HostScope,
  plan: BundlePlan,
  values: Record<string, string>,
): Promise<{ server: CatalogServer; env: Record<string, string> } | null> {
  const { args, env } = split(plan, values)
  try {
    const server = await scope.request('market.bundleCommit', { token: plan.token!, values: args })
    return { server, env }
  } catch (e) {
    warn(tm('toast.installFailed', { name: plan.name, error: errorMessage(e) }))
    return null
  }
}

function cancel(scope: HostScope, plan: BundlePlan | null): void {
  if (plan?.token) void scope.request('market.bundleCancel', { token: plan.token }).catch(() => {})
}

/** What the listing page says of a bundle: its kind, its size and when it is downloaded. */
export function BundleNote({ bundle }: { bundle: BundleRef }) {
  const { t } = useTranslation('marketplace')
  const from = bundle.from === 'url' ? (URL.parse(bundle.url)?.host ?? bundle.url) : null
  return (
    <section>
      <h3>{t('listing.runs')}</h3>
      <div className="k-mkt-list">
        <div className="k-mkt-item">
          <Icon icon={PackageIcon} size={15} />
          <span>
            <b>
              {t('bundle.kind')}
              {bundle.from === 'upload'
                ? ` · ${bytes(bundle.size)}`
                : ` · ${t('bundle.from', { host: from })}`}
            </b>
            <small>{t('bundle.note')}</small>
          </span>
        </div>
      </div>
    </section>
  )
}

/**
 * A value the bundle takes several of, one field each, kept as one line per value as the host
 * reads it.
 */
function ListField({
  input,
  label,
  hint,
  value,
  onChange,
  choose,
  autoFocus,
}: {
  input: BundleInput
  label: ReactNode
  hint: string
  value: string
  onChange: (value: string) => void
  choose: ((set: (folder: string) => void) => Promise<void>) | null
  autoFocus: boolean
}) {
  const { t } = useTranslation('marketplace')
  const rows = value.split('\n')
  const setRow = (at: number, row: string) =>
    onChange(rows.map((r, i) => (i === at ? row.replace(/[\r\n]/g, '') : r)).join('\n'))
  return (
    <div className="k-mkt-install__list">
      {rows.map((row, i) => (
        <div key={i} className="k-mkt-install__input">
          <TextField
            size="sm"
            type={input.type === 'number' ? 'number' : 'text'}
            autoFocus={autoFocus && i === 0}
            autoComplete="off"
            spellCheck={false}
            min={input.min}
            max={input.max}
            label={i === 0 ? label : undefined}
            aria-label={i === 0 ? undefined : input.title}
            hint={i === rows.length - 1 ? hint : undefined}
            value={row}
            onChange={(event) => setRow(i, event.target.value)}
          />
          {choose && (
            <Button
              size="sm"
              variant="secondary"
              type="button"
              onClick={() => void choose((folder) => setRow(i, folder))}
            >
              {t('bundle.choose')}
            </Button>
          )}
          {rows.length > 1 && (
            <IconAction
              label={t('dialogs.add.remove', { name: row.trim() || input.title })}
              icon={Delete02Icon}
              onClick={() => onChange(rows.filter((_, j) => j !== i).join('\n'))}
            />
          )}
        </div>
      ))}
      <span>
        <SetButton
          size="sm"
          type="button"
          icon={<Icon icon={PlusSignIcon} size={14} />}
          onClick={() => onChange(`${value}\n`)}
        >
          {t('bundle.addValue')}
        </SetButton>
      </span>
    </div>
  )
}

/** The bundle's form: the agents, what it runs, and a field for each value it asks for. */
function BundleForm({
  plan,
  update,
  onDone,
}: {
  plan: BundlePlan
  /** The env inputs the key store has a value for, kept when left empty. */
  update?: { kept: string[] }
  onDone: (agents: AgentChoice, values: Record<string, string>) => void
}) {
  const { t } = useTranslation('marketplace')
  const fieldLabels = useTextFieldLabels()
  const { hostId, api } = useHostScope()
  const [agents, setAgents] = useState<AgentChoice>('all')
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      plan.inputs.flatMap((input) => {
        const value =
          plan.previous?.[input.key] ??
          (input.secret ? undefined : input.default) ??
          // A switch shows off, so off is its value until it is turned on.
          (input.type === 'boolean' ? 'false' : undefined)
        return value === undefined ? [] : [[input.key, value]]
      }),
    ),
  )
  const kept = (input: BundleInput) => !!input.env && !!update?.kept.includes(input.env)
  const missing = plan.inputs.some(
    (input) => input.required && !values[input.key]?.trim() && !kept(input),
  )
  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }))
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!missing) onDone(agents, values)
  }
  return (
    <form className="k-mkt-install" onSubmit={submit}>
      {update && <b>{t('install.title', { name: plan.name })}</b>}
      <span>{t('mcp.runPermission')}</span>
      <div className="k-mkt-install__runs">
        <Icon icon={CommandLineIcon} size={13} />
        <span>
          <small>{t('bundle.runs')}</small>
          <code className="k-mkt-mono" data-selectable="">
            {plan.type === 'node' && plan.runs.startsWith('node ')
              ? `${t('bundle.nodeRuntime')} · ${plan.runs.slice(5)}`
              : plan.runs}
          </code>
        </span>
      </div>
      {!update && (
        <div className="k-mkt-install__field">
          <small>{t('install.useIn')}</small>
          <AgentPicker value={agents} onChange={setAgents} label={t('install.useIn')} />
        </div>
      )}
      {plan.inputs.map((input, i) => {
        const label = (
          <InputLabel
            name={input.key}
            title={input.title}
            required={input.required && !kept(input)}
          />
        )
        const hint =
          input.description ||
          (kept(input)
            ? t('bundle.keepHint')
            : input.secret
              ? t('install.secretHint')
              : input.multiple
                ? t('bundle.multipleHint')
                : t('install.valueHint'))
        if (input.type === 'boolean') {
          return (
            <label key={input.key} className="k-mkt-install__switch">
              <span>
                {label}
                <small>{hint}</small>
              </span>
              <SettingSwitch
                label={input.title}
                checked={values[input.key] === 'true'}
                onChange={(on) => set(input.key, on ? 'true' : 'false')}
              />
            </label>
          )
        }
        const choose =
          input.type === 'directory' && hostId === null
            ? async (put: (folder: string) => void) => {
                const folder = await api.dialogs.openProject()
                if (folder) put(folder)
              }
            : null
        if (input.multiple && !input.secret) {
          return (
            <ListField
              key={input.key}
              input={input}
              label={label}
              hint={hint}
              value={values[input.key] ?? ''}
              onChange={(value) => set(input.key, value)}
              choose={choose}
              autoFocus={i === 0}
            />
          )
        }
        return (
          <div key={input.key} className="k-mkt-install__input">
            <TextField
              size="sm"
              type={input.secret ? 'password' : input.type === 'number' ? 'number' : 'text'}
              labels={fieldLabels}
              autoFocus={i === 0}
              autoComplete="off"
              spellCheck={false}
              min={input.min}
              max={input.max}
              label={label}
              hint={hint}
              value={values[input.key] ?? ''}
              onChange={(event) => set(input.key, event.target.value)}
            />
            {choose && (
              <Button
                size="sm"
                variant="secondary"
                type="button"
                onClick={() => void choose((folder) => set(input.key, folder))}
              >
                {t('bundle.choose')}
              </Button>
            )}
          </div>
        )
      })}
      <Button size="sm" type="submit" disabled={missing}>
        {update ? t('bundle.updateSubmit') : t('mcp.addAndCheck')}
      </Button>
    </form>
  )
}

/** Why the bundle cannot install here, in the popover Install opens. */
function Blocked({ plan }: { plan: BundlePlan }) {
  const { t } = useTranslation('marketplace')
  return (
    <div className="k-mkt-install">
      <b>{t('bundle.blockedTitle', { name: plan.name })}</b>
      <span data-selectable="">{plan.blocked}</span>
    </div>
  )
}

/** A bundle listing's Install: staged on the host for review before installing. */
export function BundleInstallButton({ listing }: { listing: MarketListing }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const installing = useInstalling(kettuId(listing.id))
  const [preparing, setPreparing] = useState(false)
  const [plan, setPlan] = useState<BundlePlan | null>(null)
  const finish = async (
    staged: BundlePlan,
    agents: AgentChoice,
    values: Record<string, string>,
  ) => {
    const done = await commit(scope, staged, values)
    if (done) await installServer(scope, done.server, agents, done.env)
  }
  const start = async () => {
    setPreparing(true)
    try {
      const staged = await scope.request('market.bundlePrepare', { id: listing.id })
      setPlan(staged)
    } catch (e) {
      warn(t('toast.installFailed', { name: listing.name, error: errorMessage(e) }))
    } finally {
      setPreparing(false)
    }
  }
  const busy = preparing || installing
  return (
    <span className="ui-as-anchor">
      <Button
        loading={busy}
        aria-expanded={plan !== null}
        onClick={() => !busy && plan === null && void start()}
      >
        {preparing ? t('bundle.preparing') : busy ? t('install.installing') : t('install.submit')}
      </Button>
      <McpConfirmation
        open={plan !== null}
        onOpenChange={(open) => {
          if (open) return
          cancel(scope, plan)
          setPlan(null)
        }}
        title={t('install.title', { name: listing.name })}
      >
        {plan && (
          <div className="kettu-sd__body">
            {plan.blocked ? (
              <Blocked plan={plan} />
            ) : (
              <BundleForm
                plan={plan}
                onDone={(agents, values) => {
                  setPlan(null)
                  void finish(plan, agents, values)
                }}
              />
            )}
          </div>
        )}
      </McpConfirmation>
    </span>
  )
}

/**
 * A kept bundle server's Update: the new version is staged, and installed at once with the
 * values it took before unless it asks for a new one, which the form then asks for.
 */
export function BundleUpdateButton({ kept, version }: { kept: MarketServer; version: string }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const keys = scope.useMarketplaceStore((s) => s.keys?.[kept.id] ?? [])
  const listingId = kept.id.slice('kettu:'.length)
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<BundlePlan | null>(null)
  const finish = async (staged: BundlePlan, values: Record<string, string>) => {
    setBusy(true)
    try {
      const done = await commit(scope, staged, values)
      if (done) await updateCommunityServer(scope, kept, done.server, done.env)
    } finally {
      setBusy(false)
    }
  }
  const start = async () => {
    setBusy(true)
    let staged: BundlePlan
    try {
      staged = await scope.request('market.bundlePrepare', { id: listingId })
    } catch (e) {
      warn(t('toast.updateFailed', { name: kept.title, error: errorMessage(e) }))
      setBusy(false)
      return
    }
    setBusy(false)
    if (staged.blocked) return setPlan(staged)
    const values = { ...staged.previous }
    const asks = staged.inputs.some((input) =>
      input.env
        ? input.required && !keys.includes(input.env)
        : input.required && !values[input.key]?.trim() && !input.default,
    )
    if (asks) setPlan(staged)
    else await finish(staged, values)
  }
  return (
    <span className="ui-as-anchor">
      <Button loading={busy} onClick={() => !busy && plan === null && void start()}>
        {busy ? t('community.updating') : t('community.update', { version })}
      </Button>
      <Popover
        open={plan !== null}
        onClose={() => {
          cancel(scope, plan)
          setPlan(null)
        }}
        align="end"
        className="ui-as-menu k-mkt-install-pop"
      >
        {plan &&
          (plan.blocked ? (
            <Blocked plan={plan} />
          ) : (
            <BundleForm
              plan={plan}
              update={{ kept: keys }}
              onDone={(_, values) => {
                setPlan(null)
                void finish(plan, values)
              }}
            />
          ))}
      </Popover>
    </span>
  )
}
