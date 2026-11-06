import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  Copy01Icon,
  Globe02Icon,
  MinusSignIcon,
  PlusSignIcon,
  RefreshIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { originLabel } from '@shared/browser'
import { LOCALES, LOCALE_NAMES, type LanguageSetting } from '@shared/locale'
import {
  DEFAULT_SETTINGS,
  ZOOM_LEVELS,
  stepZoom,
  type SettingsFile,
  type ZoomStep,
} from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Icon } from '@renderer/components/affect/app-shell'
import { BrandIcon } from '@renderer/components/brand'
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
import { Kbd } from '@renderer/components/ui/kbd'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { forgetSite } from '@renderer/features/session/link-open'
import { errorMessage } from '@renderer/lib/host'
import { systemLocale } from '@renderer/lib/i18n'
import { basename } from '@renderer/lib/format'
import { fileManagerName, formatShortcut, isMac, isWeb, isWindows } from '@renderer/lib/platform'
import { useAppInfo } from '@renderer/lib/use-app-info'
import { isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { useProjectsStore } from '@renderer/stores/projects'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { loadSiteIcons, useDefaultBrowser } from '@renderer/stores/site-icons'
import { browserNotifications, notificationsProblem } from '@renderer/web/notifications'
import {
  CONFIRM,
  ControlError,
  CopyAction,
  DangerButton,
  Masked,
  PathText,
  Pill,
  RevealButton,
  Segmented,
  SetButton,
  SetInput,
  SettingSelect,
  SettingSwitch,
  Skel,
  Spin,
} from './controls'
import type { AllowedSite } from './allowed-sites'
import { BlockLine, FlashMark, GroupNote, ItemLine, Notice, Thing } from './rows'
import { useApply } from './use-apply'

/** The settings of the host the section shows, this computer's own keys among them. */
const useSettings = () => useHostScope().useSettingsStore((s) => s.settings)

// ---- General

export function Language() {
  const { t } = useTranslation('settings')
  const value = useSettings().general.language
  const [apply, error] = useApply()
  const options: { value: LanguageSetting; label: string }[] = [
    {
      value: 'system',
      label: t('general.language.systemNamed', { name: LOCALE_NAMES[systemLocale] }),
    },
    ...LOCALES.map((locale) => ({ value: locale, label: LOCALE_NAMES[locale] })),
  ]
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={t('general.language.name')}
        value={value}
        options={options}
        lead={<Icon icon={Globe02Icon} size={14} />}
        onChange={(v) => apply({ general: { language: v } })}
      />
    </>
  )
}

export function DefaultAgent() {
  const { t } = useTranslation('settings')
  const value = useSettings().general.defaultAgent
  // The fake agent is a development tool, not a choice for everyday use.
  const agents = useAgentsStore(
    useShallow((s) => usableAgents(s.order, s.byId).filter((a) => a.id !== 'fake-agent')),
  )
  const [apply, error] = useApply()
  const options = [
    { value: 'ask', label: t('general.defaultAgent.askEachTime') },
    ...agents.map((agent) => {
      const absent = !isInstalled(agent)
      const off = agent.disabled === true
      return {
        value: agent.id as string,
        label: agent.name,
        icon: <AgentMark agent={agent.id} className="size-4" />,
        disabled: absent || off,
        hint: absent ? t('harnesses.groups.notInstalled') : off ? t('agents.turnedOff') : undefined,
      }
    }),
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
  disabled,
}: {
  field: 'restoreLastSession' | 'confirmQuitWhileRunning' | 'sessionTitles' | 'background'
  label: string
  disabled?: boolean
}) {
  const checked = useSettings().general[field]
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        disabled={disabled}
        onChange={(v) => apply({ general: { [field]: v } })}
      />
    </>
  )
}

export function ConfirmLinks({ label }: { label: string }) {
  const checked = useSettings().thread.confirmLinks
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(v) => apply({ thread: { confirmLinks: v } })}
      />
    </>
  )
}

export function OpenLinksIn({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const value = useSettings().thread.openLinksIn
  const browser = useDefaultBrowser()
  const [apply, error] = useApply()
  useEffect(loadSiteIcons, [])
  return (
    <>
      <ControlError error={error} />
      <Segmented
        label={label}
        value={value}
        options={[
          { value: 'browser', label: browser.name ?? t('browser.openLinksIn.defaultBrowser') },
          { value: 'session', label: t('browser.openLinksIn.session') },
          { value: 'ask', label: t('browser.openLinksIn.ask') },
        ]}
        onChange={(v) => apply({ thread: { openLinksIn: v } })}
      />
    </>
  )
}

export function OutlineSummaries({ label }: { label: string }) {
  const checked = useSettings().thread.outlineSummaries
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(v) => apply({ thread: { outlineSummaries: v } })}
      />
    </>
  )
}

