// Installing a Kettu plugin: the one consent card that lists what the package adds, where it
// connects and what its script may do; the card of an update that asks for more; and the dialog
// that adds a plugin from a GitHub address. Nothing is installed or run before the user agrees.

import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  Alert02Icon,
  ArrowDown01Icon,
  AtIcon,
  GlobeIcon,
  InformationCircleIcon,
  LayoutLeftIcon,
  Link01Icon,
  LockIcon,
  Notification01Icon,
  PlugSocketIcon,
  Search01Icon,
  Settings01Icon,
  Shield01Icon,
  Wrench01Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { parseLinkPattern } from '@shared/plugin-refs'
import type {
  InstalledKettuPlugin,
  PluginContents,
  PluginPlan,
  PluginSource,
} from '@shared/plugins'
import { Icon } from '@renderer/components/affect/app-shell'
import { Dialog, DialogClose } from '@renderer/components/ui/dialog'
import { languageText } from '@renderer/features/plugin-views/plugin-text'
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
import { currentLocale } from '@renderer/lib/i18n'
import { useHostScope } from '@renderer/stores/host-scope'
import { setMarketplaceTab } from '@renderer/stores/view'
import { applyHeldUpdate, declineHeldUpdate, discardPlan, installPlan } from './plugin-actions'
import {
  ITEM_ICON,
  SCRIPT_ICON,
  githubShort,
  isGithubAddress,
  permissionRows,
  pluginTitle,
  type PermissionRow,
  type PluginItemKind,
} from './plugin-model'
import { kettuPluginSubject } from './tile-art'
import { ItemTile } from './tiles'

/** What a caller knows of a plugin that its package does not say. */
export interface PluginMeta {
  /** The listing's publisher, for a plugin from the Kettu Marketplace. */
  publisher?: string
  official?: boolean
}

/** The install in progress that the consent card draws, and what it asks of its owner. */
export interface PluginInstall {
  start: (
    source: PluginSource,
    options?: { meta?: PluginMeta; onInstalled?: (plugin: InstalledKettuPlugin) => void },
  ) => Promise<boolean>
  dialogs: ReactNode
}

/** One line of a card or page: its glyph, what it is and a sentence under it. */
export function Line({
  icon,
  title,
  note,
  risk,
  tag,
}: {
  icon: IconSvgElement
  title: ReactNode
  note?: ReactNode
  risk?: 'high'
  tag?: ReactNode
}) {
  return (
    <div className="k-mkt-item k-plug-line" data-risk={risk}>
      <Icon icon={icon} size={15} />
      <span>
        <b>
          {title}
          {tag}
        </b>
        {note && <small>{note}</small>}
      </span>
    </div>
  )
}

/** A titled list of lines on the card's ground. */
export function Group({
  heading,
  icon,
  children,
}: {
  heading: ReactNode
  icon?: IconSvgElement
  children: ReactNode
}) {
  return (
    <section className="k-plug-group">
      <h3>
        {icon && <Icon icon={icon} size={13} />}
        {heading}
      </h3>
      <div className="k-mkt-list">{children}</div>
    </section>
  )
}

/** A permission as the card lists it; the high ones in red with their tag. */
export function PermissionLine({ row }: { row: PermissionRow }) {
  const { t } = useTranslation('marketplace')
  const high = row.risk === 'high'
  return (
    <Line
      icon={row.domain ? GlobeIcon : high ? Shield01Icon : InformationCircleIcon}
      risk={high ? 'high' : undefined}
      title={
        <>
          {t(row.nameKey as 'plugin.permission.tools.name')}
          {row.domain && <span className="k-plug-domain">{row.domain}</span>}
        </>
      }
      tag={high ? <span className="k-plug-high">{t('plugin.risk.high')}</span> : undefined}
      note={t(row.descriptionKey as 'plugin.permission.tools.description', {
        domain: row.domain ?? undefined,
      })}
    />
  )
}

/** The names of a few items, then how many more. */
function names(list: readonly { name: string }[], prefix = ''): string {
  const shown = list.slice(0, 4).map((item) => `${prefix}${item.name}`)
  const more = list.length - shown.length
  return more > 0 ? `${shown.join(', ')} +${more}` : shown.join(', ')
}

const ADD_ROWS = [
  ['skills', 'skill', ''],
  ['commands', 'command', '/'],
  ['roles', 'role', ''],
  ['workflows', 'workflow', ''],
  ['themes', 'theme', ''],
  ['templates', 'template', ''],
] as const satisfies readonly [keyof PluginContents, PluginItemKind, string][]

