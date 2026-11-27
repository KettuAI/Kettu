// The Marketplace's dialogs: a kept server's keys, its agents and its uninstall, and a server
// added by hand.

import { useId, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { displayTitle, specInputs, type MarketServer, type MarketSkill } from '@shared/marketplace'
import type { InstalledKettuPlugin } from '@shared/plugins'
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
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { toast } from '@renderer/components/ui/toast'
import { SetButton } from '@renderer/features/settings/controls'
import {
  DIALOG_MONO_FIELD,
  SettingsDialogBody,
  SettingsDialogContent,
  SettingsDialogFooter,
  SettingsDialogHeader,
  SettingsField,
} from '@renderer/features/settings/settings-dialog'
import { errorMessage } from '@renderer/lib/host'
import { useTextFieldLabels } from '@renderer/lib/text-field-labels'
import { useHostScope } from '@renderer/stores/host-scope'
import {
  installSkill,
  setServerAgents,
  setSkillAgents,
  uninstallServer,
  type AgentChoice,
} from './actions'
import { AgentPicker, InputLabel } from './install'
import { setPluginToolAgents } from './plugin-actions'

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
  const fieldLabels = useTextFieldLabels()
  const inputs = specInputs(server.spec)
  const { useMarketplaceStore } = useHostScope()
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
            labels={fieldLabels}
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
  const scope = useHostScope()
  return (
    <ChooseAgentsDialog
      name={server.title}
      value={server.agents}
      open={open}
      onOpenChange={onOpenChange}
      save={(agents) => setServerAgents(scope, server.id, agents)}
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
  const scope = useHostScope()
  return (
    <ChooseAgentsDialog
      name={displayTitle(skill.name)}
      value={skill.agents}
      open={open}
      onOpenChange={onOpenChange}
      save={(agents) => setSkillAgents(scope, skill.id, agents)}
      forSkills
    />
  )
}

/** Which agents a plugin's tools go to on Kettu's MCP service. */
export function PluginToolAgentsDialog({
  plugin,
  name,
  open,
  onOpenChange,
}: {
  plugin: InstalledKettuPlugin
  name: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const scope = useHostScope()
  return (
    <ChooseAgentsDialog
      name={name}
      value={plugin.toolAgents ?? 'all'}
      open={open}
      onOpenChange={onOpenChange}
      save={(agents) => setPluginToolAgents(scope, plugin, agents)}
      forTools
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
  forTools = false,
}: {
  name: string
  value: AgentChoice
  open: boolean
  onOpenChange: (open: boolean) => void
  save: (agents: AgentChoice) => Promise<void>
  forSkills?: boolean
  forTools?: boolean
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
            forTools={forTools}
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
  forTools,
}: {
  name: string
  value: AgentChoice
  save: (agents: AgentChoice) => Promise<void>
  onDone: () => void
  forSkills: boolean
  forTools: boolean
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
        {t(
          forTools
            ? 'dialogs.agents.descriptionTools'
            : forSkills
              ? 'dialogs.agents.descriptionSkill'
              : 'dialogs.agents.description',
        )}
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
  oauth = false,
  open,
  onOpenChange,
  onUninstalled,
}: {
  server: MarketServer
  /** A server that signs in: removing it signs it out too. */
  oauth?: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  onUninstalled: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        oauth
          ? t('dialogs.remove.title', { name: server.title })
          : t('dialogs.uninstall.title', { name: server.title })
      }
      body={oauth ? t('dialogs.remove.body') : t('dialogs.uninstall.body')}
      confirm={oauth ? t('dialogs.remove.confirm') : t('dialogs.uninstall.confirm')}
      action={async () => {
        await uninstallServer(scope, server.id)
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
  const scope = useHostScope()
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
    const added = await installSkill(
      scope,
      { kind: 'github', url: url.trim() },
      agents,
      `github:${url}`,
    )
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
