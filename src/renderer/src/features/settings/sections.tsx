import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  BellIcon,
  CheckIcon,
  CircleHelpIcon,
  FileDownIcon,
  GlobeIcon,
  ListIcon,
  MinusIcon,
  PlusIcon,
} from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { originLabel } from '@shared/browser'
import type { AllowedSites } from '@shared/ipc'
import { LOCALES, LOCALE_NAMES, type LanguageSetting } from '@shared/locale'
import {
  DEFAULT_SETTINGS,
  ZOOM_LEVELS,
  stepZoom,
  type SettingsFile,
  type ZoomStep,
} from '@shared/settings'
import type { AgentId } from '@shared/thread'
import { exportDiagnostics } from '@renderer/app/actions'
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
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@renderer/components/ui/input-group'
import { Kbd } from '@renderer/components/ui/kbd'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage, host } from '@renderer/lib/host'
import { basename } from '@renderer/lib/format'
import { fileManagerName, formatShortcut, isMac, isWindows } from '@renderer/lib/platform'
import { useAppInfo } from '@renderer/lib/use-app-info'
import { cn } from '@renderer/lib/utils'
import { isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { loadGitTools, useGitStore } from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  CONFIRM,
  ControlError,
  CopyAction,
  FIELD_LABEL,
  GROUP_ACTION,
  Masked,
  PathText,
  RevealAction,
  Segmented,
  SettingSelect,
  SettingSwitch,
} from './controls'
import { FlashMark } from './rows'
import { useApply } from './use-apply'

const useSettings = () => useSettingsStore((s) => s.settings)

// The panel behind a live preview: text size, terminal font, notification banner.
const PREVIEW_BOX = 'rounded-code bg-app shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]'

// A block row's first line: the row's text on the left, its control on the right.
const BLOCK_LINE = 'flex min-h-10 items-center gap-4'

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
    {
      value: 'ask',
      label: t('general.defaultAgent.askEachTime'),
      icon: <CircleHelpIcon className="size-3.5 text-icon" />,
    },
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
}: {
  field: 'restoreLastSession' | 'confirmQuitWhileRunning' | 'sessionTitles' | 'background'
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
            className="h-6.5 w-7.5 text-secondary hover:bg-transparent hover:text-primary disabled:opacity-40 [&_svg:not([class*='size-'])]:size-3.5"
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
    <div className="flex items-center gap-1.5">
      <ControlError error={error} />
      {zoom !== DEFAULT_SETTINGS.appearance.zoom && (
        <Button variant="quiet" size="sm" className="text-secondary" onClick={() => step(0)}>
          {t('appearance.zoom.reset')}
        </Button>
      )}
      <div
        role="group"
        aria-label={t('appearance.zoom.name')}
        className="inline-flex items-center gap-0.5 rounded-lg bg-segment-track p-0.5 shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]"
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
          className="min-w-11.5 text-center text-small font-medium text-primary tabular-nums"
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
    </div>
  )
}

/** The text with each of `keys` in it shown as a keycap, as a row's description names shortcuts. */
export function WithKeys({ text, keys }: { text: string; keys: readonly string[] }) {
  const parts: ReactNode[] = []
  let rest = text
  for (;;) {
    const next = keys
      .map((key) => ({ key, at: rest.indexOf(key) }))
      .filter((found) => found.at >= 0)
      .sort((a, b) => a.at - b.at)[0]
    if (!next) break
    parts.push(rest.slice(0, next.at), <Kbd key={parts.length}>{next.key}</Kbd>)
    rest = rest.slice(next.at + next.key.length)
  }
  parts.push(rest)
  return parts
}

