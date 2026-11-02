// What the Agent and Harness sections of Settings both draw: reading an agent's account and
// usage, its plan meters, sign-in, task logs and the rows of its configuration.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { CheckIcon, CopyIcon, LogInIcon, SquareTerminalIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentStatus, AgentTask, PlanLimit } from '@shared/agent-host'
import { useRefresh } from '@renderer/components/refresh'
import { RefreshIcon } from '@renderer/components/refresh-icon'
import { Button } from '@renderer/components/ui/button'
import { Progress } from '@renderer/components/ui/progress'
import { Spinner } from '@renderer/components/ui/spinner'
import { countdown } from '@renderer/features/sidebar/plan-usage'
import { limitLabel, longAgo, resetTime } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { LIMIT_TEXT, limitLevel } from '@renderer/lib/plan-limit'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useHostScope } from '@renderer/stores/host-scope'
import { limitsReadable, percent, useAction } from './agent-helpers'
import { ControlError, CopyAction, IconAction, ROW_BUTTON } from './controls'
import { GroupLabel, Notice, RowFrame, RowGroup, RowShell, RowText } from './rows'

/** The window nearest its limit as a list row's end: its label and percent over a 4 px bar. */
export function ListMeter({ limits }: { limits: PlanLimit[] }) {
  const { t } = useTranslation(['settings', 'composer'])
  const limit = limits.reduce((most, next) =>
    (next.usedPercent ?? 0) > (most.usedPercent ?? 0) ? next : most,
  )
  const level = limitLevel(limit)
  return (
    <span className="flex w-37.5 flex-col gap-1.25 tabular">
      <span className="flex justify-between text-meta leading-[normal] text-tertiary">
        <span>{limitLabel(limit)}</span>
        <span className={cn('text-primary', level !== 'ok' && LIMIT_TEXT[level])}>
          {percent(limit)}
        </span>
      </span>
      <Progress
        value={limit.usedPercent ?? 0}
        tone={`limit-${level}`}
        className="w-full [&_[data-slot=progress-indicator]]:rounded-full [&_[data-slot=progress-track]]:h-1 [&_[data-slot=progress-track]]:bg-border"
        aria-label={t('composer:usage.limits.used', { limit: limitLabel(limit) })}
      />
    </span>
  )
}

/** The small x at a notice's end that puts it away. */
export function DismissButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <IconAction label={t('agents.task.dismiss')} onClick={onClick}>
      <XIcon />
    </IconAction>
  )
}

/**
 * What an agent that needs a sign-in asks: its command in a terminal, or a way it signs in itself.
 * Without `onTerminal`, as for another host whose terminal this window cannot open, the command is
 * only shown to copy.
 */
export function SignInNotice({
  status,
  busy,
  onTerminal,
  onAuthenticate,
}: {
  status: AgentStatus
  busy: boolean
  onTerminal?: (command: string) => void
  onAuthenticate: (methodId: string) => void
}) {
  const { t } = useTranslation(['settings', 'session'])
  const inTerminal = status.authMethods.filter((m) => m.type === 'terminal' && m.command)
  const first = inTerminal[0]
  const others = status.authMethods.filter(
    (m) => m !== first && (onTerminal || m.type !== 'terminal'),
  )
  return (
    <Notice
      variant="warning"
      icon={<LogInIcon />}
      title={t('agents.signInTitle', { name: status.name })}
      action={
        first?.command &&
        onTerminal && (
          <Button className={ROW_BUTTON} onClick={() => onTerminal(first.command!)}>
            <SquareTerminalIcon data-icon="inline-start" />
            {t('session:signIn.inTerminal')}
          </Button>
        )
      }
      more={
        (first?.command || others.length > 0) && (
          <>
            {first?.command && (
              <div className="flex items-center gap-1.5 rounded-lg bg-code-block py-0.75 pr-0.75 pl-2.5 shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]">
                <code
                  className="min-w-0 flex-1 truncate font-mono text-code text-primary"
                  data-selectable=""
                  title={first.command}
                >
                  {first.command}
                </code>
                <CopyAction text={first.command} label={t('session:signIn.copyCommand')} />
              </div>
            )}
            {others.length > 0 && (
              <span className="flex flex-wrap gap-1.5">
                {others.map((method) =>
                  method.type === 'terminal' && method.command ? (
                    <Button
                      className={ROW_BUTTON}
                      key={method.id}

                      variant="outline"
                      onClick={() => onTerminal?.(method.command!)}
                    >
                      {method.name}
                    </Button>
                  ) : (
                    <Button
                      className={ROW_BUTTON}
                      key={method.id}

                      variant={first ? 'outline' : 'default'}
                      disabled={busy}
                      title={method.description}
                      onClick={() => onAuthenticate(method.id)}
                    >
                      {method.name}
                    </Button>
                  ),
                )}
              </span>
            )}
          </>
        )
      }
    >
      {first?.description}
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
    <div
      ref={box}
      role="log"
      data-selectable=""
      className="max-h-21.5 overflow-auto rounded-lg bg-code-block px-2.5 py-1.75 font-mono text-meta leading-4.5 text-tertiary shadow-[inset_0_0_0_var(--hairline)_var(--border-subtle)]"
    >
      {lines.map((line, i) => (
        <span
          key={i}
          className={cn(
            'block truncate',
            i === lines.length - 1 && (error ? 'text-danger' : 'text-primary'),
          )}
          title={line}
        >
          {line}
        </span>
      ))}
    </div>
  )
}

