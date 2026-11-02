import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  CheckIcon,
  CircleAlertIcon,
  GlobeIcon,
  MinusIcon,
  PlusIcon,
  RotateCwIcon,
} from 'lucide-react'
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
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Kbd } from '@renderer/components/ui/kbd'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage } from '@renderer/lib/host'
import { systemLocale } from '@renderer/lib/i18n'
import { basename } from '@renderer/lib/format'
import { fileManagerName, formatShortcut, isMac, isWeb, isWindows } from '@renderer/lib/platform'
import { useAppInfo } from '@renderer/lib/use-app-info'
import { cn } from '@renderer/lib/utils'
import { isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { useProjectsStore } from '@renderer/stores/projects'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { browserNotifications, notificationsProblem } from '@renderer/web/notifications'
import {
  CONFIRM,
  ControlError,
  CopyAction,
  Masked,
  GROUP_ACTION,
  PathText,
  Pill,
  RevealButton,
  ROW_BUTTON,
  ROW_FIELD,
  Segmented,
  SettingSelect,
  SettingSwitch,
} from './controls'
import type { AllowedSite } from './allowed-sites'
import { DeviceTile } from './remote-parts'
import { FlashMark, GroupNote, ItemLine, Notice } from './rows'
import { useApply } from './use-apply'

/** The settings of the host the section shows, this computer's own keys among them. */
const useSettings = () => useHostScope().useSettingsStore((s) => s.settings)

// A block row's first line: the row's text on the left, its control on the right.
const BLOCK_LINE = 'flex items-center gap-x-7 gap-y-3'

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
        onChange={(v) => apply({ general: { language: v } })}
      />
    </>
  )
}

