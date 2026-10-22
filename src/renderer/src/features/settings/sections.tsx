import { useRef, useState, type ReactNode } from 'react'
import { CircleHelpIcon, FileDownIcon, FolderOpenIcon, TrashIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LOCALES, LOCALE_NAMES, type LanguageSetting } from '@shared/locale'
import type { SettingsFile } from '@shared/settings'
import { AGENT_IDS, type AgentId } from '@shared/thread'
import { exportDiagnostics } from '@renderer/app/actions'
import { AgentMark } from '@renderer/components/agents/agent-mark'
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
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Spinner } from '@renderer/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@renderer/components/ui/toggle-group'
import { CopyButton } from '@renderer/features/git/branch-popover'
import { errorMessage, host } from '@renderer/lib/host'
import { basename } from '@renderer/lib/format'
import { fileManagerName, formatShortcut, isWindows } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { AGENT_NAMES } from '@renderer/stores/agents'
import { loadGitTools, useGitStore } from '@renderer/stores/git'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { ControlError, Segmented, SettingSelect, SettingSwitch } from './controls'
import { useApply } from './use-apply'

const useSettings = () => useSettingsStore((s) => s.settings)

// ---- General

export function Language() {
  const { t } = useTranslation('settings')
  const value = useSettings().general.language
  const [apply, error] = useApply()
  const options: { value: LanguageSetting; label: string }[] = [
    { value: 'system', label: t('general.language.system') },
    ...LOCALES.map((locale) => ({ value: locale, label: LOCALE_NAMES[locale] })),
  ]
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={t('general.language.name')}
        value={value}
        options={options}
        onChange={(v) => apply({ general: { language: v } })}
      />
    </>
  )
}

export function DefaultAgent() {
  const { t } = useTranslation('settings')
  const value = useSettings().general.defaultAgent
  const [apply, error] = useApply()
  const options = [
    {
      value: 'ask',
      label: t('general.defaultAgent.askEachTime'),
      icon: <CircleHelpIcon className="size-3.5 text-muted-foreground" />,
    },
    ...AGENT_IDS.filter((id) => id !== 'fake-agent').map((id) => ({
      value: id,
      label: AGENT_NAMES[id],
      icon: <AgentMark agent={id} className="size-3.5" />,
    })),
  ]
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={t('general.defaultAgent.name')}
        value={value ?? 'ask'}
        options={options}
        onChange={(v) => apply({ general: { defaultAgent: v === 'ask' ? null : (v as AgentId) } })}
      />
    </>
  )
}

export function GeneralSwitch({
  field,
  label,
}: {
  field: 'restoreLastSession' | 'confirmQuitWhileRunning'
  label: string
}) {
  const checked = useSettings().general[field]
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(v) => apply({ general: { [field]: v } })}
      />
    </>
  )
}

export function SendKey() {
  const { t } = useTranslation('settings')
  const value = useSettings().general.sendKey
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <Segmented
        label={t('general.sendKey.name')}
        value={value}
        options={[
          { value: 'enter', label: 'Enter' },
          { value: 'mod-enter', label: formatShortcut('Mod+Enter') },
        ]}
        onChange={(v) => apply({ general: { sendKey: v } })}
      />
    </>
  )
}

// ---- Appearance

