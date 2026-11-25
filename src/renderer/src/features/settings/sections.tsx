import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
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
  NEW_SESSION_LISTS,
  ZOOM_LEVELS,
  stepZoom,
  type LightModel,
  type SettingsFile,
  type ZoomStep,
} from '@shared/settings'
import type { AgentOptions, LightAgent } from '@shared/agent-host'
import type { AgentId, ConfigOption } from '@shared/thread'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Kbd } from '@renderer/components/ui/kbd'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { harnessReason, shortLabel } from '@renderer/features/agents/harness-problem'
import { forgetSite } from '@renderer/features/session/link-open'
import { terminalFontStack } from '@renderer/features/terminal/font-stack'
import { errorMessage } from '@renderer/lib/host'
import { systemLocale } from '@renderer/lib/i18n'
import { basename } from '@renderer/lib/format'
import { formatShortcut, hostPlatform, isMac, isWeb, isWindows } from '@renderer/lib/platform'
import { useAppInfo } from '@renderer/lib/use-app-info'
import { readFirstOptions } from '@renderer/features/session/new-session/prepared'
import { agentKey, optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentName, isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { useOtherHost } from '@renderer/stores/hosts'
import { homeStart } from '@renderer/web/host-path'
import { askHostPath } from '@renderer/web/host-path-request'
import { useProjectsStore } from '@renderer/stores/projects'
import { openReport, useReportStore } from '@renderer/stores/report'
import { hostOfSession, useSessionsStore } from '@renderer/stores/sessions'
import { loadSiteIcons, useDefaultBrowser } from '@renderer/stores/site-icons'
import { loadBrought } from '@renderer/stores/sign-ins'
import { browserDevice } from '@renderer/web/device-name'
import { browserNotifications, notificationsProblem } from '@renderer/web/notifications'
import { pushProblem } from '@renderer/web/push'
import {
  CONFIRM,
  ControlError,
  CopyAction,
  DangerButton,
  Masked,
  Pill,
  RevealButton,
  Segmented,
  SetButton,
  SetInput,
  SelectFace,
  SettingSelect,
  SettingSwitch,
  Skel,
  Spin,
} from './controls'
import type { AllowedSite } from './allowed-sites'
import { LanguageFlag } from './language-flag'
import { BlockLine, FlashMark, GroupNote, ItemLine, Notice, Thing } from './rows'
import { useApply } from './use-apply'

/** The settings of the host the section shows, this computer's own keys among them. */
const useSettings = () => useHostScope().useSettingsStore((s) => s.settings)

// ---- General

export function Language() {
  const { t } = useTranslation('settings')
  const value = useSettings().general.language
  const [apply, error] = useApply()
  const options: { value: LanguageSetting; label: string; icon: ReactNode }[] = [
    {
      value: 'system',
      label: t('general.language.systemNamed', { name: LOCALE_NAMES[systemLocale] }),
      icon: <Icon icon={Globe02Icon} size={14} />,
    },
    ...LOCALES.map((locale) => ({
      value: locale,
      label: LOCALE_NAMES[locale],
      icon: <LanguageFlag locale={locale} />,
    })),
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
  // The fake agent is a development tool, not a choice for everyday use.
  const agents = useAgentsStore(
    useShallow((s) => usableAgents(s.order, s.byId).filter((a) => a.id !== 'fake-agent')),
  )
  const [apply, error] = useApply()
  const options = [
    { value: 'ask', label: t('general.defaultAgent.askEachTime') },
    ...agents.map((agent) => {
      const reason = isInstalled(agent) ? null : harnessReason(agent)
      const off = agent.disabled === true
      return {
        value: agent.id as string,
        label: agent.name,
        icon: <AgentMark agent={agent.id} className="size-4" />,
        disabled: !!reason || off,
        hint: reason ? shortLabel(reason) : off ? t('agents.turnedOff') : undefined,
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

export function NewSessionListChoice() {
  const { t } = useTranslation('settings')
  const value = useSettings().general.newSessionList
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSelect
        label={t('general.newSessionList.name')}
        value={value}
        options={NEW_SESSION_LISTS.map((list) => ({
          value: list,
          label: t(`general.newSessionList.${list}`),
        }))}
        onChange={(v) => apply({ general: { newSessionList: v } })}
      />
    </>
  )
}

export function GeneralSwitch({
  field,
  label,
  disabled,
}: {
  field:
    | 'restoreLastSession'
    | 'confirmQuitWhileRunning'
    | 'sessionTitles'
    | 'continueAfterLimit'
    | 'promptSuggestions'
    | 'agentPasswords'
    | 'background'
  label: string
  disabled?: boolean
}) {
  // A host older than one of its keys leaves it out, and works as its default.
  const checked = useSettings().general[field] ?? DEFAULT_SETTINGS.general[field]
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

/** An agent's models as last read, each listed once, in the agent's groups. */
function modelGroups(
  options: AgentOptions | undefined,
): { group: string | null; models: ModelChoice[] }[] {
  const option = options?.config.find((o) => o.category === 'model' && o.type === 'select')
  const choices = (option?.choices ?? []).filter((choice) => choice.shownAs === undefined)
  const groups: { group: string | null; models: ModelChoice[] }[] = []
  for (const choice of choices) {
    const group = choice.group ?? null
    const last = groups.at(-1)
    if (last && last.group === group) last.models.push(choice)
    else groups.push({ group, models: [choice] })
  }
  return groups
}

type ModelChoice = NonNullable<ConfigOption['choices']>[number]

/** The name the agent lists a model by, as last read. */
function modelName(options: AgentOptions | undefined, model: string): string | null {
  const option = options?.config.find((o) => o.category === 'model' && o.type === 'select')
  return option?.choices?.find((choice) => choice.value === model)?.name ?? null
}

/** A pinned choice as one radio value: the agent and the model, which no model id holds. */
const pinnedValue = (agentId: AgentId, model: string) => `${agentId}\0${model}`

/** The model Kettu's own requests ask: a small one, the session's, or one agent's pinned model. */
export function LightModelChoice({ label }: { label: string }) {
  const { t } = useTranslation('settings')
  const { hostId, request } = useHostScope()
  // A host older than the setting has none, and works as its default.
  const value: LightModel = useSettings().general.lightModel ?? DEFAULT_SETTINGS.general.lightModel
  const options = useAgentOptionsStore((s) => optionsOn(s, hostId))
  const firstReads = useAgentOptionsStore((s) => s.firstReads)
  const [agents, setAgents] = useState<LightAgent[] | null>(null)
  const [apply, error] = useApply()
  // The agents' models are read only once the menu opens, since a first read starts an agent.
  const load = useCallback(
    (models: boolean) => {
      void request('agents.lightAgents', undefined).then(
        ({ agents: list }) => {
          setAgents(list)
          if (models) for (const agent of list) void readFirstOptions(hostId, agent.agentId)
        },
        () => setAgents([]),
      )
    },
    [hostId, request],
  )
  useEffect(() => load(false), [load])
  const pinned = value.mode === 'pinned' ? value : null
  const current = pinned ? pinnedValue(pinned.agentId, pinned.model) : value.mode
  const shown = pinned
    ? `${agentName(pinned.agentId, hostId)} · ${modelName(options[pinned.agentId], pinned.model) ?? pinned.model}`
    : t(`general.lightModel.${value.mode}`)
  const unavailable =
    pinned && agents !== null && !agents.some((agent) => agent.agentId === pinned.agentId)
      ? t('general.lightModel.unavailable', { agent: agentName(pinned.agentId, hostId) })
      : null
  const choose = (next: LightModel) => {
    if (JSON.stringify(next) !== JSON.stringify(value)) apply({ general: { lightModel: next } })
  }
  return (
    <>
      <ControlError error={error ?? unavailable} />
      <DropdownMenu onOpenChange={(open) => open && load(true)}>
        <DropdownMenuTrigger className="ui-ss-select k-select" aria-label={label}>
          <SelectFace
            mark={pinned ? <AgentMark agent={pinned.agentId} hostId={hostId} /> : undefined}
            value={shown}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuRadioGroup
            value={current}
            onValueChange={(mode: 'small' | 'session') => choose({ mode })}
          >
            {(['small', 'session'] as const).map((mode) => (
              <DropdownMenuRadioItem key={mode} value={mode}>
                <span className="flex min-w-0 flex-col">
                  <span>{t(`general.lightModel.${mode}`)}</span>
                  <span className="text-hint text-tertiary">
                    {t(`general.lightModel.${mode}Hint`)}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {(agents === null || agents.length > 0) && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuLabel>{t('general.lightModel.pinned')}</DropdownMenuLabel>
                {agents === null && (
                  <DropdownMenuItem disabled>{t('general.lightModel.reading')}</DropdownMenuItem>
                )}
                {agents?.map((agent) => {
                  const groups = modelGroups(options[agent.agentId])
                  const mark = <AgentMark agent={agent.agentId} size={15} hostId={hostId} />
                  if (groups.length === 0) {
                    const reading = firstReads[agentKey(hostId, agent.agentId)]?.reading === true
                    return (
                      <DropdownMenuItem key={agent.agentId} disabled>
                        {mark}
                        <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                        <span className="shrink-0 pl-4 text-hint text-tertiary">
                          {t(
                            reading ? 'general.lightModel.reading' : 'general.lightModel.noModels',
                          )}
                        </span>
                      </DropdownMenuItem>
                    )
                  }
                  return (
                    <DropdownMenuSub key={agent.agentId}>
                      <DropdownMenuSubTrigger>
                        {mark}
                        <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="max-w-80">
                        <DropdownMenuRadioGroup
                          value={current}
                          onValueChange={(picked: string) =>
                            choose({
                              mode: 'pinned',
                              agentId: agent.agentId,
                              model: picked.slice(agent.agentId.length + 1),
                            })
                          }
                        >
                          {groups.map(({ group, models }) => (
                            <DropdownMenuGroup key={group ?? ''}>
                              {group !== null && groups.length > 1 && (
                                <DropdownMenuLabel>{group}</DropdownMenuLabel>
                              )}
                              {models.map((model) => (
                                <DropdownMenuRadioItem
                                  key={model.value}
                                  value={pinnedValue(agent.agentId, model.value)}
                                >
                                  <span className="min-w-0 truncate">{model.name}</span>
                                </DropdownMenuRadioItem>
                              ))}
                            </DropdownMenuGroup>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )
                })}
              </DropdownMenuGroup>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
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
      <span aria-hidden className="k-preview-label">
        {t('appearance.textSize.previewLabel')}
      </span>
      {/* The thread's own prose rules, its inline code included. */}
      <p aria-hidden className="markdown k-inset text-prose">
        <Trans
          t={t}
          i18nKey="appearance.textSize.preview"
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

export function EffortControl() {
  const { t } = useTranslation('settings')
  const value = useSettings().appearance.effortControl
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <Segmented
        label={t('appearance.effortControl.name')}
        value={value}
        options={[
          { value: 'dial', label: t('appearance.effortControl.dial') },
          { value: 'segments', label: t('appearance.effortControl.segments') },
        ]}
        onChange={(v) => apply({ appearance: { effortControl: v } })}
      />
    </>
  )
}

export function SidebarHover({ label }: { label: string }) {
  const checked = useSettings().appearance.sidebarHover
  const [apply, error] = useApply()
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(v) => apply({ appearance: { sidebarHover: v } })}
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
  const { fontSize: value, fontFamily } = useSettings().terminal
  const [apply, error] = useApply()
  return (
    <>
      <div className="ui-sg-row">
        {label}
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
        className="k-term"
        style={{
          fontSize: value,
          fontFamily: fontFamily ? terminalFontStack(fontFamily, 'var(--code-face)') : undefined,
        }}
      >
        <div>
          <span className="k-term__path">~/code/kettu</span>{' '}
          <span className="k-term__branch">main</span> $ pnpm vitest run src/usage
        </div>
        <div>
          <span className="k-term__ok">{'\u2713'}</span> 29 passed{' '}
          <span className="k-term__faint">(1.18s)</span>
        </div>
        {/* Powerline branch, folder and code icons: boxes show when the face lacks them. */}
        {fontFamily && <div className="k-term__faint">{'\ue0a0 \uf07b \uf121'}</div>}
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

/**
 * Where the host puts new worktrees: next to each project, or a folder chosen on that host, with
 * this computer's folder dialog or, for another host or the web client, the host's path picker.
 */
export function WorktreeLocation() {
  const { t } = useTranslation('settings')
  const { hostId } = useHostScope()
  const other = useOtherHost(hostId)
  const root = useSettings().git.worktreeRoot
  const [apply, error] = useApply()
  const [pickError, setPickError] = useState<string | null>(null)
  const choose = async () => {
    setPickError(null)
    try {
      let path: string | null
      if (hostId === null && !isWeb) path = await window.kettu.dialogs.openProject()
      else {
        const platform = hostId === null ? hostPlatform() : (other?.platform ?? 'linux')
        path = await askHostPath({
          purpose: 'worktreeRoot',
          initial: root ?? homeStart(platform),
          ...(hostId === null ? {} : { on: { hostId, name: other?.name ?? '', platform } }),
        })
      }
      if (path) apply({ git: { worktreeRoot: path } })
    } catch (e) {
      setPickError(errorMessage(e))
    }
  }
  return (
    <>
      <ControlError error={error ?? pickError} />
      <span title={root ?? undefined} className={root ? 'k-value k-mono' : 'k-value'}>
        {root ?? t('git.worktreeRoot.nextToProject')}
      </span>
      <SetButton onClick={() => void choose()}>{t('git.worktreeRoot.choose')}</SetButton>
      {root && (
        <SetButton variant="ghost" onClick={() => apply({ git: { worktreeRoot: null } })}>
          {t('git.worktreeRoot.reset')}
        </SetButton>
      )}
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

/** In a browser: why it shows no notifications, if so, and whether a closed page gets them. */
export function WebNotificationsNote() {
  const { t } = useTranslation('web')
  const push = pushProblem()
  // Safari on iPhone and iPad has no notifications in a tab at all, which is no matter of https.
  const problem = push === 'home-screen' ? null : notificationsProblem(browserNotifications())
  const chrome = browserDevice(navigator.userAgent).browser === 'Chrome'
  return (
    <>
      {problem && <GroupNote>{t(`notifications.${problem}`)}</GroupNote>}
      {push === 'home-screen' && <GroupNote>{t('notifications.homeScreen')}</GroupNote>}
      {push === 'unsupported' && <GroupNote>{t('notifications.openOnly')}</GroupNote>}
      {push === null && <GroupNote>{t('notifications.closed')}</GroupNote>}
      {push === null && chrome && <GroupNote>{t('notifications.chinaChrome')}</GroupNote>}
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

/** Opens the report dialog for the host the sections show. */
export function ReportProblem() {
  const { t } = useTranslation('settings')
  const { hostId } = useHostScope()
  return (
    <SetButton onClick={() => void openReport({ hostId })}>{t('advanced.report.open')}</SetButton>
  )
}

/** Starts recording steps to reproduce; the top bar shows it until it stops. */
export function RecordSteps() {
  const { t } = useTranslation('settings')
  const recording = useReportStore((s) => s.recording)
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <ControlError error={error} />
      <SetButton
        disabled={recording !== null}
        onClick={() => {
          setError(null)
          window.kettu.report.record(true).catch((e: unknown) => setError(errorMessage(e)))
        }}
      >
        {t(recording ? 'advanced.record.recording' : 'advanced.record.start')}
      </SetButton>
    </>
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
      // The brought sites went with the cookies.
      loadBrought()
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
