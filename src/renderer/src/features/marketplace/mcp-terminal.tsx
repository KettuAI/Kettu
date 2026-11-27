import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowRight01Icon,
  File01Icon,
  InformationCircleIcon,
  Key01Icon,
  LockIcon,
  MoreHorizontalIcon,
  Alert02Icon,
  Clock01Icon,
  Shield01Icon,
  ComputerIcon,
} from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { AgentId } from '@shared/agents'
import {
  MCP_TERMINAL_APPS,
  terminalApp,
  type McpTerminalApp,
  type McpTerminalBackup,
  type McpTerminalChoice,
  type McpTerminalDrift,
  type McpTerminalOffPlan,
  type McpTerminalPlan,
  type McpTerminalRow,
  type McpTerminalTarget,
} from '@shared/mcp-terminal'
import { Dropdown, Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { RadioGroup } from '@renderer/components/ui/radio-group'
import { SiteIconImage } from '@renderer/components/site-icon-image'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { Diff } from '@renderer/features/session/markdown'
import { SetButton, SettingSwitch } from '@renderer/features/settings/controls'
import {
  Choice,
  SettingsDialogBody,
  SettingsDialogFooter,
} from '@renderer/features/settings/settings-dialog'
import { RowFrame, RowText } from '@renderer/features/settings/rows'
import { useApply } from '@renderer/features/settings/use-apply'
import { mediumAgo } from '@renderer/lib/format'
import { isWeb } from '@renderer/lib/platform'
import { useHostScope } from '@renderer/stores/host-scope'
import { loadSiteIcons, requestSiteIcon, useSiteIcon } from '@renderer/stores/site-icons'
import { useAgentName } from './hooks'
import { McpConfirmation } from './mcp-confirmation'
import { homeShort } from './model'
import { ItemRow, QuietNote, SkeletonRows } from './rows'
// The agent page in Settings shows the same row and dialogs without the Marketplace page.
import './marketplace.css'

type Dialog = 'on' | 'off' | 'drift' | 'backups' | null

/** Whether Kettu opens at login on this computer, where the host is this app's own. */
function useLoginState(): { local: boolean; on: boolean } {
  const { hostId, useSettingsStore } = useHostScope()
  const on = useSettingsStore((s) => s.settings.general.openAtLogin)
  return { local: !isWeb && hostId === null, on }
}

function fileReason(
  t: TFunction<'marketplace'>,
  error: NonNullable<McpTerminalRow['error']>,
): string {
  return error === 'invalid-json' ? t('mcpTerminal.invalidJson') : t(`mcp.files.${error}`)
}

/** The strings an app says in its own words, since it runs in no terminal. */
type AppWording =
  | 'switch'
  | 'onTitle'
  | 'turnedOn'
  | 'offTitle'
  | 'turnedOff'
  | 'goesWithout'
  | 'leaveOutHint'
  | 'noServers'
  | 'restartNote'

/** A target's name, and the strings that differ for an agent and an app. */
function useWording(): {
  nameOf(target: McpTerminalTarget): string
  say(key: AppWording, target: McpTerminalTarget, values: { agent?: string }): string
} {
  const { t } = useTranslation('marketplace')
  const agentName = useAgentName()
  return {
    nameOf: (target) => {
      const app = terminalApp(target)
      return app ? MCP_TERMINAL_APPS[app] : agentName(target as AgentId)
    },
    say: (key, target, values) => {
      const app = terminalApp(target)
      if (!app) return t(`mcpTerminal.${key}`, values)
      return key === 'restartNote'
        ? t(`mcpTerminal.app.restartNote.${app}`)
        : t(`mcpTerminal.app.${key}`, values)
    },
  }
}

/** The site whose icon an app shows, for apps with no mark of their own here. */
const APP_SITES: Partial<Record<McpTerminalApp, string>> = {
  vscode: 'https://code.visualstudio.com',
  windsurf: 'https://windsurf.com',
  devin: 'https://devin.ai',
  zed: 'https://zed.dev',
}

const APP_MARKS: Partial<Record<McpTerminalApp, AgentId>> = {
  'claude-desktop': 'claude-code',
  cursor: 'cursor',
}

/** An agent's mark, or an app's: Claude's and Cursor's own, else its site's icon. */
function TargetIcon({ target }: { target: McpTerminalTarget }) {
  const { hostId } = useHostScope()
  const app = terminalApp(target)
  const mark = app ? APP_MARKS[app] : (target as AgentId)
  const site = app ? (APP_SITES[app] ?? null) : null
  const icon = useSiteIcon(site ?? '')
  useEffect(() => {
    if (!site || icon) return
    loadSiteIcons()
    requestSiteIcon(site)
  }, [site, icon])
  return (
    <span className="k-mcp-found-icon">
      {mark ? (
        <AgentMark agent={mark} size={20} hostId={hostId} dot={null} />
      ) : icon ? (
        <SiteIconImage className="k-mcp-terminal-app-icon" src={icon} />
      ) : (
        <Icon icon={ComputerIcon} size={19} />
      )}
    </span>
  )
}

function failed(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Each agent's terminal row, read once it is shown and again as the host says files changed. */
function useTerminalRows(): {
  rows: McpTerminalRow[] | null
  error: boolean
  reload(): void
} {
  const { useMarketplaceStore } = useHostScope()
  const rows = useMarketplaceStore((s) => s.terminal)
  const error = useMarketplaceStore((s) => s.terminalError)
  const load = useMarketplaceStore((s) => s.loadTerminal)
  useEffect(() => {
    void load()
  }, [load])
  return { rows, error, reload: () => void load() }
}

/** What a row says under its name: what it uses, its file and its last backup. */
function RowFacts({ row }: { row: McpTerminalRow }) {
  const { t } = useTranslation('marketplace')
  const file = <code className="k-mkt-mono">{homeShort(row.file)}</code>
  if (row.error) {
    return (
      <>
        <span className="k-mcp-warning">{fileReason(t, row.error)}</span>
        {file}
      </>
    )
  }
  if (row.unsupported) {
    return (
      <>
        <span>{t(`mcpTerminal.unsupported.${row.unsupported}`)}</span>
        {file}
      </>
    )
  }
  return (
    <>
      {row.changed > 0 ? (
        <span className="k-mcp-warning">{t('mcpTerminal.changed', { count: row.changed })}</span>
      ) : row.on ? (
        <span className="k-mcp-terminal-on">{t('mcpTerminal.uses')}</span>
      ) : (
        <span>
          {row.own === 0 ? t('mcpTerminal.noOwn') : t('mcpTerminal.own', { count: row.own })}
        </span>
      )}
      {file}
      {row.shared && (
        <span>
          {t('mcpTerminal.shared', {
            apps: row.shared.map((app) => MCP_TERMINAL_APPS[app]).join(', '),
          })}
        </span>
      )}
      {row.on && row.backedUpAt !== null && (
        <span>{t('mcpTerminal.backedUp', { when: mediumAgo(row.backedUpAt) })}</span>
      )}
    </>
  )
}

/** The switch, the ⋯ menu and the dialogs they open, for one agent. */
function TerminalControls({ row, menu = true }: { row: McpTerminalRow; menu?: boolean }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const { nameOf, say } = useWording()
  const [dialog, setDialog] = useState<Dialog>(null)
  const name = nameOf(row.target)
  const disabled = !!row.unsupported || (!!row.error && !row.on)
  return (
    <>
      {row.changed > 0 && row.on && (
        <Button size="sm" variant="secondary" onClick={() => setDialog('drift')}>
          {t('mcpTerminal.review')}
        </Button>
      )}
      <SettingSwitch
        label={say('switch', row.target, { agent: name })}
        checked={row.on}
        disabled={disabled}
        onChange={(on) => setDialog(on ? 'on' : 'off')}
      />
      {menu && (
        <Dropdown
          align="end"
          items={[
            {
              label: t('mcp.showFile'),
              onSelect: () => void scope.api.showItem(row.file),
            },
            {
              label: t('mcpTerminal.restoreMenu'),
              disabled: row.backedUpAt === null,
              onSelect: () => setDialog('backups'),
            },
            ...(row.on
              ? [{ label: t('mcpTerminal.turnOff'), onSelect: () => setDialog('off') }]
              : []),
          ]}
          trigger={({ open, toggle }) => (
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('mcpTerminal.menu', { agent: name })}
              aria-expanded={open}
              onClick={toggle}
            >
              <Icon icon={MoreHorizontalIcon} size={16} />
            </Button>
          )}
        />
      )}
      <TerminalDialogs row={row} dialog={dialog} close={() => setDialog(null)} />
    </>
  )
}

function TerminalDialogs({
  row,
  dialog,
  close,
}: {
  row: McpTerminalRow
  dialog: Dialog
  close(): void
}) {
  return (
    <>
      {dialog === 'on' && <TurnOnDialog target={row.target} close={close} />}
      {dialog === 'off' && <TurnOffDialog row={row} close={close} />}
      {dialog === 'drift' && <DriftDialog row={row} close={close} />}
      {dialog === 'backups' && <BackupsDialog row={row} close={close} />}
    </>
  )
}

/** Marketplace › MCP › Terminal and apps: one row per agent on this computer. */
export function TerminalGroup() {
  const { t } = useTranslation('marketplace')
  const { nameOf } = useWording()
  const { rows, error, reload } = useTerminalRows()
  const login = useLoginState()
  const [apply] = useApply()
  const shown = rows ?? []
  const using = shown.filter((row) => row.on).length
  return (
    <section className="ui-as-int-section k-mcp-section" aria-labelledby="k-mcp-terminal">
      <div className="k-mcp-section-head">
        <h2 id="k-mcp-terminal" className="ui-as-int-section__title">
          {t('mcpTerminal.title')}{' '}
          {rows && (
            <span className="text-muted-foreground">
              {t('mcpTerminal.count', { using, count: shown.length })}
            </span>
          )}
        </h2>
      </div>
      <p className="k-mkt-section-note">{t('mcpTerminal.lede')}</p>
      {error && (
        <QuietNote
          action={
            <Button size="sm" variant="ghost" onClick={reload}>
              {t('mcp.retry')}
            </Button>
          }
        >
          {t('mcpTerminal.failed')}
        </QuietNote>
      )}
      {!rows && !error && <SkeletonRows rows={3} />}
      <div className="k-mcp-rows">
        {shown.map((row) => (
          <ItemRow
            key={row.target}
            title={nameOf(row.target)}
            icon={<TargetIcon target={row.target} />}
            meta={<RowFacts row={row} />}
            line={null}
            end={<TerminalControls row={row} />}
          />
        ))}
      </div>
      {login.local && !login.on && using > 0 && (
        <div className="k-mcp-terminal-login" role="status">
          <Icon icon={Alert02Icon} size={15} />
          <span>{t('mcpTerminal.loginNote')}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => apply({ general: { openAtLogin: true } })}
          >
            {t('mcpTerminal.openAtLogin')}
          </Button>
        </div>
      )}
    </section>
  )
}

