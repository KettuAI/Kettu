// What the Agent and Harness sections of Settings both draw: reading an agent's account and
// usage, its plan meters, sign-in, task logs and the rows of its configuration.

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  Cancel01Icon,
  ComputerTerminal01Icon,
  Copy01Icon,
  RefreshIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentStatus, AgentTask, PlanLimit } from '@shared/agent-host'
import { Icon } from '@renderer/components/affect/app-shell'
import { useRefresh } from '@renderer/components/refresh'
import { codeSpans } from '@renderer/features/session/entries/helpers'
import { planReset } from '@renderer/features/sidebar/plan-usage'
import { addDays, dayOf, monthStartOf } from '@renderer/features/usage/model'
import { limitLabel, mediumAgo, money } from '@renderer/lib/format'
import { useLimitView } from '@renderer/hooks/use-limit-view'
import { errorMessage } from '@renderer/lib/host'
import { newestLimits } from '@renderer/lib/plan-readings'
import { limitLevel, limitPercent } from '@renderer/lib/plan-limit'
import { useNow } from '@renderer/lib/use-now'
import { openSignInPage, usePlanReadings } from '@renderer/stores/agents'
import { useHostScope } from '@renderer/stores/host-scope'
import { openHarnessSettings } from '@renderer/stores/view'
import { limitsReadable, percent, useAction } from './agent-helpers'
import { CommandLine, ControlError, IconAction, Meter, SetButton, Spin } from './controls'
import { Group, GroupLabel, Notice, RowFrame, RowGroup, RowShell, RowText } from './rows'
import { agentCost } from './spend'

/** The window nearest its limit as a list row's end: its label and percent over a 4 px bar. */
export function ListMeter({ limits }: { limits: PlanLimit[] }) {
  const { t } = useTranslation(['settings', 'composer'])
  const view = useLimitView()
  const limit = limits.reduce((most, next) =>
    (next.usedPercent ?? 0) > (most.usedPercent ?? 0) ? next : most,
  )
  return (
    <span className="k-end" title={limitLabel(limit)}>
      <span className="k-meter">{limitLabel(limit)}</span>
      <Meter
        value={limitPercent(limit, view) ?? 0}
        level={limitLevel(limit)}
        text={percent(limit, view)}
        label={t(view === 'left' ? 'composer:usage.limits.left' : 'composer:usage.limits.used', {
          limit: limitLabel(limit),
        })}
      />
    </span>
  )
}

/** A message from the host with its `code` spans set as code. */
export function WithCode({ text }: { text: string }) {
  return codeSpans(text).map((part, i) => (
    <Fragment key={i}>
      {part.code ? <code className="k-code">{part.text}</code> : part.text}
    </Fragment>
  ))
}

/** The small x at a notice's end that puts it away. */
export function DismissButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('settings')
  return <IconAction label={t('agents.task.dismiss')} icon={Cancel01Icon} onClick={onClick} />
}

/**
 * What an agent that needs a sign-in asks: its command in a terminal, or a way it signs in itself.
 * Without `onTerminal`, as for another host whose terminal this window cannot open, the command is
 * only shown to copy. While the page a sign-in handed over is open here, it says so, with Cancel.
 */
/**
 * Who a harness whose vendor moved some accounts elsewhere is still for, and the way to the harness
 * they went to: on its Harness page always, on an agent's page once it refused its account.
 */
export function MovedAccountsNotice({ status }: { status: AgentStatus }) {
  const { useAgentsStore } = useHostScope()
  const { t } = useTranslation('settings')
  const moved = status.movedAccounts
  const to = useAgentsStore((s) => (moved && s.byId[moved.to]?.harnessName) || moved?.to)
  if (!moved || !to) return null
  return (
    <Notice
      variant={moved.refused ? 'warning' : 'info'}
      title={
        moved.refused
          ? t('harnesses.movedAccounts.refused', { agent: status.name })
          : t('harnesses.movedAccounts.title', { name: status.harnessName })
      }
      action={
        <SetButton
          variant={moved.refused ? 'primary' : 'secondary'}
          onClick={() => openHarnessSettings(moved.to)}
        >
          {t('harnesses.movedAccounts.open', { name: to })}
        </SetButton>
      }
    >
      {moved.audience}
    </Notice>
  )
}

