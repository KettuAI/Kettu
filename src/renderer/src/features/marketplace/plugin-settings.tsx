// A plugin's settings and the notices it is sent, as its page in the Marketplace draws them: a row
// for each setting, a switch for each kind of notice. Each change goes to the host, which answers
// with the plugin as it is then.

import { useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { PLUGIN_NOTICE_KINDS, type PluginNoticeKind } from '@shared/plugin-channels'
import type { InstalledKettuPlugin, PluginSetting, PluginSettingValue } from '@shared/plugins'
import {
  ControlError,
  Pill,
  SetButton,
  SetInput,
  SettingSelect,
  SettingSwitch,
} from '@renderer/features/settings/controls'
import { RowFrame, RowText } from '@renderer/features/settings/rows'
import { errorMessage } from '@renderer/lib/host'
import { useHostScope, type HostScope } from '@renderer/stores/host-scope'
import { settingRow } from './plugin-model'

type Channel = NonNullable<InstalledKettuPlugin['contents']['channels']>[number]

const isComposing = (event: KeyboardEvent<HTMLInputElement>): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229

/** Runs one change on the host and keeps the plugin it answers with; the error when it fails. */
async function put(
  scope: HostScope,
  run: () => Promise<InstalledKettuPlugin>,
): Promise<string | null> {
  try {
    scope.useMarketplaceStore.getState().putPlugin(await run())
    return null
  } catch (error) {
    return errorMessage(error)
  }
}

/** One of the plugin's settings. `focus` puts the caret in it, as when it is the first missing. */
export function PluginSettingRow({
  plugin,
  setting,
  focus = false,
}: {
  plugin: InstalledKettuPlugin
  setting: PluginSetting
  focus?: boolean
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const [error, setError] = useState<string | null>(null)
  const set = (value: PluginSettingValue): void => {
    void put(scope, () =>
      scope.request('plugins.setSetting', { pluginId: plugin.id, key: setting.key, value }),
    ).then(setError)
  }
  const stored = plugin.values?.[setting.key]
  const text = (
    <RowText
      name={
        <>
          {setting.title}
          {setting.required && <span className="k-plug-required">{t('plugin.page.required')}</span>}
        </>
      }
      description={setting.description}
    />
  )
  const id = settingRow(setting.key)
  switch (setting.type) {
    case 'boolean':
      return (
        <RowFrame id={id} text={text}>
          <ControlError error={error} />
          <SettingSwitch label={setting.title} checked={stored === true} onChange={set} />
        </RowFrame>
      )
    case 'select':
      return (
        <RowFrame id={id} text={text}>
          <ControlError error={error} />
          <SettingSelect
            label={setting.title}
            value={typeof stored === 'string' ? stored : ''}
            options={(setting.options ?? []).map((option) => ({
              value: option.value,
              label: option.title,
            }))}
            onChange={set}
          />
        </RowFrame>
      )
    case 'string':
      return (
        <RowFrame id={id} text={text}>
          <ControlError error={error} />
          <TextField
            label={setting.title}
            value={typeof stored === 'string' ? stored : ''}
            focus={focus}
            onCommit={set}
          />
        </RowFrame>
      )
    case 'secret':
      return (
        <RowFrame id={id} text={text}>
          <SecretField plugin={plugin} setting={setting} focus={focus} />
        </RowFrame>
      )
  }
}

/** A short text, saved when the field is left or Enter is pressed; Esc puts the old text back. */
function TextField({
  label,
  value,
  focus,
  onCommit,
}: {
  label: string
  value: string
  focus: boolean
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
      autoFocus={focus}
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
  focus,
}: {
  plugin: InstalledKettuPlugin
  setting: PluginSetting
  focus: boolean
}) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const isSet = plugin.secretsSet?.includes(setting.key) ?? false
  // A secret the page asks for first opens ready to paste into.
  const [editing, setEditing] = useState(focus && !isSet)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (value: string | null): Promise<void> => {
    setBusy(true)
    const failed = await put(scope, () =>
      scope.request('plugins.setSecret', { pluginId: plugin.id, key: setting.key, value }),
    )
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
          {t(isSet ? 'plugin.secret.set' : 'plugin.secret.notSet')}
        </Pill>
        {isSet && (
          <SetButton disabled={busy} onClick={() => void run(null)}>
            {t('plugin.secret.clear')}
          </SetButton>
        )}
        <SetButton onClick={() => setEditing(true)}>
          {t(isSet ? 'plugin.secret.change' : 'plugin.secret.setAction')}
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
        placeholder={t('plugin.secret.placeholder')}
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
        {t('plugin.secret.cancel')}
      </SetButton>
      <SetButton type="submit" variant="primary" loading={busy} disabled={draft === ''}>
        {t('plugin.secret.save')}
      </SetButton>
    </form>
  )
}

/** The kinds of notice the user sends to one of the plugin's channels, a switch for each. */
export function ChannelRows({
  plugin,
  channel,
}: {
  plugin: InstalledKettuPlugin
  channel: Channel
}) {
  const { t } = useTranslation('settings')
  const scope = useHostScope()
  const [error, setError] = useState<string | null>(null)
  const picked = plugin.channelKinds?.[channel.id] ?? []
  const pick = (kind: PluginNoticeKind, on: boolean): void => {
    const kinds = on ? [...picked, kind] : picked.filter((item) => item !== kind)
    void put(scope, () =>
      scope.request('plugins.setChannelKinds', { pluginId: plugin.id, channel: channel.id, kinds }),
    ).then(setError)
  }
  return (
    <>
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
            onChange={(on) => pick(kind, on)}
          />
        </RowFrame>
      ))}
      {error && <RowFrame text={<ControlError error={error} wrap />} />}
    </>
  )
}