export function DefaultAgent() {
  const { t } = useTranslation('settings')
  const value = useSettings().general.defaultAgent
  // A hidden default agent stays listed while it is the one chosen, so the choice still reads.
  const agents = useAgentsStore(
    useShallow((s) =>
      usableAgents(s.order, s.byId).filter(
        (a) => a.id !== 'fake-agent' && (!a.hidden || a.id === value),
      ),
    ),
  )
  const [apply, error] = useApply()
  const options = [
    { value: 'ask', label: t('general.defaultAgent.askEachTime') },
    ...agents.map((agent) => {
      const absent = !isInstalled(agent)
      return {
        value: agent.id as string,
        label: agent.name,
        icon: <AgentMark agent={agent.id} className="size-3.5" />,
        disabled: absent,
        hint: absent ? t('harnesses.groups.notInstalled') : undefined,
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
    <span data-setting-row="color-mode" className="relative mr-0.5 flex items-center gap-2">
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

// Reads the toggle it sits in: a thick ring around a light center while that toggle is pressed.
export function RadioDot() {
  return (
    <span
      aria-hidden
      className="grid size-3.5 shrink-0 place-items-center rounded-full bg-surface ring-1 ring-border-strong transition-colors duration-(--duration-fast) ring-inset group-aria-pressed/toggle:bg-primary group-aria-pressed/toggle:ring-0"
    >
      <span className="size-1.25 scale-0 rounded-full bg-surface transition-transform duration-(--duration-fast) group-aria-pressed/toggle:scale-100" />
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
          <Button
            variant="quiet"
            size="icon-xs"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className="size-7 rounded-segment text-secondary hover:bg-hover hover:text-primary disabled:opacity-40 [&_svg:not([class*='size-'])]:size-3.5"
          />
        }
      >
        {children}
      </TooltipTrigger>
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
    <div className="flex items-center gap-2">
      <ControlError error={error} />
      <div
        role="group"
        aria-label={t('appearance.zoom.name')}
        className="inline-flex items-center gap-0.5 rounded-segments bg-surface p-0.5 shadow-outline"
      >
        <StepButton
          label={t('appearance.zoom.zoomOut')}
          shortcut="Mod+-"
          disabled={zoom === ZOOM_LEVELS[0]}
          onClick={() => step(-1)}
        >
          <MinusIcon />
        </StepButton>
        <span
          aria-live="polite"
          className="min-w-12 text-center text-control text-primary tabular-nums"
        >{`${Math.round(zoom * 100)}%`}</span>
        <StepButton
          label={t('appearance.zoom.zoomIn')}
          shortcut="Mod+="
          disabled={zoom === ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
          onClick={() => step(1)}
        >
          <PlusIcon />
        </StepButton>
      </div>
      <Button
        variant="ghost"
        className={ROW_BUTTON}
        disabled={zoom === DEFAULT_SETTINGS.appearance.zoom}
        onClick={() => step(0)}
      >
        {t('appearance.zoom.reset')}
      </Button>
    </div>
  )
}

/** The row draws its own line, then a paragraph of the thread at the chosen size under it. */
export function TextSize({ label }: { label: ReactNode }) {
  const { t } = useTranslation('settings')
  const value = useSettings().appearance.textSize
  const [apply, error] = useApply()
  return (
    <>
      <div
        className={cn(
          BLOCK_LINE,
          'py-3.75 shadow-[inset_0_calc(-1*var(--hairline))_0_var(--border-subtle)]',
        )}
      >
        <div className="min-w-0 flex-1">{label}</div>
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
      <p aria-hidden className="markdown mb-3.75 rounded-2xl bg-subtle px-3.5 py-3 text-prose">
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
      <span
        title={shellPath ?? undefined}
        className={cn(
          'max-w-56 min-w-0 truncate text-tertiary',
          isProgram ? 'font-mono text-code' : 'text-lede',
        )}
      >
        {shellPath ?? program}
      </span>
      <Button className={ROW_BUTTON} variant="outline" onClick={() => void choose()}>
        {t('terminal.shell.choose')}
      </Button>
      {shellPath && (
        <Button
          variant="ghost"
          className={GROUP_ACTION}
          onClick={() => apply({ terminal: { shellPath: null } })}
        >
          {t('terminal.shell.reset')}
        </Button>
      )}
    </>
  )
}

export function FontSize({ label }: { label: ReactNode }) {
  const { t } = useTranslation('settings')
  const value = useSettings().terminal.fontSize
  const [apply, error] = useApply()
  return (
    <div className="flex w-full flex-col gap-3">
      <div className={BLOCK_LINE}>
        <div className="min-w-0 flex-1">{label}</div>
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
      </div>
      <div
        aria-hidden
        className="overflow-hidden rounded-segments bg-code-block px-3.5 py-3 font-mono leading-[1.6] shadow-[inset_0_0_0_var(--hairline)_var(--border-default)]"
        style={{ fontSize: value }}
      >
        <div className="whitespace-pre">
          <span className="text-attention">~/code/kettu</span>{' '}
          <span className="text-merged">main</span> $ pnpm vitest run src/usage
        </div>
        <div className="whitespace-pre">
          <span className="text-success">{'\u2713'}</span> 29 passed{' '}
          <span className="text-tertiary">(1.18s)</span>
        </div>
      </div>
    </div>
  )
}

// ---- Git

function ToolsPending() {
  const { t } = useTranslation()
  const { useGitStore, loadGitTools } = useHostScope()
  const error = useGitStore((s) => s.toolsError)
  if (!error) return <Spinner className="size-3.5 text-tertiary" />
  return (
    <span className="flex items-center gap-2">
      <ControlError error={error} />
      <Button className={ROW_BUTTON} variant="outline" onClick={() => void loadGitTools()}>
        {t('actions.retry')}
      </Button>
    </span>
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
        <span className="font-mono text-code text-tertiary" data-selectable="">
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
      <a
        href="https://cli.github.com"
        target="_blank"
        rel="noreferrer"
        className="rounded-sm text-lede text-secondary underline decoration-border-strong underline-offset-3 outline-none hover:text-primary focus-ring"
      >
        {t('git.gh.install')}
      </a>
    )
  }
  if (gh.state === 'signed-out') {
    return (
      <span className="flex items-center gap-2">
        <code className="rounded-md bg-subtle px-1.5 py-0.5 font-mono text-code">
          gh auth login
        </code>
        <CopyAction text="gh auth login" label={t('git.gh.copyCommand')} />
        <Pill tone="warning">{t('git.gh.signedOut')}</Pill>
      </span>
    )
  }
  const [before = '', after = ''] = gh.account
    ? t('git.gh.signedInAs', { account: SLOT }).split(SLOT)
    : [t('git.gh.signedIn')]
  return (
    <>
      <span
        className="text-lede text-secondary has-data-[slot=masked]:-me-1.5"
        title={gh.version ? `gh ${gh.version}` : undefined}
      >
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
    <div className="flex items-center gap-6 py-4.5">
      <div
        aria-hidden
        className="flex w-90 max-w-full shrink-0 gap-3 rounded-dialog bg-tray px-3.5 py-3 shadow-[0_0_0_var(--hairline)_var(--border-subtle),var(--elevation-float)]"
      >
        <BrandIcon size={34} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-control">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-semibold">
              {t('notifications.previewTitle')}
            </span>
            <span className="shrink-0 text-meta text-tertiary">
              {t('notifications.previewTime')}
            </span>
          </div>
          <span className="truncate text-secondary">
            {before}
            pnpm vitest run src/usage
            {after}
          </span>
        </div>
      </div>
      <span className="text-group leading-normal text-tertiary">
        {t(isWeb ? 'notifications.footerWeb' : 'notifications.footer')}
      </span>
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
        <span role="status" className="text-xs text-secondary">
          {unsupportedText()}
        </span>
      )}
      <span role="status" className="sr-only">
        {sent ? t('notifications.sent') : ''}
      </span>
      <ControlError error={error} />
      <Button
        variant="outline"
        disabled={busy}
        title={unsupported ? unsupportedText() : undefined}
        onClick={() => void run()}
        className={ROW_BUTTON}
      >
        {busy ? (
          <Spinner data-icon="inline-start" className="size-3.5" />
        ) : (
          sent && <CheckIcon data-icon="inline-start" className="text-success" />
        )}
        {t('notifications.test')}
      </Button>
    </>
  )
}

// ---- Advanced

// A custom proxy's field, as a row of its own under Proxy.
const PROXY_ROW =
  'flex min-h-15.5 items-center gap-7 pl-8 shadow-[inset_0_var(--hairline)_0_var(--border-subtle)]'

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
    <div className="flex w-full flex-col">
      <div className={BLOCK_LINE}>
        <div className="min-w-0 flex-1">{label}</div>
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
      </div>
      {custom && (
        <div className="-mb-3.75 mt-3.75 flex animate-in flex-col fade-in animation-duration-(--duration-base)">
          <label className={PROXY_ROW}>
            <span className="flex-1 text-label">{t('advanced.proxy.url')}</span>
            <Input
              ref={urlInput}
              value={url}
              placeholder="http://proxy.example.com:8080"
              spellCheck={false}
              aria-invalid={invalid || undefined}
              aria-describedby={note ? noteId : undefined}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => (url.trim() || proxy.mode === 'custom') && save()}
              onKeyDown={(e) => e.key === 'Enter' && !isComposing(e) && save()}
              className={cn(ROW_FIELD, 'w-65 md:text-lede')}
            />
          </label>
          <label className={PROXY_ROW}>
            <span className="flex-1 text-label">{t('advanced.proxy.noProxyFor')}</span>
            <Input
              value={noProxy}
              placeholder="localhost, 127.0.0.1, .internal"
              spellCheck={false}
              onChange={(e) => setNoProxy(e.target.value)}
              onBlur={() => url.trim() && save()}
              onKeyDown={(e) => e.key === 'Enter' && !isComposing(e) && save()}
              className={cn(ROW_FIELD, 'w-65 md:text-lede')}
            />
          </label>
          {/* Mounted while the fields show, so a screen reader hears each change of its text. */}
          <p
            id={noteId}
            role="status"
            className={cn(
              'pl-8 text-hint',
              note && 'pb-3.75',
              invalid ? 'text-danger' : 'text-tertiary',
            )}
          >
            {note && t(note)}
          </p>
        </div>
      )}
    </div>
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
    <div className={BLOCK_LINE}>
      <div className="min-w-0 flex-1">
        {label}
        {note &&
          ('error' in note ? (
            <p role="alert" className="mt-1.5 text-hint text-danger">
              {note.error}
            </p>
          ) : (
            <SavedTo path={note.path} />
          ))}
      </div>
      <Button
        className={ROW_BUTTON}
        variant="outline"

        disabled={busy}
        aria-label={t('advanced.diagnostics.export')}
        onClick={() => void run()}
      >
        {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
        {t('advanced.diagnostics.exportShort')}
      </Button>
    </div>
  )
}

