import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { BellIcon, CircleHelpIcon, FileDownIcon, MinusIcon, PlusIcon } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { LOCALES, LOCALE_NAMES, type LanguageSetting } from '@shared/locale'
import {
  DEFAULT_SETTINGS,
  ZOOM_LEVELS,
  stepZoom,
  type SettingsFile,
  type ZoomStep,
} from '@shared/settings'
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
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Kbd, KbdGroup } from '@renderer/components/ui/kbd'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@renderer/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { errorMessage, host } from '@renderer/lib/host'
import { basename } from '@renderer/lib/format'
import { formatShortcut, isWindows } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { AGENT_NAMES, isInstalled, useAgentsStore } from '@renderer/stores/agents'
import { loadGitTools, useGitStore } from '@renderer/stores/git'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { useAppInfo } from './use-app-info'
import {
  ControlError,
  CopyAction,
  Masked,
  PathText,
  RevealAction,
  Segmented,
  SettingSelect,
  SettingSwitch,
} from './controls'
import { useApply } from './use-apply'

const useSettings = () => useSettingsStore((s) => s.settings)

// The recessed panel behind a live preview: text size, terminal font, notification banner.
const PREVIEW_BOX =
  'rounded-xl bg-sidebar shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]'

// A block row's first line: the row's text on the left, its control on the right.
const BLOCK_LINE = 'flex min-h-7 items-center gap-6'

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
  const missing = useAgentsStore(
    useShallow((s) =>
      AGENT_IDS.filter((id) => {
        const status = s.byId[id]
        return !!status && !isInstalled(status)
      }),
    ),
  )
  const [apply, error] = useApply()
  const options = [
    {
      value: 'ask',
      label: t('general.defaultAgent.askEachTime'),
      icon: <CircleHelpIcon className="size-3.5 text-icon" />,
    },
    ...AGENT_IDS.filter((id) => id !== 'fake-agent').map((id) => {
      const absent = missing.includes(id)
      return {
        value: id as string,
        label: AGENT_NAMES[id],
        icon: <AgentMark agent={id} className="size-3.5" />,
        disabled: absent,
        hint: absent ? t('agents.groups.notInstalled') : undefined,
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
          { value: 'mod-enter', label: formatShortcut('Mod+Enter') },
        ]}
        onChange={(v) => apply({ general: { sendKey: v } })}
      />
    </>
  )
}

// ---- Appearance

type ColorMode = SettingsFile['appearance']['theme']

const COLOR_MODES: readonly ColorMode[] = ['system', 'light', 'dark']