export function TextSize({ label }: { label: ReactNode }) {
  const { t } = useTranslation('settings')
  const value = useSettings().appearance.textSize
  const [apply, error] = useApply()
  return (
    <div className="flex w-full flex-col gap-3">
      <div className={BLOCK_LINE}>
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
      <div aria-hidden className={cn(PREVIEW_BOX, 'flex flex-col gap-2.5 p-4 text-prose')}>
        <div className="max-w-4/5 self-end rounded-2xl bg-subtle px-3.25 py-2 leading-normal">
          {t('appearance.textSize.previewUser')}
        </div>
        {/* The thread's own prose rules, its inline code included. */}
        <p className="markdown">
          <Trans
            t={t}
            i18nKey="appearance.textSize.previewAgent"
            components={{ code: <code data-streamdown="inline-code" /> }}
          />
        </p>
      </div>
    </div>
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
      await window.kettu.dialogs.chooseShell()
    } catch (e) {
      setPickError(errorMessage(e))
    }
  }
  // A program's name is mono; "Login shell" is a label and stays in the interface font.
  const isProgram = !!shellPath || isWindows
  const program = shellPath
    ? basename(shellPath)
    : isWindows
      ? 'PowerShell'
      : t('terminal.shell.loginShell')
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ControlError error={error ?? pickError} />
      <Badge
        variant="neutral"
        title={shellPath ?? undefined}
        className={cn(
          'max-w-48 min-w-0 shrink text-primary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]',
          isProgram && 'font-mono text-meta',
        )}
      >
        <span className="truncate">{program}</span>
      </Badge>
      {shellPath && (
        <Button
          variant="quiet"
          size="sm"
          className="text-secondary"
          onClick={() => apply({ terminal: { shellPath: null } })}
        >
          {t('terminal.shell.reset')}
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={() => void choose()}>
        {t('terminal.shell.choose')}
      </Button>
    </div>
  )
}

const ANSI_COLOR = {
  green: 'text-(color:--ansi-green)',
  blue: 'text-(color:--ansi-blue)',
  cyan: 'text-(color:--ansi-cyan)',
  magenta: 'text-(color:--ansi-magenta)',
}

function Ansi({ color, children }: { color: keyof typeof ANSI_COLOR; children: ReactNode }) {
  return <span className={ANSI_COLOR[color]}>{children}</span>
}

function PromptLine({ children }: { children?: ReactNode }) {
  return (
    <div className="whitespace-pre">
      <Ansi color="blue">~/projects/kettu</Ansi> <Ansi color="magenta">main</Ansi>{' '}
      <Ansi color="green">{'\u276F'}</Ansi> {children}
    </div>
  )
}

function TestFile({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="whitespace-pre">
      {' '}
      <Ansi color="green">{'\u2713'}</Ansi> {name} <span className="text-tertiary">{detail}</span>
    </div>
  )
}

function TestTotal({ name, count }: { name: string; count: number }) {
  return (
    <div className="whitespace-pre">
      <Ansi color="cyan">{name}</Ansi>
      {'  '}
      <Ansi color="green">{count} passed</Ansi> <span className="text-tertiary">({count})</span>
    </div>
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
        className={cn(PREVIEW_BOX, 'overflow-hidden px-3.5 py-3 font-mono leading-normal')}
        style={{ fontSize: value }}
      >
        <PromptLine>pnpm test</PromptLine>
        <TestFile name="src/shared/settings.test.ts" detail="(12 tests) 8ms" />
        <TestFile name="src/main/menu.test.ts" detail="(9 tests) 14ms" />
        <div className="whitespace-pre"> </div>
        <TestTotal name=" Test Files" count={2} />
        <TestTotal name="      Tests" count={21} />
        <PromptLine>
          <span className="inline-block h-[1.2em] w-[0.6em] bg-foreground/75 align-[-0.2em]" />
        </PromptLine>
      </div>
    </div>
  )
}

// ---- Git

function StatusDot() {
  return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-current" />
}

function ToolsPending() {
  const { t } = useTranslation()
  const error = useGitStore((s) => s.toolsError)
  if (!error) return <Spinner className="size-3.5 text-tertiary" />
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
  const { found, version } = tools.git
  if (!found) return <Badge variant="neutral">{t('git.git.notFound')}</Badge>
  return (
    <Badge variant="success">
      <CheckIcon data-icon="inline-start" />
      {version ? (
        <>
          <span className="sr-only">{t('git.git.found')}</span>
          <span className="font-mono text-meta font-normal">{version}</span>
        </>
      ) : (
        t('git.git.found')
      )}
    </Badge>
  )
}