export function ThemeTiles() {
  const { t } = useTranslation('settings')
  const value = useSettings().appearance.theme
  const [apply, error] = useApply()
  const tiles: { value: SettingsFile['appearance']['theme']; label: string }[] = [
    { value: 'system', label: t('appearance.theme.system') },
    { value: 'light', label: t('appearance.theme.light') },
    { value: 'dark', label: t('appearance.theme.dark') },
  ]
  return (
    <div className="flex items-center gap-3">
      <ControlError error={error} />
      <ToggleGroup
        aria-label={t('appearance.theme.name')}
        variant="tile"
        size="tile"
        spacing={3}
        value={[value]}
        onValueChange={(next) => {
          const picked = next[0] as SettingsFile['appearance']['theme'] | undefined
          if (picked && picked !== value) apply({ appearance: { theme: picked } })
        }}
      >
        {tiles.map((tile) => (
          <ToggleGroupItem key={tile.value} value={tile.value}>
            <ThemePreview kind={tile.value} />
            {tile.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}

/** A miniature window in the theme's own surface steps; System shows both halves. */
export function ThemePreview({ kind }: { kind: 'system' | 'light' | 'dark' }) {
  const half = (dark: boolean) => (
    <span
      className={cn(
        'flex h-full flex-1 gap-1 p-1.5',
        dark ? 'bg-[oklch(0.205_0_0)]' : 'bg-[oklch(0.982_0_0)]',
      )}
    >
      <span
        className={cn('w-3 rounded-[2px]', dark ? 'bg-[oklch(0.27_0_0)]' : 'bg-[oklch(0.93_0_0)]')}
      />
      <span className="flex flex-1 flex-col gap-1">
        <span
          className={cn(
            'h-1.5 w-3/4 rounded-full',
            dark ? 'bg-[oklch(0.4_0_0)]' : 'bg-[oklch(0.86_0_0)]',
          )}
        />
        <span
          className={cn(
            'h-1.5 w-1/2 rounded-full',
            dark ? 'bg-[oklch(0.33_0_0)]' : 'bg-[oklch(0.9_0_0)]',
          )}
        />
        <span
          className={cn('mt-auto h-2.5 rounded-[3px]', dark ? 'bg-[oklch(0.27_0_0)]' : 'bg-white')}
        />
      </span>
    </span>
  )
  return (
    <span data-tile="" aria-hidden className="flex h-[54px] w-[86px] overflow-hidden rounded-lg">
      {kind === 'light' ? (
        half(false)
      ) : kind === 'dark' ? (
        half(true)
      ) : (
        <>
          {half(false)}
          {half(true)}
        </>
      )}
    </span>
  )
}

export function TextSize() {
  const { t } = useTranslation('settings')
  const value = useSettings().appearance.textSize
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <Segmented
        label={t('appearance.textSize.name')}
        value={value}
        options={[
          { value: 'small', label: t('appearance.textSize.small') },
          { value: 'default', label: t('appearance.textSize.default') },
          { value: 'large', label: t('appearance.textSize.large') },
        ]}
        onChange={(v) => apply({ appearance: { textSize: v } })}
      />
    </>
  )
}

export function ReduceMotion() {
  const { t } = useTranslation('settings')
  const value = useSettings().appearance.reduceMotion
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <Segmented
        label={t('appearance.reduceMotion.name')}
        value={value}
        options={[
          { value: 'system', label: t('appearance.reduceMotion.system') },
          { value: 'always', label: t('appearance.reduceMotion.always') },
        ]}
        onChange={(v) => apply({ appearance: { reduceMotion: v } })}
      />
    </>
  )
}

// ---- Terminal

export function ShellPicker() {
  const { t } = useTranslation('settings')
  const shellPath = useSettings().terminal.shellPath
  const [apply, error] = useApply()
  const [pickError, setPickError] = useState<string | null>(null)
  const choose = async () => {
    setPickError(null)
    try {
      await window.overbench.dialogs.chooseShell()
    } catch (e) {
      setPickError(errorMessage(e))
    }
  }
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ControlError error={error ?? pickError} />
      <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={shellPath}>
        {shellPath
          ? basename(shellPath)
          : isWindows
            ? 'PowerShell'
            : t('terminal.shell.loginShell')}
      </span>
      {shellPath && (
        <Button
          variant="quiet"
          size="compact"
          onClick={() => apply({ terminal: { shellPath: null } })}
        >
          {t('terminal.shell.reset')}
        </Button>
      )}
      <Button variant="outline" size="compact" onClick={() => void choose()}>
        {t('terminal.shell.choose')}
      </Button>
    </div>
  )
}

export function FontSize() {
  const { t } = useTranslation('settings')
  const value = useSettings().terminal.fontSize
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <Segmented
        label={t('terminal.fontSize.name')}
        value={value}
        options={[
          { value: 12, label: '12' },
          { value: 13, label: '13' },
          { value: 14, label: '14' },
        ]}
        onChange={(v) => apply({ terminal: { fontSize: v } })}
      />
    </>
  )
}

// ---- Git

export function ToolState({
  found,
  label,
  detail,
}: {
  found: boolean
  label: string
  detail: string | null
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full', found ? 'bg-success' : 'bg-muted-foreground/50')}
      />
      {label}
      {detail && <span className="font-mono text-[11.5px]">{detail}</span>}
    </span>
  )
}

function ToolsPending() {
  const { t } = useTranslation()
  const error = useGitStore((s) => s.toolsError)
  if (!error) return <Spinner className="size-3.5 text-muted-foreground" />
  return (
    <span className="flex items-center gap-2">
      <ControlError error={error} />
      <Button variant="outline" size="compact" onClick={() => void loadGitTools()}>
        {t('actions.retry')}
      </Button>
    </span>
  )
}

export function GitTool() {
  const { t } = useTranslation('settings')
  const tools = useGitStore((s) => s.tools)
  if (!tools) return <ToolsPending />
  return tools.git.found ? (
    <ToolState found label={t('git.git.found')} detail={tools.git.version} />
  ) : (
    <ToolState found={false} label={t('git.git.notFound')} detail={null} />
  )
}

export function GhTool() {
  const { t } = useTranslation('settings')
  const tools = useGitStore((s) => s.tools)
  if (!tools) return <ToolsPending />
  const { gh } = tools
  if (gh.state === 'not-installed') {
    return (
      <a
        href="https://cli.github.com"
        target="_blank"
        rel="noreferrer"
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        {t('git.gh.install')}
      </a>
    )
  }
  if (gh.state === 'signed-out') {
    return (
      <span className="flex items-center gap-1.5">
        <span className="text-xs text-attention-text">{t('git.gh.signedOut')}</span>
        <code className="rounded-[5px] bg-muted px-1.5 py-0.5 font-mono text-[11.5px]">
          gh auth login
        </code>
        <CopyButton text="gh auth login" label={t('git.gh.copyCommand')} />
      </span>
    )
  }
  return (
    <ToolState
      found
      label={gh.account ? t('git.gh.signedInAs', { account: gh.account }) : t('git.gh.signedIn')}
      detail={gh.version}
    />
  )
}

export function BackgroundFetch() {
  const { t } = useTranslation('settings')
  const checked = useSettings().git.backgroundFetch
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={t('git.fetch.name')}
        checked={checked}
        onChange={(v) => apply({ git: { backgroundFetch: v } })}
      />
    </>
  )
}

