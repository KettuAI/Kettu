// The Marketplace's dialogs: a kept server's keys, its agents and its uninstall, and a server
// added by hand.

import { useId, useState, type FormEvent } from 'react'
import { Delete02Icon, PlusSignIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  displayTitle,
  specInputs,
  type MarketServer,
  type MarketSkill,
  type McpSpec,
  type McpValue,
} from '@shared/marketplace'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Icon } from '@renderer/components/affect/app-shell'
import { TextField } from '@renderer/components/affect/text-field'
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
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { toast } from '@renderer/components/ui/toast'
import { IconAction, Segmented, SetButton } from '@renderer/features/settings/controls'
import {
  DIALOG_FIELD,
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from '@renderer/features/settings/settings-dialog'
import { errorMessage } from '@renderer/lib/host'
import { useMarketplaceStore } from '@renderer/stores/marketplace'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  addMarketplace,
  addServer,
  installSkill,
  setServerAgents,
  setSkillAgents,
  uninstallServer,
  type AgentChoice,
} from './actions'
import { useHarnessAgents } from './hooks'
import { AgentPicker, InputLabel } from './install'
import { nameProblem, splitCommand } from './model'

/** New values for a server's inputs: one typed replaces its value, Clear removes it. */
export function KeysDialog({
  server,
  open,
  onOpenChange,
}: {
  server: MarketServer
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent>
        {open && <KeysForm server={server} onDone={() => onOpenChange(false)} />}
      </SettingsDialogContent>
    </Dialog>
  )
}