export function ColorModeTiles() {
  const { t } = useTranslation('settings')
  const value = useSettings().appearance.theme
  const [apply, error] = useApply()
  return (
    <>
      <ToggleGroup
        aria-label={t('appearance.colorMode.name')}
        variant="tile"
        size="tile"
        spacing={3.5}
        value={[value]}
        onValueChange={(next) => {
          const picked = next[0] as ColorMode | undefined
          if (picked && picked !== value) apply({ appearance: { theme: picked } })
        }}
        className="grid w-full grid-cols-3 items-stretch"
      >
        {COLOR_MODES.map((mode) => (
          <ToggleGroupItem
            key={mode}
            value={mode}
            className="items-stretch gap-2 hover:[&>[data-tile]]:ring-border-strong"
          >
            <ColorModePreview kind={mode} />
            <span className="flex items-center gap-2 pl-0.5 text-small text-primary">
              <RadioDot />
              {t(`appearance.colorMode.${mode}`)}
            </span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <ControlError error={error} />
    </>
  )
}

// Reads the toggle it sits in: filled with a dot while that toggle is pressed.
export function RadioDot() {
  return (
    <span
      aria-hidden
      className="grid size-3.5 shrink-0 place-items-center rounded-full ring-1 ring-border-strong transition-colors duration-(--duration-fast) ring-inset group-aria-pressed/toggle:bg-primary group-aria-pressed/toggle:ring-0"
    >
      <span className="size-1.5 scale-0 rounded-full bg-background transition-transform duration-(--duration-fast) group-aria-pressed/toggle:scale-100" />
    </span>
  )
}

/**
 * A miniature window in the chosen theme's surfaces for the mode; System shows both, split on a
 * diagonal.
 */
function ColorModePreview({ kind }: { kind: ColorMode }) {
  return (
    <span
      data-tile=""
      aria-hidden
      className="relative block h-26 w-full overflow-hidden rounded-xl"
    >
      {kind !== 'dark' && <MiniWindow dark={false} />}
      {kind !== 'light' && <MiniWindow dark cut={kind === 'system'} />}
    </span>
  )
}

function MiniLine({ className }: { className?: string }) {
  return <span className={cn('block h-1.25 rounded-full bg-border', className)} />
}

/**
 * The wrapper's mode makes the tokens inside resolve for it, whatever the app shows; `style` can
 * set the tokens themselves, for a theme that is not the chosen one.
 */
export function MiniWindow({
  dark,
  cut,
  style,
}: {
  dark: boolean
  cut?: boolean
  style?: CSSProperties
}) {
  return (
    <span
      data-theme={dark ? 'dark' : 'light'}
      style={style}
      className={cn(
        'absolute inset-0 flex bg-background',
        cut && '[clip-path:polygon(62%_0,100%_0,100%_100%,38%_100%)]',
      )}
    >
      <span className="flex w-1/3 flex-col gap-1.5 border-r border-subtle bg-sidebar px-2 py-3">
        <span className="block h-2 rounded-sm bg-selected" />
        <MiniLine />
        <MiniLine className="w-3/4" />
        <MiniLine className="w-5/6" />
      </span>
      <span className="flex flex-1 flex-col gap-1.5 px-3 pt-3.5 pb-2.5">
        <MiniLine className="w-2/5 bg-border-strong" />
        <span className="block h-3 w-1/2 self-end rounded-md bg-subtle" />
        <MiniLine className="w-11/12" />
        <MiniLine className="w-2/3" />
        <span className="mt-auto flex h-5 items-center justify-end rounded-md bg-card pr-0.75 shadow-card">
          <span className="size-3.5 rounded-sm bg-(image:--primary-gradient)" />
        </span>
      </span>
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
            className="hover:bg-segment-thumb hover:shadow-segment"
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
    <>
      <ControlError error={error} />
      {zoom !== DEFAULT_SETTINGS.appearance.zoom && (
        <Button variant="quiet" size="compact" onClick={() => step(0)}>
          {t('appearance.zoom.reset')}
        </Button>
      )}
      <div
        role="group"
        aria-label={t('appearance.zoom.name')}
        className="inline-flex items-center rounded-lg bg-segment-track p-0.5"
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
          className="min-w-12 text-center text-control tabular-nums"
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
    </>
  )
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
      <div aria-hidden className={cn(PREVIEW_BOX, 'flex flex-col gap-3 px-4 py-4 text-prose')}>
        <div className="max-w-4/5 self-end rounded-xl bg-subtle px-3 py-1.5 leading-relaxed">
          {t('appearance.textSize.previewUser')}
        </div>
        <p className="text-primary">
          <Trans
            t={t}
            i18nKey="appearance.textSize.previewAgent"
            components={{
              code: (
                <code className="rounded-sm bg-subtle px-[0.35em] py-[0.1em] font-mono text-[0.85em]" />
              ),
            }}
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
      await window.overbench.dialogs.chooseShell()
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
        className={cn('max-w-48 min-w-0 shrink', isProgram && 'font-mono text-meta')}
      >
        <span className="truncate">{program}</span>
      </Badge>
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
      <Ansi color="blue">~/projects/overbench</Ansi> <Ansi color="magenta">main</Ansi>{' '}
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
    <Badge variant="success" className="gap-1.5">
      <StatusDot />
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
  return (
    <Badge
      variant="success"
      title={gh.version ? `gh ${gh.version}` : undefined}
      className="gap-1.5 overflow-visible"
    >
      <StatusDot />
      {t('git.gh.signedIn')}
      {gh.account && (
        <span className="font-normal">
          <Masked>{gh.account}</Masked>
        </span>
      )}
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
  return (
    <div className="px-1 py-3">
      <div aria-hidden className={cn(PREVIEW_BOX, 'flex h-29 items-center justify-center px-4')}>
        <div className="flex w-86 max-w-full items-center gap-3 rounded-2xl bg-popover px-3 py-2.5 shadow-menu">
          <span className="size-8 shrink-0 rounded-lg bg-primary" />
          <div className="flex min-w-0 flex-1 flex-col gap-px text-control">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate font-semibold">
                {t('notifications.previewTitle')}
              </span>
              <span className="shrink-0 text-meta text-tertiary">
                {t('notifications.previewTime')}
              </span>
            </div>
            <span className="truncate">
              {before}
              <code className="font-mono text-meta">pnpm test</code>
              {after}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function TestNotification() {
  const { t } = useTranslation('settings')
  const [busy, setBusy] = useState(false)
  const [unsupported, setUnsupported] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async () => {
    setBusy(true)
    setUnsupported(false)
    setError(null)
    try {
      setUnsupported(!(await window.overbench.notifications.test()))
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
      <ControlError error={error} />
      <Button
        variant="quiet"
        size="xs"
        disabled={busy}
        title={unsupported ? t('notifications.testUnsupported') : undefined}
        onClick={() => void run()}
        className="-mr-2"
      >
        {busy ? (
          <Spinner data-icon="inline-start" className="size-3" />
        ) : (
          <BellIcon data-icon="inline-start" />
        )}
        {t('notifications.test')}
      </Button>
    </>
  )
}

// ---- Keyboard shortcuts

// "1-4" is a range of keys, not a chord.
const KEY_RANGE = /^(\d)-(\d)$/

const KEYCAP = 'h-5.5 min-w-5.5 rounded-md bg-card px-1.5 text-primary shadow-outline'

export function ShortcutKeys({ keys }: { keys: string }) {
  const range = KEY_RANGE.exec(keys)
  return (
    <KbdGroup className="gap-1">
      {range ? (
        <>
          <Kbd className={KEYCAP}>{range[1]}</Kbd>
          <span aria-hidden className="self-center text-xs text-tertiary">
            {'–'}
          </span>
          <Kbd className={KEYCAP}>{range[2]}</Kbd>
        </>
      ) : (
        keys.split(/\+(?=.)/).map((key, i) => (
          <Kbd key={i} className={KEYCAP}>
            {formatShortcut(key)}
          </Kbd>
        ))
      )}
    </KbdGroup>
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
          <label htmlFor="proxy-url" className="text-xs text-tertiary">
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
          <label htmlFor="proxy-no" className="text-xs text-tertiary">
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
            <p className="col-start-2 text-xs text-danger">{t('advanced.proxy.invalid')}</p>
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
            'max-w-56 min-w-0 truncate text-xs',
            'error' in note ? 'text-danger' : 'text-tertiary',
          )}
          title={noteText ?? undefined}
        >
          {noteText}
        </span>
      )}
      <Button
        variant="outline"
        size="compact"
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

export function DataFolder({ label }: { label: ReactNode }) {
  const { t } = useTranslation('settings')
  const path = useAppInfo()?.userDataPath
  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className={BLOCK_LINE}>
        <div className="min-w-0 flex-1">{label}</div>
        {path && (
          <span className="flex shrink-0 items-center gap-0.5">
            <CopyAction text={path} label={t('advanced.dataFolder.copy')} />
            <RevealAction path={path} />
          </span>
        )}
      </div>
      {path ? <PathText path={path} /> : <Skeleton className="h-4 w-64" />}
    </div>
  )
}

export function ClearBrowsingData() {
  const { t } = useTranslation(['settings', 'common'])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [cleared, setCleared] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const clear = async () => {
    setBusy(true)
    setError(null)
    setCleared(false)
    try {
      await window.overbench.browser.clearData()
      setCleared(true)
      setOpen(false)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {cleared && (
        <span role="status" className="text-xs text-tertiary">
          {t('browser.clearData.cleared')}
        </span>
      )}
      <ControlError error={error} />
      <Button variant="outline" size="compact" disabled={busy} onClick={() => setOpen(true)}>
        {busy && <Spinner data-icon="inline-start" className="size-3.5" />}
        {t('browser.clearData.button')}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('browser.clearData.dialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('browser.clearData.dialogDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void clear()}>
              {t('browser.clearData.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