/** The row on an agent's page in Settings, the same switch as in the Marketplace. */
export function AgentTerminalRow({ agentId }: { agentId: AgentId }) {
  const { t } = useTranslation('marketplace')
  const { rows } = useTerminalRows()
  const row = rows?.find((item) => item.target === agentId)
  if (!row) return null
  return (
    <RowFrame
      id="mcp-terminal"
      text={
        <RowText
          name={t('mcpTerminal.alsoInTerminal')}
          description={
            <span className="k-mcp-terminal-meta">
              <RowFacts row={row} />
            </span>
          }
        />
      }
    >
      <TerminalControls row={row} />
    </RowFrame>
  )
}

function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="k-mcp-terminal-group">
      <h3>
        {title} <span className="text-muted-foreground">{count}</span>
      </h3>
      <div className="k-mcp-terminal-box">{children}</div>
    </section>
  )
}

function Entry({
  icon,
  name,
  detail,
  tag,
  tone,
}: {
  icon: typeof File01Icon
  name: string
  detail?: ReactNode
  tag: string
  tone?: 'added' | 'removed'
}) {
  return (
    <div className="k-mcp-terminal-entry">
      <Icon icon={icon} size={14} />
      <code className="k-mkt-mono">{name}</code>
      <span className="k-mcp-terminal-detail">{detail}</span>
      <span className="k-mcp-terminal-tag" data-tone={tone}>
        {tag}
      </span>
    </div>
  )
}