// ---- Notifications

export function NotificationSwitch({
  field,
  label,
}: {
  field: keyof SettingsFile['notifications']
  label: string
}) {
  const checked = useSettings().notifications[field]
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(v) => apply({ notifications: { [field]: v } })}
      />
    </>
  )
}

// ---- Advanced

export function Proxy({ label }: { label: ReactNode }) {
  const { t } = useTranslation('settings')
  const proxy = useSettings().proxy
  const [apply, error] = useApply()
  const [url, setUrl] = useState(proxy.mode === 'custom' ? proxy.url : '')
  const [noProxy, setNoProxy] = useState(proxy.mode === 'custom' ? proxy.noProxy : '')
  const [invalid, setInvalid] = useState(false)
  // Custom shows its fields before any URL is saved; the setting changes once a valid URL is in.
  const [choosing, setChoosing] = useState(false)
  const custom = proxy.mode === 'custom' || choosing
  const urlInput = useRef<HTMLInputElement>(null)

  const save = () => {
    const trimmed = url.trim()
    if (!/^(https?|socks5?):\/\/[^\s]+$/i.test(trimmed)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    if (proxy.mode === 'custom' && proxy.url === trimmed && proxy.noProxy === noProxy.trim()) return
    apply({ proxy: { mode: 'custom', url: trimmed, noProxy: noProxy.trim() } })
  }

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex min-h-[28px] items-center gap-6">
        <div className="min-w-0 flex-1">{label}</div>
        <ControlError error={error} />
        <Segmented
          label={t('advanced.proxy.name')}
          value={custom ? 'custom' : 'environment'}
          options={[
            { value: 'environment', label: t('advanced.proxy.useEnvironment') },
            { value: 'custom', label: t('advanced.proxy.custom') },
          ]}
          onChange={(mode) => {
            if (mode === 'environment') {
              setChoosing(false)
              setInvalid(false)
              if (proxy.mode !== 'environment') apply({ proxy: { mode: 'environment' } })
            } else if (url.trim()) save()
            else {
              setChoosing(true)
              requestAnimationFrame(() => urlInput.current?.focus())
            }
          }}
        />
      </div>
      {custom && (
        <div className="grid animate-in grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 fade-in animation-duration-(--duration-base)">
          <label htmlFor="proxy-url" className="text-xs text-muted-foreground">
            {t('advanced.proxy.url')}
          </label>
          <Input
            ref={urlInput}
            id="proxy-url"
            value={url}
            placeholder="http://proxy.example.com:8080"
            aria-invalid={invalid}
            onChange={(e) => setUrl(e.target.value)}
            onBlur={() => (url.trim() || proxy.mode === 'custom') && save()}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            className="h-control font-mono text-xs"
          />
          <label htmlFor="proxy-no" className="text-xs text-muted-foreground">
            {t('advanced.proxy.noProxyFor')}
          </label>
          <Input
            id="proxy-no"
            value={noProxy}
            placeholder="localhost, 127.0.0.1, .internal"
            onChange={(e) => setNoProxy(e.target.value)}
            onBlur={() => url.trim() && save()}
            onKeyDown={(e) => e.key === 'Enter' && save()}
            className="h-control font-mono text-xs"
          />
          {invalid && (
            <p className="col-start-2 text-xs text-destructive">{t('advanced.proxy.invalid')}</p>
          )}
        </div>
      )}
    </div>
  )
}