/** What the package adds beside its MCP servers, which the card lists under where it connects. */
function AddsLines({ contents }: { contents: PluginContents }) {
  const { t } = useTranslation('marketplace')
  const lines: ReactNode[] = []
  for (const [field, kind, prefix] of ADD_ROWS) {
    const list = contents[field] as { name: string }[]
    if (list.length === 0) continue
    lines.push(
      <Line
        key={field}
        icon={ITEM_ICON[kind]}
        title={t(`plugin.holds.${field}`, { count: list.length })}
        note={
          kind === 'workflow'
            ? `${names(list)} · ${t('plugin.holds.workflowNote')}`
            : names(list, prefix)
        }
      />,
    )
  }
  if (contents.settings.length > 0) {
    lines.push(
      <Line
        key="settings"
        icon={Settings01Icon}
        title={t('plugin.holds.settings')}
        note={contents.settings
          .slice(0, 4)
          .map((setting) => setting.title)
          .join(', ')}
      />,
    )
  }
  const channels = contents.channels ?? []
  if (channels.length > 0) {
    const locale = currentLocale()
    lines.push(
      <Line
        key="channels"
        icon={Notification01Icon}
        title={t('plugin.holds.channels', { count: channels.length })}
        note={`${names(channels.map((channel) => ({ name: languageText(channel.title, locale) })))} · ${t('plugin.holds.channelsNote')}`}
      />,
    )
  }
  if (contents.views.length > 0) {
    const locale = currentLocale()
    lines.push(
      <Line
        key="views"
        icon={LayoutLeftIcon}
        title={t('plugin.holds.views', { count: contents.views.length })}
        note={`${names(contents.views.map((view) => ({ name: languageText(view.title, locale) })))} · ${t('plugin.holds.viewsNote')}`}
      />,
    )
  }
  if (contents.tools.length > 0) {
    lines.push(
      <Line
        key="tools"
        icon={Wrench01Icon}
        title={t('plugin.holds.tools', { count: contents.tools.length })}
        note={`${names(contents.tools)} · ${t('plugin.holds.toolsNote')}`}
      />,
    )
  }
  if (contents.mentions.length > 0) {
    const locale = currentLocale()
    lines.push(
      <Line
        key="mentions"
        icon={AtIcon}
        title={t('plugin.holds.mentions', { count: contents.mentions.length })}
        note={`${names(contents.mentions.map((source) => ({ name: languageText(source.title, locale) })))} · ${t('plugin.holds.mentionsNote')}`}
      />,
    )
  }
  if (contents.links.length > 0) {
    const hosts = [
      ...new Set(
        contents.links.flatMap((link) =>
          link.patterns.flatMap((pattern) => parseLinkPattern(pattern)?.host ?? []),
        ),
      ),
    ]
    lines.push(
      <Line
        key="links"
        icon={Link01Icon}
        title={t('plugin.holds.links', { count: contents.links.length })}
        note={`${names(hosts.map((host) => ({ name: host })))} · ${t('plugin.holds.linksNote')}`}
      />,
    )
  }
  const actions = contents.actions ?? []
  if (actions.length > 0) {
    const locale = currentLocale()
    lines.push(
      <Line
        key="actions"
        icon={Search01Icon}
        title={t('plugin.holds.actions', { count: actions.length })}
        note={`${names(actions.map((action) => ({ name: languageText(action.title, locale) })))} · ${t('plugin.holds.actionsNote')}`}
      />,
    )
  }
  return lines.length > 0 ? <Group heading={t('plugin.holds.heading')}>{lines}</Group> : null
}

/** Where its MCP servers connect, or what they run. */
function ConnectsLines({ contents }: { contents: PluginContents }) {
  const { t } = useTranslation('marketplace')
  if (contents.servers.length === 0) return null
  return (
    <Group heading={t('plugin.holds.connects')}>
      {contents.servers.map((server) => {
        const url = server.type === 'stdio' ? null : URL.parse(server.runs)
        return (
          <Line
            key={server.name}
            icon={PlugSocketIcon}
            title={t('plugin.holds.server', { name: server.name })}
            note={
              url
                ? t('plugin.holds.connectsTo', { host: url.host })
                : t('plugin.holds.runs', { command: server.runs })
            }
          />
        )
      })}
    </Group>
  )
}

/** The words the card's header gives under the plugin's name. */
function useByline(plan: PluginPlan, meta: PluginMeta): string {
  const { t } = useTranslation('marketplace')
  const { source, contents } = plan
  const from =
    source.kind === 'kettu'
      ? (meta.publisher ?? t('community.source'))
      : source.kind === 'github'
        ? githubShort(source.url)
        : t('plugin.install.fromFolder')
  return [from, contents.version, source.kind === 'local' ? t('plugin.install.dev') : null]
    .filter(Boolean)
    .join(' · ')
}