// i18next fills a value with this, so the sentence can be split where the value goes, to mark it up.
const SLOT = '\uE001'

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
        className="text-xs text-tertiary underline underline-offset-2 hover:text-primary"
      >
        {t('git.gh.install')}
      </a>
    )
  }
  if (gh.state === 'signed-out') {
    return (
      <span className="flex items-center gap-1.5">
        <Badge variant="warning" className="gap-1.5">
          <StatusDot />
          {t('git.gh.signedOut')}
        </Badge>
        <code className="rounded-md bg-subtle px-1.5 py-0.5 font-mono text-meta">
          gh auth login
        </code>
        <CopyAction text="gh auth login" label={t('git.gh.copyCommand')} />
      </span>
    )
  }
  const [before = '', after = ''] = gh.account
    ? t('git.gh.signedInAs', { account: SLOT }).split(SLOT)
    : [t('git.gh.signedIn')]
  return (
    <Badge
      variant="success"
      title={gh.version ? `gh ${gh.version}` : undefined}
      // A mask that ends the pill brings its own padding, so its hover fill is concentric.
      className={cn(!after && 'has-data-[slot=masked]:pr-0.5')}
    >
      <CheckIcon data-icon="inline-start" />
      {before}
      {gh.account && (
        <span className="font-normal text-primary">
          <Masked>{gh.account}</Masked>
        </span>
      )}
      {after}
    </Badge>
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
  // A system banner over the desktop, which a tint of the desk stands for.
  return (
    <div
      aria-hidden
      className="grid place-items-center rounded-xl bg-[linear-gradient(135deg,color-mix(in_srgb,var(--bg-sidebar),var(--info)_10%),var(--bg-sidebar))] px-4 py-5.5 shadow-card"
    >
      <div className="flex w-87.5 max-w-full gap-2.5 rounded-3xl bg-surface/88 px-3 py-2.5 shadow-menu backdrop-blur-xl">
        <BrandIcon size={32} />
        <div className="flex min-w-0 flex-1 flex-col gap-px text-command">
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
            <code className="font-mono text-meta">pnpm vitest run src/usage</code>
            {after}
          </span>
        </div>
      </div>
    </div>
  )
}

// How long the test button shows that the notification went out.
const SENT_MS = 2000

export function TestNotification() {
  const { t } = useTranslation('settings')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
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
          {t('notifications.testUnsupported')}
        </span>
      )}
      <span role="status" className="sr-only">
        {sent ? t('notifications.sent') : ''}
      </span>
      <ControlError error={error} />
      <Button
        variant="quiet"
        size="sm"
        disabled={busy}
        title={unsupported ? t('notifications.testUnsupported') : undefined}
        onClick={() => void run()}
        className={GROUP_ACTION}
      >
        {busy ? (
          <Spinner data-icon="inline-start" className="size-3.5" />
        ) : sent ? (
          <CheckIcon data-icon="inline-start" className="text-success" />
        ) : (
          <BellIcon data-icon="inline-start" />
        )}
        {t('notifications.test')}
      </Button>
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

  return (
    <div className="flex w-full flex-col gap-3">
      <div className={BLOCK_LINE}>
        <div className="min-w-0 flex-1">{label}</div>
        <ControlError error={error} />
        <SettingSelect
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
        <div className="grid animate-in grid-cols-2 gap-x-3 gap-y-2.5 fade-in animation-duration-(--duration-base)">
          <label className={FIELD_LABEL}>
            {t('advanced.proxy.url')}
            <InputGroup>
              <InputGroupAddon>
                <GlobeIcon className="size-3.5 text-icon" />
              </InputGroupAddon>
              <InputGroupInput
                ref={urlInput}
                value={url}
                placeholder="http://proxy.example.com:8080"
                spellCheck={false}
                aria-invalid={invalid || undefined}
                aria-describedby={noteId}
                onChange={(e) => setUrl(e.target.value)}
                onBlur={() => (url.trim() || proxy.mode === 'custom') && save()}
                onKeyDown={(e) => e.key === 'Enter' && save()}
                className="text-small font-normal md:text-small"
              />
            </InputGroup>
          </label>
          <label className={FIELD_LABEL}>
            {t('advanced.proxy.noProxyFor')}
            <InputGroup>
              <InputGroupAddon>
                <ListIcon className="size-3.5 text-icon" />
              </InputGroupAddon>
              <InputGroupInput
                value={noProxy}
                placeholder="localhost, 127.0.0.1, .internal"
                spellCheck={false}
                onChange={(e) => setNoProxy(e.target.value)}
                onBlur={() => url.trim() && save()}
                onKeyDown={(e) => e.key === 'Enter' && save()}
                className="text-small font-normal md:text-small"
              />
            </InputGroup>
          </label>
          <p
            id={noteId}
            role="status"
            className={cn(
              'col-span-2 flex items-center gap-1.5 text-xs',
              invalid ? 'text-danger' : inUse ? 'text-success' : 'text-tertiary',
            )}
          >
            {!invalid && inUse && <CheckIcon className="size-3.5 shrink-0" />}
            {t(
              invalid
                ? 'advanced.proxy.invalid'
                : inUse
                  ? 'advanced.proxy.inUse'
                  : 'advanced.proxy.environmentNote',
            )}
          </p>
        </div>
      )}
    </div>
  )
}