function KeysForm({ server, onDone }: { server: MarketServer; onDone: () => void }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const inputs = specInputs(server.spec)
  const set = useMarketplaceStore((s) => s.keys?.[server.id] ?? null)
  const [values, setValues] = useState<Record<string, string | null>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const changes = Object.fromEntries(
    Object.entries(values).filter(([, value]) => value === null || value.trim() !== ''),
  )
  const isSet = (name: string) => set?.includes(name) === true && values[name] !== null
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (Object.keys(changes).length === 0) return onDone()
    setBusy(true)
    setError(null)
    try {
      const trimmed = Object.fromEntries(
        Object.entries(changes).map(([name, value]) => [
          name,
          value === null ? null : value.trim(),
        ]),
      )
      await useMarketplaceStore.getState().setKeys({ serverId: server.id, values: trimmed })
      toast(t('toast.keysSaved', { name: server.title }), undefined, { tone: 'success' })
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <SettingsDialogHeader title={t('dialogs.keys.title', { name: server.title })}>
        {t('dialogs.keys.description')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        {inputs.map((input, i) => (
          <TextField
            key={input.name}
            type={input.secret ? 'password' : 'text'}
            autoComplete="off"
            spellCheck={false}
            autoFocus={i === 0}
            prefix={input.prefix}
            label={<InputLabel name={input.name} required={input.required} />}
            hint={input.description}
            placeholder={
              values[input.name] === null
                ? t('dialogs.keys.cleared')
                : isSet(input.name)
                  ? t('dialogs.keys.replace')
                  : t('dialogs.keys.notSet')
            }
            value={values[input.name] ?? ''}
            onChange={(event) => setValues((v) => ({ ...v, [input.name]: event.target.value }))}
            suffix={
              isSet(input.name) && !values[input.name] ? (
                <button
                  type="button"
                  className="k-mkt-clear"
                  onClick={() => setValues((v) => ({ ...v, [input.name]: null }))}
                >
                  {t('dialogs.keys.clear')}
                </button>
              ) : undefined
            }
          />
        ))}
        {error && (
          <p role="alert" className="kettu-sd__error" data-selectable="">
            {t('dialogs.keys.failed', { error })}
          </p>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton size="md" variant="primary" type="submit" loading={busy}>
          {t('dialogs.keys.save')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}

/** Which agents a kept server goes to. */
export function AgentsDialog({
  server,
  open,
  onOpenChange,
}: {
  server: MarketServer
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <ChooseAgentsDialog
      name={server.title}
      value={server.agents}
      open={open}
      onOpenChange={onOpenChange}
      save={(agents) => setServerAgents(server.id, agents)}
    />
  )
}

/** Which agents a kept skill goes to. */
export function SkillAgentsDialog({
  skill,
  open,
  onOpenChange,
}: {
  skill: MarketSkill
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <ChooseAgentsDialog
      name={displayTitle(skill.name)}
      value={skill.agents}
      open={open}
      onOpenChange={onOpenChange}
      save={(agents) => setSkillAgents(skill.id, agents)}
      forSkills
    />
  )
}

function ChooseAgentsDialog({
  name,
  value,
  open,
  onOpenChange,
  save,
  forSkills = false,
}: {
  name: string
  value: AgentChoice
  open: boolean
  onOpenChange: (open: boolean) => void
  save: (agents: AgentChoice) => Promise<void>
  forSkills?: boolean
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent>
        {open && (
          <AgentsForm
            name={name}
            value={value}
            save={save}
            onDone={() => onOpenChange(false)}
            forSkills={forSkills}
          />
        )}
      </SettingsDialogContent>
    </Dialog>
  )
}

function AgentsForm({
  name,
  value,
  save,
  onDone,
  forSkills,
}: {
  name: string
  value: AgentChoice
  save: (agents: AgentChoice) => Promise<void>
  onDone: () => void
  forSkills: boolean
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  const [agents, setAgents] = useState<AgentChoice>(value)
  const [busy, setBusy] = useState(false)
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        setBusy(true)
        // A failure shows as a toast, so the dialog closes either way.
        void save(agents).finally(() => {
          setBusy(false)
          onDone()
        })
      }}
    >
      <SettingsDialogHeader title={t('dialogs.agents.title', { name })}>
        {t('dialogs.agents.description')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <AgentPicker
          value={agents}
          onChange={setAgents}
          label={t('install.useIn')}
          forSkills={forSkills}
        />
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton size="md" variant="primary" type="submit" loading={busy}>
          {t('dialogs.agents.save')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}

/** The one confirmation an uninstall asks. */
export function UninstallDialog({
  server,
  open,
  onOpenChange,
  onUninstalled,
}: {
  server: MarketServer
  open: boolean
  onOpenChange: (open: boolean) => void
  onUninstalled: () => void
}) {
  const { t } = useTranslation('marketplace')
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('dialogs.uninstall.title', { name: server.title })}
      body={t('dialogs.uninstall.body')}
      confirm={t('dialogs.uninstall.confirm')}
      action={async () => {
        await uninstallServer(server.id)
        onUninstalled()
      }}
    />
  )
}

/** A destructive action's one confirmation; what it says when the action fails stays in it. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirm,
  action,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  body: string
  confirm: string
  action: () => Promise<void>
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      await action()
      onOpenChange(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return
        if (!next) setError(null)
        onOpenChange(next)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-xs text-danger" data-selectable="">
            {t('dialogs.failed', { error })}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void run()}>
            {confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Adds a plugin marketplace to one Claude Code or Codex agent, from owner/repo or a Git URL. */
export function AddMarketplaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent>
        {open && <AddMarketplaceForm onDone={() => onOpenChange(false)} />}
      </SettingsDialogContent>
    </Dialog>
  )
}

function AddMarketplaceForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const claude = useHarnessAgents('claude-code')
  const codex = useHarnessAgents('codex')
  const agents = [...claude, ...codex]
  const id = useId()
  const [agentId, setAgentId] = useState<AgentId | null>(agents[0]?.id ?? null)
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = agentId !== null && source.trim() !== ''
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    setError(null)
    try {
      await addMarketplace(agentId, source.trim())
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <SettingsDialogHeader title={t('dialogs.marketplace.title')}>
        {t('dialogs.marketplace.description')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <div className="kettu-sd__field">
          <span className="k-mkt-values__label">{t('dialogs.marketplace.agent')}</span>
          {agents.length === 0 ? (
            <span className="kettu-sd__hint">{t('dialogs.marketplace.noAgents')}</span>
          ) : (
            <div
              className="k-mkt-agents"
              role="radiogroup"
              aria-label={t('dialogs.marketplace.agent')}
            >
              {agents.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  role="radio"
                  aria-checked={agent.id === agentId}
                  className="k-mkt-agents__agent"
                  onClick={() => setAgentId(agent.id)}
                >
                  <AgentMark agent={agent.id} size={13} />
                  <span className="k-mkt-agents__name">{agent.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <SettingsField
          label={t('dialogs.marketplace.source')}
          htmlFor={`${id}-source`}
          hint={t('dialogs.marketplace.sourceHint')}
        >
          <input
            id={`${id}-source`}
            className={DIALOG_MONO_FIELD}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            placeholder={t('dialogs.marketplace.sourcePlaceholder')}
            value={source}
            onChange={(event) => setSource(event.target.value)}
          />
        </SettingsField>
        {error && (
          <p role="alert" className="kettu-sd__error" data-selectable="">
            {t('dialogs.failed', { error })}
          </p>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton size="md" variant="primary" type="submit" loading={busy} disabled={!ready}>
          {t('dialogs.marketplace.submit')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}

/** Adds a skill from a repository, or one folder of it, on GitHub. */
export function AddSkillDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent>
        {open && <AddSkillForm onDone={() => onOpenChange(false)} />}
      </SettingsDialogContent>
    </Dialog>
  )
}

function AddSkillForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const id = useId()
  const [url, setUrl] = useState('')
  const [agents, setAgents] = useState<AgentChoice>('all')
  const [busy, setBusy] = useState(false)
  const ready = isGithubUrl(url.trim())
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    // A failure shows as a toast, so the dialog only closes once the skill is kept.
    const added = await installSkill({ kind: 'github', url: url.trim() }, agents, `github:${url}`)
    setBusy(false)
    if (added) onDone()
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <SettingsDialogHeader title={t('dialogs.skill.title')}>
        {t('dialogs.skill.description')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <SettingsField
          label={t('dialogs.skill.url')}
          htmlFor={`${id}-url`}
          hint={url.trim() && !ready ? t('dialogs.skill.urlInvalid') : t('dialogs.skill.urlHint')}
        >
          <input
            id={`${id}-url`}
            className={DIALOG_MONO_FIELD}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            inputMode="url"
            aria-invalid={url.trim() && !ready ? true : undefined}
            placeholder={t('dialogs.skill.urlPlaceholder')}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </SettingsField>
        <div className="kettu-sd__field">
          <span className="k-mkt-values__label">{t('install.useIn')}</span>
          <AgentPicker value={agents} onChange={setAgents} label={t('install.useIn')} forSkills />
        </div>
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton size="md" variant="primary" type="submit" loading={busy} disabled={!ready}>
          {t('dialogs.skill.submit')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}

function isGithubUrl(text: string): boolean {
  try {
    const url = new URL(text)
    return url.protocol === 'https:' && url.hostname === 'github.com' && url.pathname.length > 1
  } catch {
    return false
  }
}

/** A header or variable as the add dialog edits it. */
interface ValueDraft {
  key: number
  name: string
  value: string
  secret: boolean
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A server added by hand: a URL with headers, or a command with its environment. */
export function AddServerDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent>
        {open && (
          <AddServerForm
            onDone={() => {
              onOpenChange(false)
              onAdded()
            }}
          />
        )}
      </SettingsDialogContent>
    </Dialog>
  )
}

function AddServerForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const kept = useSettingsStore((s) => s.settings.marketplace.mcp)
  const id = useId()
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'http' | 'stdio'>('http')
  const [url, setUrl] = useState('')
  const [transport, setTransport] = useState<'streamable-http' | 'sse'>('streamable-http')
  const [command, setCommand] = useState('')
  const [headers, setHeaders] = useState<ValueDraft[]>([])
  const [env, setEnv] = useState<ValueDraft[]>([])
  const [next, setNext] = useState(0)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const values = kind === 'http' ? headers : env
  const setValues = kind === 'http' ? setHeaders : setEnv
  const nameOk = kind === 'http' ? HEADER_NAME : ENV_NAME

  const problem = nameProblem(name.trim(), kept)
  const words = splitCommand(command.trim())
  const urlOk = isUrl(url.trim())
  const commandOk = words !== null && words.length > 0
  const names = values.map((v) => v.name.trim())
  const valueProblem = (draft: ValueDraft, i: number): string | null => {
    const key = draft.name.trim()
    if (!nameOk.test(key)) return t('dialogs.add.valueNameInvalid')
    if (names.indexOf(key) !== i) return t('dialogs.add.valueNameTaken')
    if (draft.secret && !draft.value.trim()) return t('dialogs.add.secretEmpty')
    return null
  }
  const valuesOk = values.every((draft, i) => valueProblem(draft, i) === null)
  const ready = problem === null && (kind === 'http' ? urlOk : commandOk) && valuesOk

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setTried(true)
    if (!ready) return
    const spec: McpSpec =
      kind === 'http'
        ? { type: 'http', transport, url: url.trim(), headers: values.map(toValue) }
        : { type: 'stdio', command: words![0]!, args: words!.slice(1), env: values.map(toValue) }
    const secrets = Object.fromEntries(
      values.filter((v) => v.secret).map((v) => [v.name.trim(), v.value.trim()]),
    )
    setBusy(true)
    setError(null)
    try {
      await addServer(name.trim(), spec, secrets)
      onDone()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const nameMessage =
    tried && problem
      ? {
          empty: t('dialogs.add.nameEmpty'),
          format: t('dialogs.add.nameFormat'),
          reserved: t('dialogs.add.nameReserved'),
          taken: t('dialogs.add.nameTaken'),
        }[problem]
      : null
  const targetMessage =
    tried && kind === 'http' && !urlOk
      ? t('dialogs.add.urlInvalid')
      : tried && kind === 'stdio' && !commandOk
        ? words === null
          ? t('dialogs.add.commandQuote')
          : t('dialogs.add.commandEmpty')
        : null

  return (
    <form onSubmit={(event) => void submit(event)}>
      <SettingsDialogHeader title={t('dialogs.add.title')}>
        {t('dialogs.add.description')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <SettingsField
          label={t('dialogs.add.name')}
          htmlFor={`${id}-name`}
          hint={nameMessage ?? t('dialogs.add.nameHint')}
        >
          <input
            id={`${id}-name`}
            className={DIALOG_MONO_FIELD}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            aria-invalid={nameMessage ? true : undefined}
            placeholder={t('dialogs.add.namePlaceholder')}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </SettingsField>
        <SettingsField label={t('dialogs.add.kind')}>
          <Segmented
            label={t('dialogs.add.kind')}
            value={kind}
            options={[
              { value: 'http', label: t('dialogs.add.kindUrl') },
              { value: 'stdio', label: t('dialogs.add.kindCommand') },
            ]}
            onChange={setKind}
          />
        </SettingsField>
        {kind === 'http' ? (
          <>
            <SettingsField
              label={t('dialogs.add.url')}
              htmlFor={`${id}-url`}
              hint={targetMessage ?? undefined}
            >
              <input
                id={`${id}-url`}
                className={DIALOG_MONO_FIELD}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                inputMode="url"
                aria-invalid={targetMessage ? true : undefined}
                placeholder={t('dialogs.add.urlPlaceholder')}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </SettingsField>
            <SettingsField label={t('dialogs.add.transport')}>
              <Segmented
                label={t('dialogs.add.transport')}
                value={transport}
                options={[
                  { value: 'streamable-http', label: t('listing.transport.streamable-http') },
                  { value: 'sse', label: t('listing.transport.sse') },
                ]}
                onChange={setTransport}
              />
            </SettingsField>
          </>
        ) : (
          <SettingsField
            label={t('dialogs.add.command')}
            htmlFor={`${id}-command`}
            hint={targetMessage ?? t('dialogs.add.commandHint')}
          >
            <input
              id={`${id}-command`}
              className={DIALOG_MONO_FIELD}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              aria-invalid={targetMessage ? true : undefined}
              placeholder={t('dialogs.add.commandPlaceholder')}
              value={command}
              onChange={(event) => setCommand(event.target.value)}
            />
          </SettingsField>
        )}
        <div className="kettu-sd__field">
          <span className="k-mkt-values__label">
            {kind === 'http' ? t('dialogs.add.headers') : t('dialogs.add.env')}
          </span>
          {values.map((draft, i) => {
            const message = tried ? valueProblem(draft, i) : null
            const update = (patch: Partial<ValueDraft>) =>
              setValues((list) => list.map((v) => (v.key === draft.key ? { ...v, ...patch } : v)))
            return (
              <div key={draft.key} className="k-mkt-value">
                <div className="k-mkt-value__fields">
                  <input
                    className={DIALOG_MONO_FIELD}
                    aria-label={t('dialogs.add.valueName')}
                    aria-invalid={message ? true : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="off"
                    placeholder={
                      kind === 'http'
                        ? t('dialogs.add.headerPlaceholder')
                        : t('dialogs.add.envPlaceholder')
                    }
                    value={draft.name}
                    onChange={(event) => update({ name: event.target.value })}
                  />
                  <input
                    className={DIALOG_FIELD}
                    type={draft.secret ? 'password' : 'text'}
                    aria-label={t('dialogs.add.value')}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={t('dialogs.add.value')}
                    value={draft.value}
                    onChange={(event) => update({ value: event.target.value })}
                  />
                  <label className="k-mkt-value__secret">
                    <Checkbox
                      checked={draft.secret}
                      onCheckedChange={(checked) => update({ secret: checked === true })}
                    />
                    {t('dialogs.add.secret')}
                  </label>
                  <IconAction
                    label={t('dialogs.add.remove', {
                      name: draft.name.trim() || t('dialogs.add.value'),
                    })}
                    icon={Delete02Icon}
                    onClick={() => setValues((list) => list.filter((v) => v.key !== draft.key))}
                  />
                </div>
                {message && (
                  <span role="alert" className="kettu-sd__error">
                    {message}
                  </span>
                )}
              </div>
            )
          })}
          <span>
            <SetButton
              icon={<Icon icon={PlusSignIcon} size={14} />}
              onClick={() => {
                setValues((list) => [...list, { key: next, name: '', value: '', secret: true }])
                setNext((n) => n + 1)
              }}
            >
              {kind === 'http' ? t('dialogs.add.addHeader') : t('dialogs.add.addVariable')}
            </SetButton>
          </span>
          <span className="kettu-sd__hint">{t('dialogs.add.secretHint')}</span>
        </div>
        {error && (
          <p role="alert" className="kettu-sd__error" data-selectable="">
            {t('dialogs.add.failed', { error })}
          </p>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton size="md" variant="primary" type="submit" loading={busy}>
          {t('dialogs.add.submit')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}

/** A secret becomes an input the key store fills; anything else is kept in the spec as it is. */
function toValue(draft: ValueDraft): McpValue {
  const name = draft.name.trim()
  return draft.secret
    ? { name, input: true, secret: true, required: true }
    : { name, value: draft.value }
}

function isUrl(text: string): boolean {
  try {
    const url = new URL(text)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}