function Note({
  icon,
  children,
  warn,
}: {
  icon: typeof File01Icon
  children: ReactNode
  warn?: boolean
}) {
  return (
    <p className="k-mcp-terminal-note" data-warn={warn || undefined}>
      <Icon icon={icon} size={14} />
      <span>{children}</span>
    </p>
  )
}

/** Turning it on: what changes, in plain words, with the exact change under them. */
function TurnOnDialog({ target, close }: { target: McpTerminalTarget; close(): void }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const { nameOf, say } = useWording()
  const login = useLoginState()
  const [apply] = useApply()
  const [plan, setPlan] = useState<McpTerminalPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [atLogin, setAtLogin] = useState(true)
  const [exact, setExact] = useState(false)
  const [working, setWorking] = useState(false)
  const name = nameOf(target)
  const app = terminalApp(target)
  useEffect(() => {
    let live = true
    scope.request('market.mcpTerminalPlan', { target }).then(
      (next) => live && setPlan(next),
      (reason: unknown) => live && setError(failed(reason)),
    )
    return () => {
      live = false
    }
  }, [scope, target])
  const turnOn = async () => {
    if (!plan) return
    setWorking(true)
    try {
      await scope.request('market.mcpTerminalOn', { target, planId: plan.id })
      if (login.local && !login.on && atLogin) apply({ general: { openAtLogin: true } })
      toast(say('turnedOn', target, { agent: name }), undefined, { tone: 'success' })
      void scope.useMarketplaceStore.getState().loadTerminal()
      close()
    } catch (reason) {
      setError(failed(reason))
      setWorking(false)
    }
  }
  const servers = plan?.files.find((file) => file.kind === 'servers')
  const tools = plan?.files.find((file) => file.kind === 'tools')
  return (
    <McpConfirmation
      open
      onOpenChange={(open) => !open && close()}
      title={say('onTitle', target, { agent: name })}
    >
      <SettingsDialogBody className="k-mcp-terminal-dialog">
        {!plan && !error && <Spinner />}
        {error && <p className="k-mcp-terminal-error">{error}</p>}
        {plan && (
          <>
            <p className="k-mcp-terminal-sub">
              {t('mcpTerminal.onSub', { count: plan.files.length })}
            </p>
            {plan.files.map((file) => (
              <div className="k-mcp-terminal-file" key={file.path}>
                <Icon icon={File01Icon} size={15} />
                <div>
                  <code className="k-mkt-mono">{homeShort(file.path)}</code>
                  <span>
                    {file.kind === 'servers'
                      ? t('mcpTerminal.onlyKey', { key: file.keys.join(', ') })
                      : t('mcpTerminal.toolsKey', {
                          count: file.tools ?? 0,
                          key: file.keys.join(', '),
                        })}
                  </span>
                </div>
                <SetButton
                  size="sm"
                  variant="ghost"
                  onClick={() => void scope.api.showItem(file.path)}
                >
                  {t('mcpTerminal.show')}
                </SetButton>
              </div>
            ))}
            {app && (
              <Note icon={InformationCircleIcon}>{t('mcpTerminal.app.rule', { agent: name })}</Note>
            )}
            {plan.imports.length > 0 && (
              <Group
                title={t(app ? 'mcpTerminal.app.importsFirst' : 'mcpTerminal.importsFirst', {
                  agent: name,
                })}
                count={plan.imports.length}
              >
                {plan.imports.map((item) => (
                  <Entry
                    key={item.name}
                    icon={item.keys ? Key01Icon : File01Icon}
                    name={item.name}
                    detail={
                      item.keys ? (
                        <span className="k-mcp-warning">{t('mcpTerminal.keyMoves')}</span>
                      ) : (
                        <code className="k-mkt-mono">{item.command}</code>
                      )
                    }
                    tag={t('mcpTerminal.imported')}
                  />
                ))}
              </Group>
            )}
            <Group title={t('mcpTerminal.thenGets', { agent: name })} count={plan.entries.length}>
              {plan.entries.length === 0 && (
                <p className="k-mkt-section-note">{say('noServers', target, {})}</p>
              )}
              {plan.entries.map((entry) => (
                <Entry
                  key={entry.name}
                  icon={File01Icon}
                  name={entry.name}
                  tag={t(entry.replaces ? 'mcpTerminal.replaces' : 'mcpTerminal.added')}
                  tone={entry.replaces ? undefined : 'added'}
                />
              ))}
            </Group>
            <Note icon={Shield01Icon}>{t('mcpTerminal.bridgeNote')}</Note>
            {login.local && !login.on && (
              <label className="k-mcp-terminal-check">
                <Checkbox
                  checked={atLogin}
                  onCheckedChange={(value) => setAtLogin(value === true)}
                />
                <span>
                  <b>{t('mcpTerminal.openAtLogin')}</b>
                  <small>{t('mcpTerminal.loginHint')}</small>
                </span>
              </label>
            )}
            <button
              type="button"
              className="k-mcp-terminal-expander"
              aria-expanded={exact}
              onClick={() => setExact((value) => !value)}
            >
              <Icon icon={ArrowRight01Icon} size={14} />
              {t('mcpTerminal.exact')}
            </button>
            {exact && (
              <div className="k-mcp-terminal-diffs">
                {[servers, tools].map(
                  (file) =>
                    file && (
                      <Diff
                        key={file.path + file.kind}
                        path={file.path}
                        oldText={file.before}
                        newText={file.after}
                      />
                    ),
                )}
              </div>
            )}
          </>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter start={<span>{say('restartNote', target, { agent: name })}</span>}>
        <SetButton size="md" variant="ghost" onClick={close}>
          {t('mcpTerminal.cancel')}
        </SetButton>
        <SetButton size="md" variant="primary" disabled={!plan || working} onClick={turnOn}>
          {t('mcpTerminal.turnOn')}
        </SetButton>
      </SettingsDialogFooter>
    </McpConfirmation>
  )
}

function TurnOffDialog({ row, close }: { row: McpTerminalRow; close(): void }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const { nameOf, say } = useWording()
  const [plan, setPlan] = useState<McpTerminalOffPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const name = nameOf(row.target)
  useEffect(() => {
    let live = true
    scope.request('market.mcpTerminalOffPlan', { target: row.target }).then(
      (next) => live && setPlan(next),
      (reason: unknown) => live && setError(failed(reason)),
    )
    return () => {
      live = false
    }
  }, [scope, row.target])
  const turnOff = async () => {
    setWorking(true)
    try {
      await scope.request('market.mcpTerminalOff', { target: row.target })
      toast(say('turnedOff', row.target, { agent: name }), undefined, { tone: 'success' })
      void scope.useMarketplaceStore.getState().loadTerminal()
      close()
    } catch (reason) {
      setError(failed(reason))
      setWorking(false)
    }
  }
  return (
    <McpConfirmation
      open
      onOpenChange={(open) => !open && close()}
      title={say('offTitle', row.target, { agent: name })}
    >
      <SettingsDialogBody className="k-mcp-terminal-dialog">
        <p className="k-mcp-terminal-sub">
          {t('mcpTerminal.offSub', { agent: name, file: homeShort(row.file) })}
        </p>
        {!plan && !error && <Spinner />}
        {error && <p className="k-mcp-terminal-error">{error}</p>}
        {plan && plan.back.length > 0 && (
          <Group title={t('mcpTerminal.comeBack', { agent: name })} count={plan.back.length}>
            {plan.back.map((item) => (
              <Entry
                key={item.name}
                icon={item.keys ? Key01Icon : File01Icon}
                name={item.name}
                detail={
                  item.keys ? (
                    t('mcpTerminal.keyBack')
                  ) : (
                    <code className="k-mkt-mono">{item.command}</code>
                  )
                }
                tag={t('mcpTerminal.back')}
              />
            ))}
          </Group>
        )}
        {plan && plan.removed.length > 0 && (
          <Group title={t('mcpTerminal.removedGroup')} count={plan.removed.length}>
            {plan.removed.map((entry) => (
              <Entry
                key={entry}
                icon={File01Icon}
                name={entry}
                detail={say('goesWithout', row.target, { agent: name })}
                tag={t('mcpTerminal.removed')}
                tone="removed"
              />
            ))}
          </Group>
        )}
        {plan && (
          <Note icon={InformationCircleIcon}>
            {plan.tools > 0 ? t('mcpTerminal.offToolsNote') : t('mcpTerminal.offNote')}
          </Note>
        )}
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <SetButton size="md" variant="ghost" onClick={close}>
          {t('mcpTerminal.cancel')}
        </SetButton>
        <SetButton size="md" variant="primary" disabled={!plan || working} onClick={turnOff}>
          {t('mcpTerminal.turnOff')}
        </SetButton>
      </SettingsDialogFooter>
    </McpConfirmation>
  )
}

/** Entries changed outside Kettu: the user picks, for each, which one stays. */
function DriftDialog({ row, close }: { row: McpTerminalRow; close(): void }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const { nameOf, say } = useWording()
  const [drifts, setDrifts] = useState<McpTerminalDrift[] | null>(null)
  const [choices, setChoices] = useState<Record<string, McpTerminalChoice>>({})
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const name = nameOf(row.target)
  useEffect(() => {
    let live = true
    scope.request('market.mcpTerminalDrift', { target: row.target }).then(
      (next) => {
        if (!live) return
        setDrifts(next)
        setChoices(Object.fromEntries(next.map((item) => [item.name, 'file' as const])))
      },
      (reason: unknown) => live && setError(failed(reason)),
    )
    return () => {
      live = false
    }
  }, [scope, row.target])
  const applyChoices = async () => {
    setWorking(true)
    try {
      await scope.request('market.mcpTerminalResolve', { target: row.target, choices })
      void scope.useMarketplaceStore.getState().loadTerminal()
      void scope.useMarketplaceStore.getState().loadDiscovery()
      close()
    } catch (reason) {
      setError(failed(reason))
      setWorking(false)
    }
  }
  return (
    <McpConfirmation
      open
      onOpenChange={(open) => !open && close()}
      title={t('mcpTerminal.driftTitle', { agent: name })}
    >
      <SettingsDialogBody className="k-mcp-terminal-dialog">
        <p className="k-mcp-terminal-sub">
          {t('mcpTerminal.driftSub', { file: homeShort(row.file), count: row.changed })}
        </p>
        {!drifts && !error && <Spinner />}
        {error && <p className="k-mcp-terminal-error">{error}</p>}
        {drifts?.map((item) => (
          <section className="k-mcp-terminal-drift" key={item.name}>
            <h3>
              <code className="k-mkt-mono">{item.name}</code>
              <span
                className="k-mcp-terminal-tag"
                data-tone={item.kind === 'removed' ? 'removed' : 'warn'}
              >
                {t(
                  item.kind === 'changed' ? 'mcpTerminal.driftChanged' : 'mcpTerminal.driftRemoved',
                )}
              </span>
            </h3>
            <RadioGroup
              aria-label={item.name}
              value={choices[item.name]}
              onValueChange={(value) =>
                setChoices((current) => ({ ...current, [item.name]: value as McpTerminalChoice }))
              }
              className="kettu-sd__choices"
            >
              <Choice
                value="file"
                checked={choices[item.name] === 'file'}
                title={t(item.kind === 'changed' ? 'mcpTerminal.keepFile' : 'mcpTerminal.leaveOut')}
                description={
                  item.kind === 'changed'
                    ? [
                        item.command,
                        item.keys ? t('mcpTerminal.fileHasKey') : '',
                        t('mcpTerminal.keepFileHint', { agent: name }),
                      ]
                        .filter(Boolean)
                        .join(' · ')
                    : say('leaveOutHint', row.target, { agent: name })
                }
              />
              <Choice
                value="kettu"
                checked={choices[item.name] === 'kettu'}
                title={t('mcpTerminal.putBack')}
                description={t('mcpTerminal.putBackHint', { agent: name })}
              />
            </RadioGroup>
          </section>
        ))}
      </SettingsDialogBody>
      <SettingsDialogFooter start={<span>{t('mcpTerminal.backupAgain')}</span>}>
        <SetButton size="md" variant="ghost" onClick={close}>
          {t('mcpTerminal.later')}
        </SetButton>
        <SetButton size="md" variant="primary" disabled={!drifts || working} onClick={applyChoices}>
          {t('mcpTerminal.apply')}
        </SetButton>
      </SettingsDialogFooter>
    </McpConfirmation>
  )
}

function backupTitle(t: TFunction<'marketplace'>, item: McpTerminalBackup) {
  const when = mediumAgo(item.at)
  if (item.first) return t('mcpTerminal.beforeTakeover', { when })
  return t(`mcpTerminal.before.${item.reason}`, { when })
}

function BackupsDialog({ row, close }: { row: McpTerminalRow; close(): void }) {
  const { t } = useTranslation('marketplace')
  const scope = useHostScope()
  const [backups, setBackups] = useState<McpTerminalBackup[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    scope.request('market.mcpTerminalBackups', { target: row.target }).then(
      (next) => live && setBackups(next),
      (reason: unknown) => live && setError(failed(reason)),
    )
    return () => {
      live = false
    }
  }, [scope, row.target])
  const restore = async (backupId: string) => {
    setWorking(backupId)
    try {
      await scope.request('market.mcpTerminalRestore', { target: row.target, backupId })
      toast(t('mcpTerminal.restored', { file: homeShort(row.file) }), undefined, {
        tone: 'success',
      })
      void scope.useMarketplaceStore.getState().loadTerminal()
      close()
    } catch (reason) {
      setError(failed(reason))
      setWorking(null)
    }
  }
  return (
    <McpConfirmation
      open
      onOpenChange={(open) => !open && close()}
      title={t('mcpTerminal.restoreTitle', { file: homeShort(row.file) })}
    >
      <SettingsDialogBody className="k-mcp-terminal-dialog">
        <p className="k-mcp-terminal-sub">{t('mcpTerminal.restoreSub')}</p>
        {!backups && !error && <Spinner />}
        {error && <p className="k-mcp-terminal-error">{error}</p>}
        {backups && (
          <div className="k-mcp-terminal-box">
            {backups.map((item) => (
              <div className="k-mcp-terminal-backup" key={item.id}>
                <Icon icon={Clock01Icon} size={14} />
                <div>
                  <b>{backupTitle(t, item)}</b>
                  <small>
                    {item.first
                      ? t('mcpTerminal.ownAsYouHad')
                      : t('mcpTerminal.kettuServers', { count: item.servers })}
                  </small>
                </div>
                <Button
                  size="sm"
                  variant={item.first ? 'primary' : 'secondary'}
                  disabled={working !== null}
                  onClick={() => void restore(item.id)}
                >
                  {t('mcpTerminal.restore')}
                </Button>
              </div>
            ))}
          </div>
        )}
        <Note icon={Alert02Icon} warn>
          {t('mcpTerminal.restoreWarn')}
        </Note>
        <Note icon={LockIcon}>{t('mcpTerminal.sealed')}</Note>
      </SettingsDialogBody>
      <SettingsDialogFooter>
        <SetButton size="md" variant="ghost" onClick={close}>
          {t('mcpTerminal.cancel')}
        </SetButton>
      </SettingsDialogFooter>
    </McpConfirmation>
  )
}