function ConsentHeader({
  contents,
  meta,
  title,
  line,
}: {
  contents: PluginContents
  meta: PluginMeta
  title: string
  line: string
}) {
  return (
    <SettingsDialogHeader
      title={
        <span className="k-plug-dtitle">
          <ItemTile
            subject={kettuPluginSubject({
              name: contents.name,
              official: meta.official,
              icon: contents.icon,
            })}
          />
          <span>
            {title}
            <small>{line}</small>
          </span>
        </span>
      }
    />
  )
}

/** The one card an install asks for: what it adds, where it connects, what its script may do. */
export function PluginConsent({
  plan,
  meta,
  onInstalled,
  onClose,
}: {
  plan: PluginPlan
  meta: PluginMeta
  onInstalled?: (plugin: InstalledKettuPlugin) => void
  onClose: () => void
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  const scope = useHostScope()
  const { contents } = plan
  const name = pluginTitle(contents, currentLocale())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const done = useRef(false)
  const rows = permissionRows(contents.permissions)
  const byline = useByline(plan, meta)

  const close = () => {
    // A card closed without installing gives the held package back.
    if (!done.current) discardPlan(scope, plan.token)
    onClose()
  }
  const install = async () => {
    setBusy(true)
    setError(null)
    try {
      const plugin = await installPlan(scope, plan)
      done.current = true
      onInstalled?.(plugin)
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close()
      }}
    >
      <SettingsDialogContent>
        <ConsentHeader
          contents={contents}
          meta={meta}
          title={t(plan.replaces ? 'plugin.install.replaceTitle' : 'plugin.install.title', {
            name,
          })}
          line={byline}
        />
        <SettingsDialogBody className="k-plug-body">
          {plan.blocked && (
            <p className="k-plug-problem" role="alert" data-selectable="">
              <Icon icon={Alert02Icon} size={14} />
              {plan.blocked}
            </p>
          )}
          <AddsLines contents={contents} />
          <ConnectsLines contents={contents} />
          {contents.script && (
            <Group heading={t('plugin.script.heading')} icon={SCRIPT_ICON}>
              {rows.length > 0 ? (
                rows.map((row) => <PermissionLine key={row.permission} row={row} />)
              ) : (
                <Line icon={InformationCircleIcon} title={t('plugin.script.noPermissions')} />
              )}
            </Group>
          )}
          {contents.hooks && (
            <p className="k-plug-quiet">
              <Icon icon={InformationCircleIcon} size={13} />
              {t('plugin.note.hooks')}
            </p>
          )}
          {contents.warnings.length > 0 && (
            <p className="k-plug-quiet" data-selectable="">
              <Icon icon={InformationCircleIcon} size={13} />
              {t('plugin.note.warnings', { list: contents.warnings.slice(0, 3).join('; ') })}
            </p>
          )}
          <div className="k-plug-note">
            <Icon icon={contents.script ? LockIcon : InformationCircleIcon} size={15} />
            <span>{t(contents.script ? 'plugin.note.script' : 'plugin.note.noScript')}</span>
          </div>
          {error && (
            <p className="k-plug-problem" role="alert" data-selectable="">
              <Icon icon={Alert02Icon} size={14} />
              {t('plugin.install.failed', { error })}
            </p>
          )}
        </SettingsDialogBody>
        <SettingsDialogFooter>
          <SetButton size="md" variant="ghost" disabled={busy} onClick={close}>
            {t('common:actions.cancel')}
          </SetButton>
          <SetButton
            size="md"
            variant="primary"
            loading={busy}
            disabled={plan.blocked !== null}
            onClick={() => void install()}
          >
            {t('install.submit')}
          </SetButton>
        </SettingsDialogFooter>
      </SettingsDialogContent>
    </Dialog>
  )
}

/** The permissions an update would have that the installed version does not, and the rest. */
function updateSplit(plugin: InstalledKettuPlugin): { added: string[]; unchanged: string[] } {
  const held = plugin.held
  const added = held?.permissions ?? []
  const declared = held?.declared ?? [...plugin.contents.permissions, ...added]
  return { added, unchanged: declared.filter((permission) => !added.includes(permission)) }
}