export function LogCopyButton({ task }: { task: AgentTask }) {
  const { t } = useTranslation('settings')
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"

      className={cn(ROW_BUTTON, 'text-secondary')}
      onClick={() => {
        const text = [`$ ${task.command}`, ...task.progress, task.error ?? ''].join('\n')
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
      {t('agents.install.copyLog')}
    </Button>
  )
}

/** Plan usage, one row per window, read afresh while the page shows. */
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
  const now = useNow()
  const [act, busy, error] = useAction()
  const refresh = useRefresh()
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const observed = Math.max(0, ...status.limits.map((l) => l.observedAt)) || null
  const actions =
    status.limits.length > 0 && limitsReadable(status) ? (
      <>
        {observed && (
          <span className="text-tertiary">
            {t('agents.usageUpdated', { ago: longAgo(observed, now) })}
          </span>
        )}
        <IconAction
          label={t('agents.refreshUsage')}
          disabled={refresh.phase === 'turning'}
          busy={refresh.phase === 'turning'}
          onClick={() => {
            setRefreshError(null)
            void refresh
              .run(() => request('agents.refreshLimits', { agentId: status.id }))
              .catch((e: unknown) => setRefreshError(errorMessage(e)))
          }}
        >
          <RefreshIcon phase={refresh.phase} />
        </IconAction>
      </>
    ) : null
  return (
    <section className="flex flex-col">
      <GroupLabel group={{ id: 'usage', label: t('agents.usage'), actions }} />
      {status.limits.length > 0 ? (
        <RowGroup>
          {status.limits.map((limit) => {
            const level = limitLevel(limit)
            const left = limit.resetsAt ? countdown(limit.resetsAt - now) : null
            return (
              <RowFrame
                key={limit.window}
                text={
                  <RowText
                    name={limitLabel(limit)}
                    description={
                      limit.resetsAt
                        ? left
                          ? t('agents.resetsIn', { time: left })
                          : t('agents.resetsAt', { time: resetTime(limit.resetsAt, now) })
                        : undefined
                    }
                  />
                }
              >
                <span className="flex items-center gap-3">
                  <Progress
                    value={limit.usedPercent ?? 0}
                    tone={`limit-${level}`}
                    className="w-42 [&_[data-slot=progress-track]]:h-1.5"
                    aria-label={t('composer:usage.limits.used', { limit: limitLabel(limit) })}
                  />
                  <span
                    className={cn(
                      'w-9 text-right text-command tabular',
                      level !== 'ok' && 'font-medium',
                      LIMIT_TEXT[level],
                    )}
                  >
                    {percent(limit)}
                  </span>
                </span>
              </RowFrame>
            )
          })}
        </RowGroup>
      ) : reading && status.capabilities.reports ? (
        <p className="py-1 text-group text-tertiary">{t('agents.readingUsage')}</p>
      ) : limitsReadable(status) && !running ? (
        <RowGroup>
          <RowFrame text={<RowText name={t('agents.planLimits')} />}>
            <ControlError error={error} />
            <Button
              className={ROW_BUTTON}
              variant="outline"

              disabled={busy}
              onClick={() => act(() => request('agents.refreshLimits', { agentId: status.id }))}
            >
              {busy && <Spinner data-icon="inline-start" />}
              {t('agents.checkLimits')}
            </Button>
          </RowFrame>
        </RowGroup>
      ) : (
        <p className="py-1 text-group text-tertiary">
          {t('agents.usageNotReported', { name: status.name })}
        </p>
      )}
      {(error ?? refreshError) && status.limits.length > 0 && (
        <p className="pt-2 text-hint text-danger">{error ?? refreshError}</p>
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
          className={cn(
            'has-data-[slot=masked]:-me-1.5',
            mono ? 'font-mono text-code text-tertiary' : 'text-lede text-secondary',
            'leading-[normal]',
          )}
          data-selectable=""
        >
          {children}
        </span>
      ) : (
        <span className="text-lede leading-[normal] text-tertiary">{t('agents.notReported')}</span>
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
      <div className="flex flex-col gap-1.5 py-3.75">
        <div className="flex min-h-7 items-center gap-7">
          <RowText name={name} description={description} />
          {control && <div className="ml-auto flex shrink-0 items-center gap-2">{control}</div>}
        </div>
        {children}
      </div>
    </RowShell>
  )
}
