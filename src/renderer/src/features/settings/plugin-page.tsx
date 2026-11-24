import { useState, type KeyboardEvent } from 'react'
import { PuzzleIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { PLUGIN_NOTICE_KINDS, type PluginNoticeKind } from '@shared/plugin-channels'
import type { InstalledKettuPlugin, PluginSetting, PluginSettingValue } from '@shared/plugins'
import { Icon } from '@renderer/components/affect/app-shell'
import { ConfirmDialog } from '@renderer/features/marketplace/dialogs'
import { useBusy } from '@renderer/features/marketplace/hooks'
import {
  pluginBusy,
  setPluginOn,
  uninstallPlugin,
} from '@renderer/features/marketplace/plugin-actions'
import {
  useInstalledPlugins,
  usePluginPublisher,
} from '@renderer/features/marketplace/plugin-hooks'
import {
  permissionRows,
  pluginTitle,
  scriptStateKey,
} from '@renderer/features/marketplace/plugin-model'
import { errorMessage } from '@renderer/lib/host'
import { languageText } from '@renderer/features/plugin-views/plugin-text'
import { currentLocale } from '@renderer/lib/i18n'
import { useHostScope, type HostScope } from '@renderer/stores/host-scope'
import { openSettingsItem } from '@renderer/stores/view'
import {
  ControlError,
  Pill,
  SetButton,
  SetInput,
  SettingSelect,
  SettingSwitch,
  Spin,
  DangerButton,
} from './controls'
import {
  Group,
  GroupNote,
  ItemLine,
  ItemPageHeader,
  ItemRow,
  Notice,
  RowFrame,
  RowText,
} from './rows'

/** A plugin's icon, or the puzzle piece that stands for one without. */
export function PluginMark({ plugin }: { plugin: InstalledKettuPlugin }) {
  return plugin.contents.icon ? (
    <img src={plugin.contents.icon} alt="" width={24} height={24} />
  ) : (
    <Icon icon={PuzzleIcon} size={20} />
  )
}

const isComposing = (event: KeyboardEvent<HTMLInputElement>): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229

/** Sets one of the plugin's settings; the host answers with the plugin as it is then. */
async function setValue(
  scope: HostScope,
  plugin: InstalledKettuPlugin,
  key: string,
  value: PluginSettingValue,
): Promise<string | null> {
  try {
    const next = await scope.request('plugins.setSetting', { pluginId: plugin.id, key, value })
    scope.useMarketplaceStore.getState().putPlugin(next)
    return null
  } catch (error) {
    return errorMessage(error)
  }
}

async function setSecret(
  scope: HostScope,
  plugin: InstalledKettuPlugin,
  key: string,
  value: string | null,
): Promise<string | null> {
  try {
    const next = await scope.request('plugins.setSecret', { pluginId: plugin.id, key, value })
    scope.useMarketplaceStore.getState().putPlugin(next)
    return null
  } catch (error) {
    return errorMessage(error)
  }
}

function SettingRow({ plugin, setting }: { plugin: InstalledKettuPlugin; setting: PluginSetting }) {
  const scope = useHostScope()
  const [error, setError] = useState<string | null>(null)
  const change = async (run: () => Promise<string | null>): Promise<void> => {
    setError(await run())
  }
  const stored = plugin.values?.[setting.key]
  const text = <RowText name={setting.title} description={setting.description} />
  switch (setting.type) {
    case 'boolean':
      return (
        <RowFrame id={`setting-${setting.key}`} text={text}>
          <ControlError error={error} />
          <SettingSwitch
            label={setting.title}
            checked={stored === true}
            onChange={(checked) => void change(() => setValue(scope, plugin, setting.key, checked))}
          />
        </RowFrame>
      )
    case 'select':
      return (
        <RowFrame id={`setting-${setting.key}`} text={text}>
          <ControlError error={error} />
          <SettingSelect
            label={setting.title}
            value={typeof stored === 'string' ? stored : ''}
            options={(setting.options ?? []).map((option) => ({
              value: option.value,
              label: option.title,
            }))}
            onChange={(value) => void change(() => setValue(scope, plugin, setting.key, value))}
          />
        </RowFrame>
      )
    case 'string':
      return (
        <RowFrame id={`setting-${setting.key}`} text={text}>
          <ControlError error={error} />
          <TextField
            label={setting.title}
            value={typeof stored === 'string' ? stored : ''}
            onCommit={(value) => void change(() => setValue(scope, plugin, setting.key, value))}
          />
        </RowFrame>
      )
    case 'secret':
      return (
        <RowFrame id={`setting-${setting.key}`} text={text}>
          <SecretField plugin={plugin} setting={setting} />
        </RowFrame>
      )
  }
}

/** One of the plugin's notification channels: a switch for each kind of notice it is sent. */
function ChannelGroup({
  plugin,
  channel,
}: {
  plugin: InstalledKettuPlugin
  channel: NonNullable<InstalledKettuPlugin['contents']['channels']>[number]
}) {
  const { t } = useTranslation('settings')
  const scope = useHostScope()
  const [error, setError] = useState<string | null>(null)
  const locale = currentLocale()
  const picked = plugin.channelKinds?.[channel.id] ?? []
  const description = channel.description
    ? languageText(channel.description, locale)
    : t('plugins.channels.hint')
  const pick = async (kind: PluginNoticeKind, on: boolean): Promise<void> => {
    const kinds = on ? [...picked, kind] : picked.filter((item) => item !== kind)
    try {
      const next = await scope.request('plugins.setChannelKinds', {
        pluginId: plugin.id,
        channel: channel.id,
        kinds,
      })
      scope.useMarketplaceStore.getState().putPlugin(next)
      setError(null)
    } catch (failed) {
      setError(errorMessage(failed))
    }
  }
  return (
    <Group label={languageText(channel.title, locale)} note={<GroupNote>{description}</GroupNote>}>
      {PLUGIN_NOTICE_KINDS.map((kind) => (
        <RowFrame
          key={kind}
          id={`channel-${channel.id}-${kind}`}
          text={
            <RowText
              name={t(`notifications.${kind}.name`)}
              description={t(`notifications.${kind}.description`)}
            />
          }
        >
          <SettingSwitch
            label={t(`notifications.${kind}.name`)}
            checked={picked.includes(kind)}
            onChange={(on) => void pick(kind, on)}
          />
        </RowFrame>
      ))}
      {error && <RowFrame text={<ControlError error={error} wrap />} />}
    </Group>
  )
}

/** A short text, saved when the field is left or Enter is pressed; Esc puts the old text back. */
function TextField({
  label,
  value,
  onCommit,
}: {
  label: string
  value: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft !== null && draft !== value) onCommit(draft)
    setDraft(null)
  }
  return (
    <SetInput
      aria-label={label}
      value={draft ?? value}
      spellCheck={false}
      autoComplete="off"
      className="k-input--wide"
      onFocus={() => setDraft(value)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (isComposing(event)) return
        if (event.key === 'Enter') event.currentTarget.blur()
        else if (event.key === 'Escape') {
          event.stopPropagation()
          setDraft(null)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

/** A secret shows only whether it is set; its value is typed here and never read back. */
function SecretField({
  plugin,
  setting,
}: {
  plugin: InstalledKettuPlugin
  setting: PluginSetting
}) {
  const { t } = useTranslation('settings')
  const scope = useHostScope()
  const isSet = plugin.secretsSet?.includes(setting.key) ?? false
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (value: string | null): Promise<void> => {
    setBusy(true)
    const failed = await setSecret(scope, plugin, setting.key, value)
    setBusy(false)
    setError(failed)
    if (failed === null) {
      setEditing(false)
      setDraft('')
    }
  }
  if (!editing) {
    return (
      <>
        <ControlError error={error} />
        <Pill tone={isSet ? 'success' : 'neutral'}>
          {t(isSet ? 'plugins.secret.set' : 'plugins.secret.notSet')}
        </Pill>
        {isSet && (
          <SetButton disabled={busy} onClick={() => void run(null)}>
            {t('plugins.secret.clear')}
          </SetButton>
        )}
        <SetButton onClick={() => setEditing(true)}>
          {t(isSet ? 'plugins.secret.change' : 'plugins.secret.setAction')}
        </SetButton>
      </>
    )
  }
  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault()
        if (draft !== '') void run(draft)
      }}
    >
      <ControlError error={error} />
      <SetInput
        type="password"
        autoFocus
        aria-label={setting.title}
        placeholder={t('plugins.secret.placeholder')}
        value={draft}
        autoComplete="off"
        spellCheck={false}
        disabled={busy}
        onChange={(event) => setDraft(event.target.value)}
      />
      <SetButton
        onClick={() => {
          setEditing(false)
          setDraft('')
          setError(null)
        }}
      >
        {t('plugins.secret.cancel')}
      </SetButton>
      <SetButton type="submit" variant="primary" loading={busy} disabled={draft === ''}>
        {t('plugins.secret.save')}
      </SetButton>
    </form>
  )
}

/** What the plugin's script is allowed, one line for each permission it declares, read only. */
function ScriptPermissions({ plugin }: { plugin: InstalledKettuPlugin }) {
  const { t } = useTranslation('settings')
  const { t: market } = useTranslation('marketplace')
  const rows = permissionRows(plugin.contents.permissions)
  if (!plugin.contents.script) {
    return <RowFrame text={<RowText name={t('plugins.script.none')} />} />
  }
  if (rows.length === 0) {
    return <RowFrame text={<RowText name={t('plugins.script.nothing')} />} />
  }
  return rows.map((row) => (
    <RowFrame
      key={row.permission}
      text={
        <RowText
          name={
            <>
              {market(row.nameKey as 'plugin.permission.tools.name')}
              {row.domain && <> {row.domain}</>}
            </>
          }
          description={market(row.descriptionKey as 'plugin.permission.tools.description', {
            domain: row.domain ?? undefined,
          })}
        />
      }
    >
      {row.risk === 'high' && <Pill tone="warning">{t('plugins.script.high')}</Pill>}
    </RowFrame>
  ))
}

/** One plugin's page in Settings: its settings, what its script can do, and turning it off. */
export function PluginPage({ id }: { id: string }) {
  const { t } = useTranslation('settings')
  const scope = useHostScope()
  const plugins = useInstalledPlugins()
  const publisher = usePluginPublisher()
  const busy = useBusy(pluginBusy(id))
  const [removing, setRemoving] = useState(false)
  const plugin = plugins?.find((item) => item.id === id) ?? null
  const back = (): void => openSettingsItem('plugins', null)
  if (plugins === null) return <Spin label={t('plugins.loading')} />
  if (!plugin) {
    return (
      <>
        <button type="button" onClick={back} className="k-back">
          {t('plugins.back')}
        </button>
        <Notice variant="info" title={t('plugins.notInstalled')} />
      </>
    )
  }
  const locale = currentLocale()
  const title = pluginTitle(plugin.contents, locale)
  const { settings } = plugin.contents
  return (
    <>
      <ItemPageHeader
        back={t('plugins.back')}
        onBack={back}
        item={`plugin:${plugin.id}`}
        icon={<PluginMark plugin={plugin} />}
        title={title}
        subtitle={[publisher(plugin), plugin.contents.version && `v${plugin.contents.version}`]
          .filter(Boolean)
          .join(' · ')}
      >
        {t(scriptStateKey(plugin) as 'plugins.state.off')}
      </ItemPageHeader>
      <div className="k-groups">
        <Group label={t('plugins.settings.heading')}>
          {settings.length === 0 ? (
            <RowFrame text={<RowText name={t('plugins.settings.none')} />} />
          ) : (
            settings.map((setting) => (
              <SettingRow key={setting.key} plugin={plugin} setting={setting} />
            ))
          )}
        </Group>
        {(plugin.contents.channels ?? []).map((channel) => (
          <ChannelGroup key={channel.id} plugin={plugin} channel={channel} />
        ))}
        <Group label={t('plugins.script.heading')}>
          <ScriptPermissions plugin={plugin} />
        </Group>
        <Group label={t('plugins.manage.heading')}>
          <RowFrame text={<RowText name={t('plugins.manage.enabled')} />}>
            <SettingSwitch
              label={t('plugins.manage.enabled')}
              checked={plugin.enabled}
              disabled={busy}
              onChange={(on) => void setPluginOn(scope, plugin, on)}
            />
          </RowFrame>
          <RowFrame
            text={
              <RowText
                name={t('plugins.manage.uninstallName')}
                description={t('plugins.manage.uninstallHint')}
              />
            }
          >
            <DangerButton onClick={() => setRemoving(true)}>
              {t('plugins.manage.uninstall')}
            </DangerButton>
          </RowFrame>
        </Group>
      </div>
      <UninstallDialog
        plugin={plugin}
        title={title}
        open={removing}
        onOpenChange={setRemoving}
        onRemoved={back}
      />
    </>
  )
}

function UninstallDialog({
  plugin,
  title,
  open,
  onOpenChange,
  onRemoved,
}: {
  plugin: InstalledKettuPlugin
  title: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onRemoved: () => void
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('plugin.remove.title', { name: title })}
      body={t('plugin.remove.body')}
      confirm={t('plugin.remove.confirm')}
      action={async () => {
        await uninstallPlugin(scope, plugin)
        onRemoved()
      }}
    />
  )
}

/** One installed plugin in the list, opening its page. */
export function PluginRow({
  plugin,
  title,
  publisher,
}: {
  plugin: InstalledKettuPlugin
  title: string
  publisher: string
}) {
  const { t } = useTranslation('settings')
  const count = plugin.contents.settings.length
  return (
    <ItemRow
      item={plugin.id}
      label={t('plugins.row.open', { name: title })}
      tile={<PluginMark plugin={plugin} />}
      name={title}
      right={plugin.enabled ? null : <span>{t('plugins.state.off')}</span>}
      onOpen={() => openSettingsItem('plugins', plugin.id)}
    >
      <ItemLine>
        {[
          publisher,
          plugin.contents.version && `v${plugin.contents.version}`,
          count > 0
            ? t('plugins.row.settings', { count })
            : t(scriptStateKey(plugin) as 'plugins.state.off'),
        ]
          .filter(Boolean)
          .join(' · ')}
      </ItemLine>
    </ItemRow>
  )
}