export function OpenAtLogin({ label, disabled }: { label: string; disabled: boolean }) {
  const checked = useSettings().general.openAtLogin
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        disabled={disabled}
        onChange={(v) => apply({ general: { openAtLogin: v } })}
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
          {
            value: 'mod-enter',
            label: isMac ? `${formatShortcut('Mod')} Enter` : formatShortcut('Mod+Enter'),
          },
        ]}
        onChange={(v) => apply({ general: { sendKey: v } })}
      />
    </>
  )
}

// ---- Appearance

type ColorMode = SettingsFile['appearance']['theme']

const COLOR_MODES: readonly ColorMode[] = ['system', 'light', 'dark']

/** The color mode, at the end of the Theme group's label, where search finds it as its own row. */
export function ColorMode() {
  const { t } = useTranslation('settings')
  const value = useSettings().appearance.theme
  const [apply, error] = useApply()
  return (
    <span data-setting-row="color-mode" className="k-row k-end">
      <FlashMark id="color-mode" />
      <ControlError error={error} />
      <Segmented
        label={t('appearance.colorMode.name')}
        value={value}
        options={COLOR_MODES.map((mode) => ({
          value: mode,
          label: t(`appearance.colorMode.${mode}`),
        }))}
        onChange={(v) => apply({ appearance: { theme: v } })}
      />
    </span>
  )
}

function StepButton({
  label,
  shortcut,
  disabled,
  onClick,
  children,
}: {
  label: string
  shortcut: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SetButton aria-label={label} disabled={disabled} onClick={onClick} icon={children} />
        }
      />
      <TooltipContent>
        {label}
        <Kbd>{formatShortcut(shortcut)}</Kbd>
      </TooltipContent>
    </Tooltip>
  )
}