/** The card of an update that asks for more: only what is new, with the rest folded away. */
export function PluginUpdateDialog({
  plugin,
  open,
  onOpenChange,
}: {
  plugin: InstalledKettuPlugin
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['marketplace', 'common'])
  const scope = useHostScope()
  const held = plugin.held
  const [busy, setBusy] = useState<'apply' | 'stay' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showUnchanged, setShowUnchanged] = useState(false)
  const id = useId()
  if (!held) return null
  const name = pluginTitle(plugin.contents, currentLocale())
  const current = plugin.contents.version
  const next = held.version
  const { added, unchanged } = updateSplit(plugin)
  const addedRows = permissionRows(added)
  const unchangedRows = permissionRows(unchanged)
  const nowScript = held.script && plugin.contents.script === null
  const run = async (which: 'apply' | 'stay') => {
    setBusy(which)
    setError(null)
    try {
      if (which === 'apply') await applyHeldUpdate(scope, plugin)
      else await declineHeldUpdate(scope, plugin)
      onOpenChange(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value)
      }}
    >
      <SettingsDialogContent>
        <ConsentHeader
          contents={plugin.contents}
          meta={{}}
          title={
            next
              ? t('plugin.update.title', { name, version: next })
              : t('plugin.update.titleNoVersion', { name })
          }
          line={
            current
              ? t('plugin.update.line', { version: current })
              : t('plugin.update.lineNoVersion')
          }
        />
        <SettingsDialogBody className="k-plug-body">
          <Group
            heading={
              next ? t('plugin.update.newIn', { version: next }) : t('plugin.update.newInNoVersion')
            }
          >
            {nowScript && (
              <Line
                icon={SCRIPT_ICON}
                title={t('plugin.update.nowScript')}
                note={t('plugin.script.heading')}
              />
            )}
            {addedRows.map((row) => (
              <PermissionLine key={row.permission} row={row} />
            ))}
            {addedRows.length === 0 && !nowScript && (
              <Line icon={InformationCircleIcon} title={t('plugin.script.noPermissions')} />
            )}
          </Group>
          {unchangedRows.length > 0 && (
            <section className="k-plug-group">
              <button
                type="button"
                className="k-plug-fold"
                aria-expanded={showUnchanged}
                aria-controls={`${id}-unchanged`}
                onClick={() => setShowUnchanged((v) => !v)}
              >
                <span>{t('plugin.update.unchanged')}</span>
                <span className="k-plug-fold__count">
                  {t('plugin.update.unchangedCount', { count: unchangedRows.length })}
                  <Icon icon={ArrowDown01Icon} size={12} />
                </span>
              </button>
              {showUnchanged && (
                <div id={`${id}-unchanged`} className="k-mkt-list">
                  {unchangedRows.map((row) => (
                    <PermissionLine key={row.permission} row={row} />
                  ))}
                </div>
              )}
            </section>
          )}
          {error && (
            <p className="k-plug-problem" role="alert" data-selectable="">
              <Icon icon={Alert02Icon} size={14} />
              {error}
            </p>
          )}
        </SettingsDialogBody>
        <SettingsDialogFooter>
          <SetButton
            size="md"
            variant="ghost"
            loading={busy === 'stay'}
            disabled={busy !== null}
            onClick={() => void run('stay')}
          >
            {t('plugin.update.stay')}
          </SetButton>
          <SetButton
            size="md"
            variant="primary"
            loading={busy === 'apply'}
            disabled={busy !== null}
            onClick={() => void run('apply')}
          >
            {t('plugin.update.apply')}
          </SetButton>
        </SettingsDialogFooter>
      </SettingsDialogContent>
    </Dialog>
  )
}

/** Add a plugin from a GitHub address: a repository, or a folder in one. */
export function AddPluginGithubDialog({
  open,
  onOpenChange,
  install,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  install: PluginInstall
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SettingsDialogContent>
        {open && <AddPluginGithubForm install={install} onDone={() => onOpenChange(false)} />}
      </SettingsDialogContent>
    </Dialog>
  )
}

function AddPluginGithubForm({ install, onDone }: { install: PluginInstall; onDone: () => void }) {
  const { t } = useTranslation(['marketplace', 'common'])
  const id = useId()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const trimmed = url.trim()
  const ready = isGithubAddress(trimmed)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    // A failure shows as a toast, so the dialog closes only once the consent card is up.
    const shown = await install.start(
      { kind: 'github', url: trimmed },
      { onInstalled: () => setMarketplaceTab('installed') },
    )
    setBusy(false)
    if (shown) onDone()
  }
  return (
    <form onSubmit={(event) => void submit(event)}>
      <SettingsDialogHeader title={t('plugin.add.githubTitle')}>
        {t('plugin.add.githubDescription')}
      </SettingsDialogHeader>
      <SettingsDialogBody>
        <SettingsField
          label={t('plugin.add.url')}
          htmlFor={`${id}-url`}
          hint={trimmed && !ready ? t('plugin.add.urlInvalid') : t('plugin.add.urlHint')}
        >
          <input
            id={`${id}-url`}
            className={DIALOG_MONO_FIELD}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            inputMode="url"
            aria-invalid={trimmed && !ready ? true : undefined}
            placeholder={t('plugin.add.urlPlaceholder')}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </SettingsField>
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <DialogClose render={<SetButton size="md" variant="ghost" />}>
          {t('common:actions.cancel')}
        </DialogClose>
        <SetButton size="md" variant="primary" type="submit" loading={busy} disabled={!ready}>
          {t('plugin.add.githubSubmit')}
        </SetButton>
      </SettingsDialogFooter>
    </form>
  )
}