export function Diagnostics() {
  const { t } = useTranslation('settings')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ path: string } | { error: string } | null>(null)
  const run = async () => {
    setBusy(true)
    setNote(null)
    try {
      const path = await exportDiagnostics()
      if (path) setNote({ path })
    } catch (e) {
      setNote({ error: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }
  const noteText =
    note && ('error' in note ? note.error : t('advanced.diagnostics.saved', { path: note.path }))
  return (
    <div className="flex min-w-0 items-center gap-2">
      {note && (
        <span
          className={cn(
            'min-w-0 truncate text-xs',
            'error' in note ? 'text-destructive' : 'text-muted-foreground',
          )}
          title={noteText ?? undefined}
        >
          {noteText}
        </span>
      )}
      <Button variant="outline" size="compact" disabled={busy} onClick={() => void run()}>
        {busy ? (
          <Spinner data-icon="inline-start" className="size-3" />
        ) : (
          <FileDownIcon data-icon="inline-start" />
        )}
        {t('advanced.diagnostics.export')}
      </Button>
    </div>
  )
}

export function DataFolder() {
  const { t } = useTranslation('settings')
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <ControlError error={error} />
      <Button
        variant="outline"
        size="compact"
        onClick={() =>
          window.overbench.shell.showDataFolder().catch((e: unknown) => setError(errorMessage(e)))
        }
      >
        <FolderOpenIcon data-icon="inline-start" />
        {t('advanced.dataFolder.show', { name: fileManagerName() })}
      </Button>
    </>
  )
}

export function RemoveAll() {
  const { t } = useTranslation(['settings', 'common'])
  const count = useSessionsStore((s) => Object.keys(s.byId).length)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    setError(null)
    try {
      await host('sessions.removeAll', undefined)
      await useSessionsStore.getState().refresh()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <>
      <ControlError error={error} />
      <Button
        variant="destructive"
        size="compact"
        disabled={count === 0}
        onClick={() => setOpen(true)}
      >
        <TrashIcon data-icon="inline-start" />
        {t('advanced.removeSessions.button')}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('advanced.removeSessions.dialogTitle', { count })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('advanced.removeSessions.dialogDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void remove()}>
              {t('advanced.removeSessions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