export function Diagnostics({ label }: { label: ReactNode }) {
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
  return (
    <div className={BLOCK_LINE}>
      <div className="min-w-0 flex-1">
        {label}
        {note &&
          ('error' in note ? (
            <p role="alert" className="mt-1.5 text-xs text-danger">
              {note.error}
            </p>
          ) : (
            <SavedTo path={note.path} />
          ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        aria-label={t('advanced.diagnostics.export')}
        onClick={() => void run()}
      >
        {busy ? (
          <Spinner data-icon="inline-start" className="size-3.5" />
        ) : (
          <FileDownIcon data-icon="inline-start" />
        )}
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
      className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-secondary"
    >
      <span className="flex max-w-full min-w-0 items-center whitespace-pre">
        {before}
        <PathText path={path} />
        {after}
      </span>
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
      <ControlError error={error} />
    </div>
  )
}

/** The data folder's description, with the folder itself under it. */
export function DataFolderText({ text }: { text: string }) {
  const path = useAppInfo()?.userDataPath
  return (
    <>
      {text}
      <span className="mt-0.5 flex">
        {path ? <PathText path={path} /> : <Skeleton className="my-0.5 h-3.5 w-48" />}
      </span>
    </>
  )
}

export function DataFolderActions() {
  const { t } = useTranslation('settings')
  const path = useAppInfo()?.userDataPath
  if (!path) return null
  return (
    <span className="flex items-center gap-0.5">
      <CopyAction text={path} label={t('advanced.dataFolder.copy')} />
      <RevealAction path={path} />
    </span>
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
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setOpen(true)}>
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

export function AllowedSitesList() {
  const { t } = useTranslation(['settings', 'common'])
  const projects = useProjectsStore((s) => s.projects)
  const [sites, setSites] = useState<AllowedSites[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.kettu.browser
      .allowedSites()
      .then((list) => {
        if (!cancelled) setSites(list)
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const remove = async (projectPath: string, origin: string) => {
    const key = `${projectPath}\n${origin}`
    setBusy(key)
    setError(null)
    try {
      await window.kettu.browser.removeAllowedSite(projectPath, origin)
      setSites(
        (list) =>
          list
            ?.map((site) =>
              site.projectPath === projectPath
                ? { ...site, origins: site.origins.filter((known) => known !== origin) }
                : site,
            )
            .filter((site) => site.origins.length > 0) ?? null,
      )
      toast(t('browser.allowedSites.removed', { origin: labelOf(origin) }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  if (sites === null && error === null) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-32" />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      <ControlError error={error} />
      {sites && sites.length === 0 && (
        <p className="text-ui text-tertiary">{t('browser.allowedSites.empty')}</p>
      )}
      {sites?.map((site) => (
        <div key={site.projectPath} className="flex flex-col gap-1">
          <span className="text-xs font-medium text-tertiary">
            {projects.find((project) => project.path === site.projectPath)?.name ??
              basename(site.projectPath)}
          </span>
          {site.origins.map((origin) => {
            const key = `${site.projectPath}\n${origin}`
            return (
              <div key={origin} className="flex items-center gap-2 py-0.5">
                <span className="min-w-0 flex-1 truncate text-ui text-primary">
                  {labelOf(origin)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void remove(site.projectPath, origin)}
                >
                  {busy === key && <Spinner data-icon="inline-start" className="size-3.5" />}
                  {t('browser.allowedSites.remove')}
                </Button>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** An origin as the list shows it: its host and port, without the scheme. */
function labelOf(origin: string): string {
  return originLabel(origin)
}

export function RemoveAll() {
  const { t } = useTranslation(['settings', 'common'])
  const count = useSessionsStore((s) => Object.keys(s.byId).length)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await host('sessions.removeAll', undefined)
      await useSessionsStore.getState().refresh()
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
        variant="destructive-outline"
        size="sm"
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
