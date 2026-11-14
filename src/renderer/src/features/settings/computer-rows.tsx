import { useState, type KeyboardEvent } from 'react'
import { BrowserIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  acceleratorKeys,
  defaultStopShortcut,
  isStopShortcut,
  type ComputerApp,
  type ComputerPermission,
  type ComputerPermissionKind,
} from '@shared/computer-use'
import { Icon } from '@renderer/components/affect/app-shell'
import { Kbd, KbdGroup } from '@renderer/components/ui/kbd'
import { errorMessage } from '@renderer/lib/host'
import { platform } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings'
import { ControlError, Pill, SetButton, SettingSwitch } from './controls'
import { ItemLine, Thing } from './rows'

/** The switch, on this computer's own settings whichever host the page shows. */
export function ComputerSwitch({ label }: { label: string }) {
  const checked = useSettingsStore((s) => s.settings.computerUse.enabled)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(enabled) => {
          setError(null)
          useSettingsStore
            .getState()
            .update({ computerUse: { enabled } })
            .catch((e: unknown) => setError(errorMessage(e)))
        }}
      />
    </>
  )
}

export function PermissionRow({
  kind,
  state,
  onChanged,
}: {
  kind: ComputerPermissionKind
  state: ComputerPermission
  onChanged: () => void
}) {
  const { t } = useTranslation('settings')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ask = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.kettu.computer.requestPermission(kind)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      onChanged()
    }
  }
  if (state === 'granted') return <Pill tone="success">{t('computer.permission.granted')}</Pill>
  return (
    <>
      <ControlError error={error} />
      <SetButton loading={busy} onClick={() => void ask()}>
        {state === 'denied' ? t('computer.permission.open') : t('computer.permission.ask')}
      </SetButton>
    </>
  )
}

export function AllowedAppRow({ app, onRemove }: { app: ComputerApp; onRemove: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <div className="ui-sg-row">
      <Thing mark={<Icon icon={BrowserIcon} size={20} />} name={app.name}>
        <ItemLine>{app.id}</ItemLine>
      </Thing>
      <SetButton onClick={onRemove}>{t('computer.allowedApps.remove')}</SetButton>
    </div>
  )
}

const KEY_NAMES: Record<string, string> = {
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Equal: '=',
  Minus: '-',
  Space: 'Space',
  Tab: 'Tab',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
}

/** The pressed keys as an Electron accelerator, by the keys' places rather than what they type. */
function acceleratorOf(event: KeyboardEvent): string | null {
  const { code } = event
  const key = /^Key[A-Z]$/.test(code)
    ? code.slice(3)
    : /^Digit[0-9]$/.test(code)
      ? code.slice(5)
      : /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)
        ? code
        : KEY_NAMES[code]
  if (!key) return null
  const parts = [
    event.ctrlKey && 'Control',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
    event.metaKey && (platform === 'darwin' ? 'Command' : 'Super'),
  ].filter((part): part is string => !!part)
  return [...parts, key].join('+')
}

/** Stop from anywhere: the shortcut's keys, which a click lets the user press anew. */
export function StopShortcut() {
  const { t } = useTranslation('settings')
  const saved = useSettingsStore((s) => s.settings.computerUse.stopShortcut)
  const fallback = defaultStopShortcut(platform)
  const shortcut = saved || fallback
  const [recording, setRecording] = useState(false)
  const [hint, setHint] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = (next: string) => {
    setError(null)
    useSettingsStore
      .getState()
      .update({ computerUse: { stopShortcut: next === fallback ? '' : next } })
      .catch((e: unknown) => setError(errorMessage(e)))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return
    event.preventDefault()
    event.stopPropagation()
    if (event.code === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      setRecording(false)
      setHint(false)
      return
    }
    const next = acceleratorOf(event)
    // Modifiers alone are on their way to a shortcut.
    if (!next) return
    if (!isStopShortcut(next)) {
      setHint(true)
      return
    }
    setRecording(false)
    setHint(false)
    save(next)
  }
  return (
    <>
      <ControlError
        error={
          error ??
          (hint
            ? t(
                platform === 'darwin'
                  ? 'computer.stopShortcut.invalidMac'
                  : 'computer.stopShortcut.invalid',
              )
            : null)
        }
      />
      <div className="flex items-center gap-2">
        {saved && saved !== fallback && !recording && (
          <SetButton variant="ghost" onClick={() => save(fallback)}>
            {t('computer.stopShortcut.reset')}
          </SetButton>
        )}
        <button
          type="button"
          aria-label={t('computer.stopShortcut.change')}
          title={t('computer.stopShortcut.change')}
          onClick={() => {
            setRecording((now) => !now)
            setHint(false)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setRecording(false)
            setHint(false)
          }}
          className={cn(
            'flex h-7 items-center rounded-md px-1 outline-none focus-ring',
            recording && 'bg-(--bg-selected)',
          )}
        >
          {recording ? (
            <span className="px-1.5 text-small text-secondary">
              {t('computer.stopShortcut.recording')}
            </span>
          ) : (
            <KbdGroup>
              {acceleratorKeys(shortcut, platform).map((key, index) => (
                <Kbd key={index}>{key}</Kbd>
              ))}
            </KbdGroup>
          )}
        </button>
      </div>
    </>
  )
}