export function Zoom() {
  const { t } = useTranslation('settings')
  const zoom = useSettings().appearance.zoom
  const [apply, error] = useApply()
  const step = (by: ZoomStep) => apply({ appearance: { zoom: stepZoom(zoom, by) } })
  return (
    <>
      <ControlError error={error} />
      <span role="group" aria-label={t('appearance.zoom.name')} className="k-end">
        <StepButton
          label={t('appearance.zoom.zoomOut')}
          shortcut="Mod+-"
          disabled={zoom === ZOOM_LEVELS[0]}
          onClick={() => step(-1)}
        >
          <Icon icon={MinusSignIcon} size={14} />
        </StepButton>
        <span aria-live="polite" className="k-zoom k-num">{`${Math.round(zoom * 100)}%`}</span>
        <StepButton
          label={t('appearance.zoom.zoomIn')}
          shortcut="Mod+="
          disabled={zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
          onClick={() => step(1)}
        >
          <Icon icon={PlusSignIcon} size={14} />
        </StepButton>
      </span>
      <SetButton
        variant="ghost"
        disabled={zoom === DEFAULT_SETTINGS.appearance.zoom}
        onClick={() => step(0)}
      >
        {t('appearance.zoom.reset')}
      </SetButton>
    </>
  )
}

/** The row draws its own line, then a paragraph of the thread at the chosen size under it. */
export function TextSize({ label }: { label: ReactNode }) {
  const { t } = useTranslation('settings')
  const value = useSettings().appearance.textSize
  const [apply, error] = useApply()
  return (
    <>
      <div className="ui-sg-row">
        {label}
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
      </div>
      {/* The thread's own prose rules, its inline code included. */}
      <p aria-hidden className="markdown k-inset text-prose">
        <Trans
          t={t}
          i18nKey="appearance.textSize.previewAgent"
          components={{ code: <code data-streamdown="inline-code" /> }}
        />
      </p>
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
  const { api } = useHostScope()
  const shellPath = useSettings().terminal.shellPath
  const [apply, error] = useApply()
  const [pickError, setPickError] = useState<string | null>(null)
  const choose = async () => {
    setPickError(null)
    try {
      await api.dialogs.chooseShell()
    } catch (e) {
      setPickError(errorMessage(e))
    }
  }
  // A program's name is mono; "Login shell" is a label and stays in the interface font.
  const isProgram = !!shellPath || isWindows
  const program = isWindows ? 'PowerShell' : t('terminal.shell.loginShell')
  return (
    <>
      <ControlError error={error ?? pickError} />
      <span title={shellPath ?? undefined} className={isProgram ? 'k-value k-mono' : 'k-value'}>
        {shellPath ?? program}
      </span>
      <SetButton onClick={() => void choose()}>{t('terminal.shell.choose')}</SetButton>
      {shellPath && (
        <SetButton variant="ghost" onClick={() => apply({ terminal: { shellPath: null } })}>
          {t('terminal.shell.reset')}
        </SetButton>
      )}
    </>
  )
}

export function FontSize({ label }: { label: ReactNode }) {
  const { t } = useTranslation('settings')
  const value = useSettings().terminal.fontSize
  const [apply, error] = useApply()
  return (
    <>
      <BlockLine text={label}>
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
      </BlockLine>
      <div aria-hidden className="k-term" style={{ fontSize: value }}>
        <div>
          <span className="k-term__path">~/code/kettu</span>{' '}
          <span className="k-term__branch">main</span> $ pnpm vitest run src/usage
        </div>
        <div>
          <span className="k-term__ok">{'\u2713'}</span> 29 passed{' '}
          <span className="k-term__faint">(1.18s)</span>
        </div>
      </div>
    </>
  )
}

// ---- Git

function ToolsPending() {
  const { t } = useTranslation()
  const { useGitStore, loadGitTools } = useHostScope()
  const error = useGitStore((s) => s.toolsError)
  if (!error) return <Spin />
  return (
    <>
      <ControlError error={error} />
      <SetButton onClick={() => void loadGitTools()}>{t('actions.retry')}</SetButton>
    </>
  )
}

export function GitTool() {
  const { t } = useTranslation('settings')
  const { useGitStore } = useHostScope()
  const tools = useGitStore((s) => s.tools)
  if (!tools) return <ToolsPending />
  const { found, version } = tools.git
  if (!found) return <Pill>{t('git.git.notFound')}</Pill>
  return (
    <>
      {version && (
        <span className="k-mono k-muted" data-selectable="">
          {version}
        </span>
      )}
      <Pill tone="success">{t('git.git.found')}</Pill>
    </>
  )
}

// i18next fills a value with this, so the sentence can be split where the value goes, to mark it up.
const SLOT = '\uE001'

export function GhTool() {
  const { t } = useTranslation('settings')
  const { useGitStore } = useHostScope()
  const tools = useGitStore((s) => s.tools)
  if (!tools) return <ToolsPending />
  const { gh } = tools
  if (gh.state === 'not-installed') {
    return (
      <a href="https://cli.github.com" target="_blank" rel="noreferrer" className="k-link">
        {t('git.gh.install')}
      </a>
    )
  }
  if (gh.state === 'signed-out') {
    return (
      <>
        <code className="k-code">gh auth login</code>
        <CopyAction text="gh auth login" label={t('git.gh.copyCommand')} />
        <Pill tone="warning">{t('git.gh.signedOut')}</Pill>
      </>
    )
  }
  const [before = '', after = ''] = gh.account
    ? t('git.gh.signedInAs', { account: SLOT }).split(SLOT)
    : [t('git.gh.signedIn')]
  return (
    <>
      <span className="k-value" title={gh.version ? `gh ${gh.version}` : undefined}>
        {before}
        {gh.account && <Masked>{gh.account}</Masked>}
        {after}
      </span>
      <Pill tone="success">{t('git.gh.ready')}</Pill>
    </>
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

// i18next fills {{command}} with this, so the command can be set in mono around it.
const COMMAND_MARK = '\uE000'

export function NotificationPreview() {
  const { t } = useTranslation('settings')
  const [before = '', after = ''] = t('notifications.previewBody', {
    command: COMMAND_MARK,
  }).split(COMMAND_MARK)
  return (
    <div className="k-notify">
      <div aria-hidden className="k-notify__mock">
        <BrandIcon size={32} />
        <div className="k-notify__text">
          <span className="k-notify__top">
            <b>{t('notifications.previewTitle')}</b>
            <small>{t('notifications.previewTime')}</small>
          </span>
          <small>
            {before}
            pnpm vitest run src/usage
            {after}
          </small>
        </div>
      </div>
      <TestNotification />
    </div>
  )
}

// How long the test button shows that the notification went out.
const SENT_MS = 2000

/** In a browser: why it shows no notifications, if it shows none, and that they need the page open. */
export function WebNotificationsNote() {
  const { t } = useTranslation('web')
  const problem = notificationsProblem(browserNotifications())
  return (
    <>
      {problem && <GroupNote>{t(`notifications.${problem}`)}</GroupNote>}
      <GroupNote>{t('notifications.openOnly')}</GroupNote>
    </>
  )
}

export function TestNotification() {
  const { t } = useTranslation(['settings', 'web'])
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  // A browser says why: the page is on plain http, or its notifications are blocked.
  const unsupportedText = (): string => {
    const problem = isWeb ? notificationsProblem(browserNotifications()) : null
    return problem ? t(`web:notifications.${problem}`) : t('notifications.testUnsupported')
  }
  const run = async () => {
    setBusy(true)
    setSent(false)
    setUnsupported(false)
    setError(null)
    try {
      const shown = await window.kettu.notifications.test()
      setUnsupported(!shown)
      if (shown) {
        setSent(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setSent(false), SENT_MS)
      }
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {unsupported && (
        <span role="status" className="k-error k-muted">
          {unsupportedText()}
        </span>
      )}
      <span role="status" className="sr-only">
        {sent ? t('notifications.sent') : ''}
      </span>
      <ControlError error={error} />
      <SetButton
        loading={busy}
        title={unsupported ? unsupportedText() : undefined}
        icon={sent ? <Icon icon={Tick02Icon} size={14} /> : undefined}
        onClick={() => void run()}
      >
        {t('notifications.test')}
      </SetButton>
    </>
  )
}

// ---- Advanced

const isComposing = (event: KeyboardEvent<HTMLInputElement>): boolean =>
  event.nativeEvent.isComposing || event.keyCode === 229

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
  const inUse = proxy.mode === 'custom'
  const urlInput = useRef<HTMLInputElement>(null)
  const noteId = useId()

  const save = () => {
    const trimmed = url.trim()
    if (!/^(https?|socks[45]?):\/\/[^\s]+$/i.test(trimmed)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    if (proxy.mode === 'custom' && proxy.url === trimmed && proxy.noProxy === noProxy.trim()) return
    apply({ proxy: { mode: 'custom', url: trimmed, noProxy: noProxy.trim() } })
  }

  const choose = (mode: 'environment' | 'custom') => {
    if (mode === 'environment') {
      setChoosing(false)
      setInvalid(false)
      if (proxy.mode !== 'environment') apply({ proxy: { mode: 'environment' } })
    } else if (url.trim()) save()
    else {
      setChoosing(true)
      requestAnimationFrame(() => urlInput.current?.focus())
    }
  }
  const note = invalid ? 'advanced.proxy.invalid' : inUse ? null : 'advanced.proxy.environmentNote'
  return (
    <>
      <BlockLine text={label}>
        <ControlError error={error} />
        <Segmented
          label={t('advanced.proxy.name')}
          value={custom ? 'custom' : 'environment'}
          options={[
            { value: 'environment', label: t('advanced.proxy.useEnvironment') },
            { value: 'custom', label: t('advanced.proxy.custom') },
          ]}
          onChange={choose}
        />
      </BlockLine>
      {custom && (
        <div className="k-subrows ui-ss-rise">
          <label className="k-subrow">
            <span className="ui-sg-label">
              <b>{t('advanced.proxy.url')}</b>
            </span>
            <SetInput
              ref={urlInput}
              value={url}
              placeholder="http://proxy.example.com:8080"
              spellCheck={false}
              aria-invalid={invalid || undefined}
              aria-describedby={note ? noteId : undefined}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => (url.trim() || proxy.mode === 'custom') && save()}
              onKeyDown={(e) => e.key === 'Enter' && !isComposing(e) && save()}
              className="k-input--wide"
            />
          </label>
          <label className="k-subrow">
            <span className="ui-sg-label">
              <b>{t('advanced.proxy.noProxyFor')}</b>
            </span>
            <SetInput
              value={noProxy}
              placeholder="localhost, 127.0.0.1, .internal"
              spellCheck={false}
              onChange={(e) => setNoProxy(e.target.value)}
              onBlur={() => url.trim() && save()}
              onKeyDown={(e) => e.key === 'Enter' && !isComposing(e) && save()}
              className="k-input--wide"
            />
          </label>
          {/* Mounted while the fields show, so a screen reader hears each change of its text. */}
          <p id={noteId} role="status" className="k-subnote" data-invalid={invalid || undefined}>
            {note && t(note)}
          </p>
        </div>
      )}
    </>
  )
}

export function Diagnostics({ label }: { label: ReactNode }) {
  const { t } = useTranslation('settings')
  const { request } = useHostScope()
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ path: string } | { error: string } | null>(null)
  const run = async () => {
    setBusy(true)
    setNote(null)
    try {
      // Saved on this computer, wherever the host it describes is.
      const path = await window.kettu.diagnostics.save(
        await request('diagnostics.collect', undefined),
      )
      if (path) setNote({ path })
    } catch (e) {
      setNote({ error: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="k-line">
      <div className="k-grow">
        {label}
        {note &&
          ('error' in note ? (
            <p role="alert" className="k-error" data-wrap="">
              {note.error}
            </p>
          ) : (
            <SavedTo path={note.path} />
          ))}
      </div>
      <SetButton
        loading={busy}
        aria-label={t('advanced.diagnostics.export')}
        onClick={() => void run()}
      >
        {t('advanced.diagnostics.exportShort')}
      </SetButton>
    </div>
  )
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export function LogsFolderActions() {
  const { t } = useTranslation('settings')
  const path = useAppInfo()?.logsPath
  if (!path) return null
  return (
    <>
      <RevealButton path={path} />
      <CopyButton text={path} label={t('advanced.dataFolder.copy')} />
    </>
  )
}

/** Copies `text` from a labelled row button; its icon turns into a check for a moment. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <SetButton
      icon={<Icon icon={copied ? Tick02Icon : Copy01Icon} size={14} />}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {label}
    </SetButton>
  )
}

export function DetailedRecords({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const until = useSettings().diagnostics.verboseUntil
  const [apply, error] = useApply()
  const [now, setNow] = useState(() => Date.now())
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const on = until !== null && until > now
  useEffect(() => {
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [on])
  const remove = () => {
    setDeleteError(null)
    window.kettu.diagnostics.clearVerbose().then(
      () => toast(t('advanced.detailedRecords.deleted')),
      (e: unknown) => setDeleteError(errorMessage(e)),
    )
  }
  return (
    <>
      <ControlError error={error ?? deleteError} />
      {on ? (
        <span className="k-value k-num">
          {t('advanced.detailedRecords.left', { count: Math.ceil((until - now) / HOUR_MS) })}
        </span>
      ) : (
        <SetButton variant="ghost" onClick={remove}>
          {t('advanced.detailedRecords.delete')}
        </SetButton>
      )}
      <SettingSwitch
        label={label}
        checked={on}
        onChange={(value) => {
          const at = Date.now()
          setNow(at)
          apply({ diagnostics: { verboseUntil: value ? at + DAY_MS : null } })
        }}
      />
    </>
  )
}

/** Where the diagnostics file went, and the way to it. */
function SavedTo({ path }: { path: string }) {
  const { t } = useTranslation('settings')
  const [error, setError] = useState<string | null>(null)
  const [before, after] = t('advanced.diagnostics.saved', { path: SLOT }).split(SLOT)
  return (
    <div role="status" className="k-saved">
      <span className="flex max-w-full min-w-0 items-center whitespace-pre">
        {before}
        <PathText path={path} />
        {after}
      </span>
      {/* A browser saves the file among its downloads, which it shows itself. */}
      {!isWeb && (
        <button
          type="button"
          className="k-link"
          onClick={() => {
            setError(null)
            window.kettu.shell.showItem(path).catch((e: unknown) => setError(errorMessage(e)))
          }}
        >
          {t('agents.showIn', { name: fileManagerName() })}
        </button>
      )}
      <ControlError error={error} />
    </div>
  )
}

/** The data folder's line: the folder itself, in mono. */
export function DataFolderText() {
  const path = useAppInfo()?.userDataPath
  return path ? (
    <span title={path} data-selectable="" className="k-mono k-rtl">
      {'\u200E'}
      {path}
      {'\u200E'}
    </span>
  ) : (
    <Skel width={192} />
  )
}

export function DataFolderActions() {
  const { t } = useTranslation('settings')
  const path = useAppInfo()?.userDataPath
  if (!path) return null
  return (
    <>
      <RevealButton path={path} />
      <CopyAction text={path} label={t('advanced.dataFolder.copy')} />
    </>
  )
}

export function ClearBrowsingData() {
  const { t } = useTranslation(['settings', 'common'])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clear = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.kettu.browser.clearData()
      toast(t('browser.clearData.cleared'))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <ControlError error={error} />
      <SetButton loading={busy} onClick={() => setOpen(true)}>
        {t('browser.clearData.button')}
      </SetButton>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('browser.clearData.dialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('browser.clearData.dialogDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void clear()
                setOpen(false)
              }}
            >
              {t('browser.clearData.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** A site in Always allowed: its address, the projects that allow it, and Remove. */
export function AllowedSiteRow({ site, onRemove }: { site: AllowedSite; onRemove: () => void }) {
  const { t } = useTranslation('settings')
  const projects = useProjectsStore((s) => s.projects)
  const names = site.projects.map(
    (path) => projects.find((project) => project.path === path)?.name ?? basename(path),
  )
  const removing = site.removing
  return (
    <div className="ui-sg-row">
      <Thing mark={<Icon icon={Globe02Icon} size={20} />} name={originLabel(site.origin)}>
        <ItemLine>{t('browser.allowedSites.in', { projects: names.join(', ') })}</ItemLine>
      </Thing>
      <SetButton loading={removing} onClick={onRemove}>
        {t('browser.allowedSites.remove')}
      </SetButton>
    </div>
  )
}

/** In place of the sites while they are read, when reading them failed, or when there are none. */
export function AllowedSitesState({
  loading,
  error,
  onRetry,
}: {
  loading: boolean
  error?: string | null
  onRetry?: () => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  if (error) {
    return (
      <Notice
        variant="error"
        className="k-notice--row"
        title={t('browser.allowedSites.readFailed')}
        action={
          onRetry && (
            <SetButton icon={<Icon icon={RefreshIcon} size={14} />} onClick={onRetry}>
              {t('common:actions.retry')}
            </SetButton>
          )
        }
      >
        <span className="k-mono" data-selectable="">
          {error}
        </span>
      </Notice>
    )
  }
  if (loading) {
    return (
      <div className="k-block">
        <Skel width={160} />
        <Skel width={128} />
      </div>
    )
  }
  return <p className="ui-ss-empty">{t('browser.allowedSites.empty')}</p>
}

/** The sites the "Open link?" dialog was told to always open in one place, and where. */
export function RememberedSitesList({ label }: { label: ReactNode }) {
  const { t } = useTranslation('settings')
  const { useSettingsStore } = useHostScope()
  const sites = useSettings().thread.alwaysOpenIn
  const browser = useDefaultBrowser()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(loadSiteIcons, [])

  const remove = async (site: string) => {
    setBusy(site)
    setError(null)
    try {
      const { settings, update } = useSettingsStore.getState()
      await update({ thread: { alwaysOpenIn: forgetSite(settings.thread.alwaysOpenIn, site) } })
      toast(t('browser.rememberedSites.removed', { site }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const entries = Object.entries(sites)
  return (
    <>
      <BlockLine text={label}>
        <ControlError error={error} />
      </BlockLine>
      {entries.length === 0 && <p className="k-muted">{t('browser.rememberedSites.empty')}</p>}
      {entries.length > 0 && (
        <div className="k-inset k-list">
          {entries.map(([site, destination]) => (
            <div key={site} className="k-list__row">
              <span className="k-list__name">{site}</span>
              <span className="k-muted">
                {destination === 'session'
                  ? t('browser.openLinksIn.session')
                  : (browser.name ?? t('browser.openLinksIn.defaultBrowser'))}
              </span>
              <SetButton
                variant="ghost"
                loading={busy === site}
                disabled={busy !== null && busy !== site}
                onClick={() => void remove(site)}
              >
                {t('browser.rememberedSites.remove')}
              </SetButton>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

export function RemoveAll() {
  const { t } = useTranslation(['settings', 'common'])
  const { hostId, request } = useHostScope()
  const count = useSessionsStore(
    (s) => Object.values(s.byId).filter((summary) => hostOfSession(summary) === hostId).length,
  )
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await request('sessions.removeAll', undefined)
      useSessionsStore.getState().setAll(await request('sessions.list', {}), hostId)
      toast(t('advanced.removeSessions.removed'))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <ControlError error={error} />
      <DangerButton busy={busy} disabled={count === 0} onClick={() => setOpen(true)}>
        {t('advanced.removeSessions.button')}
      </DangerButton>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className={CONFIRM}>
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
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                void remove()
                setOpen(false)
              }}
            >
              {t('advanced.removeSessions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