export function SignInNotice({
  status,
  busy,
  page,
  remote,
  onTerminal,
  onAuthenticate,
  onCancel,
}: {
  status: AgentStatus
  busy: boolean
  /** The sign-in page this window opened, while the agent waits for it. */
  page: string | null
  /** This window is a device of the agent's host, which sees no browser the agent opens there. */
  remote: boolean
  onTerminal?: (command: string) => void
  onAuthenticate: (methodId: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation(['settings', 'session', 'common'])
  if (page !== null) {
    return (
      <Notice
        variant="info"
        icon={<Spin />}
        title={t('session:signIn.pageOpen')}
        action={
          <>
            <SetButton onClick={() => openSignInPage(page)}>
              {t('session:signIn.openPageAgain')}
            </SetButton>
            <SetButton variant="ghost" onClick={onCancel}>
              {t('common:actions.cancel')}
            </SetButton>
          </>
        }
      >
        {t('session:signIn.pageOpenHint', { agent: status.name })}
      </Notice>
    )
  }
  const inTerminal = status.authMethods.filter((m) => m.type === 'terminal' && m.command)
  const first = inTerminal[0]
  // A method that opens a browser where the agent runs cannot be finished from here.
  const elsewhere = status.authMethods.find((m) => remote && m.type === 'agent' && !m.delegated)
  // An `env` method is filled in on the agent's page; the agent has nothing to authenticate.
  const others = status.authMethods.filter(
    (m) =>
      m !== first &&
      m.type !== 'env' &&
      (onTerminal || m.type !== 'terminal') &&
      !(remote && m.type === 'agent' && !m.delegated),
  )
  return (
    <Notice
      variant="warning"
      title={t('agents.signInTitle', { name: status.name })}
      action={
        first?.command &&
        onTerminal && (
          <SetButton
            variant="primary"
            icon={<Icon icon={ComputerTerminal01Icon} size={14} />}
            onClick={() => onTerminal(first.command!)}
          >
            {t('session:signIn.inTerminal')}
          </SetButton>
        )
      }
      more={
        (first?.command || others.length > 0) && (
          <>
            {first?.command && <CommandLine command={first.command} />}
            {others.length > 0 && (
              <span className="k-end k-wrap">
                {others.map((method) =>
                  method.type === 'terminal' && method.command ? (
                    <SetButton key={method.id} onClick={() => onTerminal?.(method.command!)}>
                      {method.name}
                    </SetButton>
                  ) : (
                    <SetButton
                      key={method.id}
                      variant={first ? 'secondary' : 'primary'}
                      disabled={busy}
                      title={method.description}
                      onClick={() => onAuthenticate(method.id)}
                    >
                      {method.name}
                    </SetButton>
                  ),
                )}
              </span>
            )}
          </>
        )
      }
    >
      {(first?.description || elsewhere) && (
        <>
          {first?.description && <div>{first.description}</div>}
          {elsewhere && (
            <div>{t('agents.signInOnComputer', { method: elsewhere.name, name: status.name })}</div>
          )}
        </>
      )}
    </Notice>
  )
}

export function TaskLog({ task }: { task: AgentTask }) {
  const lines = task.progress.length > 0 ? task.progress : [task.command]
  return <Log lines={lines} error={task.state === 'failed'} />
}

/** A task's output, newest line last and in view: in the text color, or the danger one once failed. */
export function Log({ lines, error }: { lines: string[]; error?: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])
  return (
    <div ref={box} role="log" data-selectable="" className="k-log">
      {lines.map((line, i) => {
        const last = i === lines.length - 1
        return (
          <span
            key={i}
            data-last={(last && !error) || undefined}
            data-failed={(last && error) || undefined}
            title={line}
          >
            {line}
          </span>
        )
      })}
    </div>
  )
}

export function LogCopyButton({ task }: { task: AgentTask }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  return (
    <SetButton
      variant="ghost"
      icon={<Icon icon={copied ? Tick02Icon : Copy01Icon} size={14} />}
      onClick={() => {
        const text = [`$ ${task.command}`, ...task.progress, task.error ?? ''].join('\n')
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {t('agents.install.copyLog')}
    </SetButton>
  )
}

/** Plan usage, one row per window, read afresh while the page shows. */
/**
 * What Kettu sent through an agent signed in with an API key this month, by its own record: an
 * API key has no plan limits to read.
 */
export function SpendGroup({
  status,
  providers = false,
}: {
  status: AgentStatus
  /** A provider-based agent: its provider usage is read elsewhere. */
  providers?: boolean
}) {
  const { request } = useHostScope()
  const { t } = useTranslation('settings')
  // undefined while it is read; null when no model it used has a price.
  const [cost, setCost] = useState<number | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const today = dayOf(Date.now())
    const from = monthStartOf(today)
    const to = addDays(today, 1)
    request('usage.summary', { dayStarts: [from, to], from, to, scope: 'kettu' }).then(
      (summary) => {
        if (!cancelled) setCost(agentCost(summary.days, status.id))
      },
      (e: unknown) => {
        if (!cancelled) setError(errorMessage(e))
      },
    )
    return () => {
      cancelled = true
    }
  }, [request, status.id])
  return (
    <Group label={t('agents.spend.group')}>
      <RowFrame
        text={
          <RowText
            name={t('agents.spend.month')}
            description={t(
              providers ? 'agents.spend.descriptionProviders' : 'agents.spend.description',
              { name: status.harnessName },
            )}
          />
        }
      >
        <ControlError error={error} />
        {cost === undefined ? (
          !error && <Spin />
        ) : (
          <span className="k-figure">
            {cost === null ? t('agents.spend.unpriced') : money(cost, 'USD')}
          </span>
        )}
      </RowFrame>
    </Group>
  )
}

export function UsageGroup({
  status,
  reading,
  running,
}: {
  status: AgentStatus
  reading: boolean
  running: boolean
}) {
  const { request } = useHostScope()
  const { t } = useTranslation(['settings', 'composer'])
  const view = useLimitView()
  const now = useNow()
  const [act, busy, error] = useAction()
  const refresh = useRefresh()
  const [refreshError, setRefreshError] = useState<string | null>(null)
  // The account's newest reading, which may be another host's.
  const limits = newestLimits(usePlanReadings(), status)
  const observed = Math.max(0, ...limits.map((l) => l.observedAt)) || null
  const limitsReason = status.limitsReason
    ? t(`agents.usageReasons.${status.limitsReason}` as 'agents.usageReasons.vendor-disallows')
    : null
  // A read this page asked for, else the host's record of the last read, whoever asked for it.
  const readError = error ?? refreshError ?? status.limitsError ?? null
  const actions =
    limits.length > 0 && limitsReadable(status) ? (
      <>
        {observed && (
          <span className="k-muted">
            {t('agents.usageUpdated', { ago: mediumAgo(observed, now) })}
          </span>
        )}
        <IconAction
          label={t('agents.refreshUsage')}
          icon={RefreshIcon}
          busy={refresh.phase === 'turning'}
          onClick={() => {
            setRefreshError(null)
            void refresh
              .run(() => request('agents.refreshLimits', { agentId: status.id, force: true }))
              .catch((e: unknown) => setRefreshError(errorMessage(e)))
          }}
        />
      </>
    ) : null
  return (
    <section className="k-group" aria-label={t('agents.usage')}>
      <GroupLabel group={{ id: 'usage', label: t('agents.usage'), actions }} />
      {limits.length > 0 ? (
        <RowGroup>
          {limits.map((limit) => {
            const level = limitLevel(limit)
            return (
              <RowFrame
                key={limit.window}
                text={
                  <RowText
                    name={limitLabel(limit)}
                    description={limit.resetsAt ? planReset(limit.resetsAt, now) : undefined}
                  />
                }
              >
                <Meter
                  long
                  value={limitPercent(limit, view) ?? 0}
                  level={level}
                  text={percent(limit, view)}
                  label={t(
                    view === 'left' ? 'composer:usage.limits.left' : 'composer:usage.limits.used',
                    { limit: limitLabel(limit) },
                  )}
                />
              </RowFrame>
            )
          })}
        </RowGroup>
      ) : limitsReason ? (
        <p className="k-reading">{limitsReason}</p>
      ) : reading && status.capabilities.reports ? (
        <p className="k-reading">{t('agents.readingUsage')}</p>
      ) : status.signIn === 'required' && status.capabilities.reports ? (
        <p className="k-reading">{t('agents.usageAfterSignIn', { name: status.name })}</p>
      ) : limitsReadable(status) && (!running || readError) ? (
        <RowGroup>
          <RowFrame text={<RowText name={t('agents.planLimits')} />}>
            <ControlError error={readError} />
            <SetButton
              loading={busy}
              onClick={() =>
                act(() => request('agents.refreshLimits', { agentId: status.id, force: true }))
              }
            >
              {t('agents.checkLimits')}
            </SetButton>
          </RowFrame>
        </RowGroup>
      ) : (
        <p className="k-reading">{t('agents.usageNotReported', { name: status.name })}</p>
      )}
      {readError && limits.length > 0 && (
        <p className="ui-sg-hint k-error" data-wrap="">
          {readError}
        </p>
      )}
    </section>
  )
}

/** A name and its value; "Not reported" while the agent has not said. */
export function Fact({
  name,
  mono,
  children,
}: {
  name: string
  mono?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation('settings')
  return (
    <RowFrame text={<RowText name={name} />}>
      {children ? (
        // A mask's box reaches past the column, so its blur ends where the text above does.
        <span
          className={mono ? 'k-fact k-mono k-mask-pad' : 'k-fact k-mask-pad'}
          data-selectable=""
        >
          {children}
        </span>
      ) : (
        <span className="k-fact k-muted">{t('agents.notReported')}</span>
      )}
    </RowFrame>
  )
}

/** A row of the Configuration group: its name and line, then its place and notes under them. */
export function ConfigFrame({
  name,
  description,
  control,
  children,
}: {
  name: string
  description?: ReactNode
  control?: ReactNode
  children?: ReactNode
}) {
  return (
    <RowShell>
      <div className="k-block">
        <div className="k-line">
          <RowText name={name} description={description} />
          {control && <span className="ui-sg-control">{control}</span>}
        </div>
        {children}
      </div>
    </RowShell>
  )
}