/** Where the diagnostics file went, and the way to it. */
function SavedTo({ path }: { path: string }) {
  const { t } = useTranslation('settings')
  const [error, setError] = useState<string | null>(null)
  const [before, after] = t('advanced.diagnostics.saved', { path: SLOT }).split(SLOT)
  return (
    <div
      role="status"
      className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-hint text-secondary"
    >
      <span className="flex max-w-full min-w-0 items-center whitespace-pre">
        {before}
        <PathText path={path} />
        {after}
      </span>
      {/* A browser saves the file among its downloads, which it shows itself. */}
      {!isWeb && (
        <button
          type="button"
          className="rounded-sm font-medium text-primary underline decoration-border-strong underline-offset-2 outline-none hover:decoration-current focus-ring"
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
    <span
      title={path}
      data-selectable=""
      className="block truncate text-left font-mono text-code [direction:rtl]"
    >
      {'\u200E'}
      {path}
      {'\u200E'}
    </span>
  ) : (
    <Skeleton className="my-0.5 h-3.5 w-48" />
  )
}

export function DataFolderActions() {
  const { t } = useTranslation('settings')
  const path = useAppInfo()?.userDataPath
  if (!path) return null
  return (
    <>
      <RevealButton path={path} outline />
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
      <Button
        variant="outline"
        className={ROW_BUTTON}
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
        {t('browser.clearData.button')}
      </Button>
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
    <div className="flex items-center gap-3.5 py-3.25">
      <DeviceTile icon={<GlobeIcon className="size-4" />} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-label leading-[normal]">{originLabel(site.origin)}</span>
        <ItemLine>{t('browser.allowedSites.in', { projects: names.join(', ') })}</ItemLine>
      </div>
      <Button variant="ghost" className={ROW_BUTTON} disabled={removing} onClick={onRemove}>
        {removing && <Spinner data-icon="inline-start" className="size-3.5" />}
        {t('browser.allowedSites.remove')}
      </Button>
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
      <div className="py-3.75">
        <Notice
          variant="error"
          icon={<CircleAlertIcon />}
          title={t('browser.allowedSites.readFailed')}
          action={
            onRetry && (
              <Button className={ROW_BUTTON} variant="outline" onClick={onRetry}>
                <RotateCwIcon data-icon="inline-start" />
                {t('common:actions.retry')}
              </Button>
            )
          }
        >
          <span className="font-mono text-code break-words" data-selectable="">
            {error}
          </span>
        </Notice>
      </div>
    )
  }
  if (loading) {
    return (
      <div className="flex flex-col gap-2 py-3.75">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-32" />
      </div>
    )
  }
  return <p className="py-3.75 text-group text-tertiary">{t('browser.allowedSites.empty')}</p>
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
      <Button
        className={ROW_BUTTON}
        variant="destructive-outline"

        disabled={count === 0 || busy}
        onClick={() => setOpen(true)}
      >
        {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
        {t('advanced.removeSessions.button')}
      </Button>
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
