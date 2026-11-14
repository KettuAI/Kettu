import type { ReactNode } from 'react'
import {
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  ComputerTerminal01Icon,
  KeyboardIcon,
  LinkSquare02Icon,
  LockPasswordIcon,
  PlayIcon,
  RepeatIcon,
  StopCircleIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { CodeBlock } from 'streamdown'
import type { Platform } from '@shared/platform'
import { replyCommandProblem } from '@shared/terminal-agent'
import { emitAppEvent } from '@renderer/app/events'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { clock, duration } from '@renderer/lib/format'
import { errorMessage, host, sessionHost } from '@renderer/lib/host'
import { useSeconds } from '@renderer/lib/use-now'
import { agentName } from '@renderer/stores/agents'
import { useTerminalAllowed } from '@renderer/stores/hosts'
import {
  replyRunKey,
  replyRunProblem,
  replyRunStarted,
  replyRunStarting,
  useReplyRunsStore,
  type ReplyRun,
} from '@renderer/stores/reply-runs'
import { useSessionsStore } from '@renderer/stores/sessions'
import {
  interruptTerminal,
  loadTerminals,
  revealTerminal,
  useTerminalsStore,
} from '@renderer/stores/terminals'
import { BlockCopy } from './block-frame'
import { blockCommand, isTranscript } from './command'

/**
 * A shell block of an agent's reply as a command bar: every line after a faint `$`, wrapped so all
 * of it shows before it runs, with Copy and Run. Run starts a new terminal of the session; the bar
 * then grows the run's state and its last lines underneath.
 */
export function CommandBar({
  sessionId,
  code,
  language,
  isIncomplete,
  platform,
}: {
  sessionId: string
  code: string
  language: string
  isIncomplete: boolean
  platform: Platform
}) {
  const { t } = useTranslation('session')
  const command = blockCommand(code, language)
  const transcript = isTranscript(language)
  const session = useSessionsStore((s) => s.byId[sessionId])
  const hostId = sessionHost(sessionId)
  const allowed = useTerminalAllowed(session?.projectPath ?? '')
  const key = replyRunKey(sessionId, command)
  const run = useReplyRunsStore((s) => s.byKey[key] ?? null)
  const starting = useReplyRunsStore((s) => key in s.starting)
  const problem = useReplyRunsStore((s) => s.problems[key] ?? null)
  const runnable =
    !isIncomplete && session !== undefined && allowed && replyCommandProblem(command) === null
  const agent = session ? agentName(session.agentId, hostId) : ''

  const start = async (notify: boolean) => {
    if (!session) return
    replyRunStarting(key, true)
    replyRunProblem(key, null)
    try {
      // A window hears a terminal host's terminals only once it has asked it something, and the
      // run's terminal and its first output come before the answer.
      await loadTerminals(session.projectPath)
      const result = await host('sessions.runCommand', { sessionId, command, notify })
      replyRunStarted(key, result.terminalId, notify, platform !== 'win32')
      if (notify && !result.notified) replyRunProblem(key, t('command.notNotified', { agent }))
    } catch (error) {
      replyRunProblem(key, t('command.failed', { message: errorMessage(error) }))
    } finally {
      replyRunStarting(key, false)
    }
  }

  return (
    <div
      data-block-frame=""
      className="command-bar"
      data-transcript={transcript || undefined}
      data-run={run ? '' : undefined}
    >
      <div className="command-bar-main">
        <div className="command-bar-code">
          <CodeBlock
            code={code}
            language={transcript ? 'shellsession' : language}
            isIncomplete={isIncomplete}
            lineNumbers={false}
          />
        </div>
        <div className="command-bar-actions">
          <BlockCopy text={command} label={t('block.copy')} />
          {runnable && !run && (
            <RunButton
              agent={agent}
              starting={starting}
              onRun={(notify) => void start(notify)}
              onPut={() => emitAppEvent({ kind: 'run-in-terminal', panel: sessionId, command })}
            />
          )}
        </div>
      </div>
      {run && (
        <RunArea
          run={run}
          canRun={runnable && !starting}
          onRunAgain={() => void start(run.notify)}
        />
      )}
      {problem && (
        <p className="command-bar-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  )
}

/** Run, with its options behind the chevron: Run only, and Put in terminal without Enter. */
function RunButton({
  agent,
  starting,
  onRun,
  onPut,
}: {
  agent: string
  starting: boolean
  onRun: (notify: boolean) => void
  onPut: () => void
}) {
  const { t } = useTranslation('session')
  return (
    <span className="command-run-button" data-starting={starting || undefined}>
      <button
        type="button"
        className="command-run-button__go"
        disabled={starting}
        onClick={() => onRun(true)}
      >
        <HugeiconsIcon icon={PlayIcon} strokeWidth={1.9} aria-hidden />
        {t('command.run')}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="command-run-button__more"
              aria-label={t('command.more')}
              disabled={starting}
            />
          }
        >
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={1.9} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <MenuEntry
            icon={PlayIcon}
            tone="run"
            label={t('command.run')}
            note={t('command.runNote', { agent })}
            onClick={() => onRun(true)}
          />
          <MenuEntry
            icon={ComputerTerminal01Icon}
            label={t('command.runOnly')}
            note={t('command.runOnlyNote', { agent })}
            onClick={() => onRun(false)}
          />
          <DropdownMenuSeparator />
          <MenuEntry
            icon={KeyboardIcon}
            label={t('command.put')}
            note={t('command.putNote')}
            onClick={onPut}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

function MenuEntry({
  icon,
  tone,
  label,
  note,
  onClick,
}: {
  icon: IconSvgElement
  tone?: 'run'
  label: string
  note: string
  onClick: () => void
}) {
  return (
    <DropdownMenuItem onClick={onClick} className="items-start py-1.5">
      <HugeiconsIcon
        icon={icon}
        strokeWidth={1.9}
        aria-hidden
        className={tone === 'run' ? 'mt-0.5 text-success' : 'mt-0.5'}
      />
      <span className="flex min-w-0 flex-col">
        {label}
        <span className="text-xs text-tertiary">{note}</span>
      </span>
    </DropdownMenuItem>
  )
}

type RunState = 'running' | 'password' | 'ended' | 'gone'

/** Under the bar once it ran: one line of state with its actions, and the terminal's last lines. */
function RunArea({
  run,
  canRun,
  onRunAgain,
}: {
  run: ReplyRun
  canRun: boolean
  onRunAgain: () => void
}) {
  const { t } = useTranslation('session')
  const terminal = useTerminalsStore((s) => s.byId[run.terminalId] ?? null)
  const state: RunState =
    !terminal || terminal.stale
      ? 'gone'
      : terminal.waiting === 'password'
        ? 'password'
        : run.endedAt !== null || terminal.exitCode !== null
          ? 'ended'
          : 'running'
  const name = terminal ? (terminal.name ?? (terminal.title || terminal.shell)) : ''
  const exitCode = terminal?.exitCode ?? null
  const took = run.endedAt === null ? null : duration(run.endedAt - run.startedAt)
  const open = () => revealTerminal(run.terminalId)
  const stop = () => void interruptTerminal(run.terminalId)
  const again = canRun && (
    <RunAction icon={RepeatIcon} label={t('command.runAgain')} onClick={onRunAgain} />
  )

  let line: ReactNode
  let actions: ReactNode
  switch (state) {
    case 'running':
      line = (
        <>
          <span className="command-run-state__dot" aria-hidden />
          <b>{t('command.state.running')}</b>
          <Elapsed since={run.startedAt} />
          <span className="command-run-state__sep">·</span>
          <span className="command-run-state__name">{name}</span>
        </>
      )
      actions = (
        <>
          <RunAction icon={LinkSquare02Icon} label={t('command.openTerminal')} onClick={open} />
          <RunAction icon={StopCircleIcon} label={t('command.stop')} onClick={stop} danger />
        </>
      )
      break
    case 'password':
      line = (
        <>
          <HugeiconsIcon icon={LockPasswordIcon} strokeWidth={1.9} aria-hidden />
          <b>{t('command.state.password')}</b>
          <span className="command-run-state__sep">·</span>
          <span className="command-run-state__name">{name}</span>
        </>
      )
      actions = (
        <>
          <RunAction icon={KeyboardIcon} label={t('command.goType')} onClick={open} ask />
          <RunAction icon={StopCircleIcon} label={t('command.stop')} onClick={stop} danger />
        </>
      )
      break
    case 'ended':
      line =
        exitCode !== null ? (
          <>
            <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={1.9} aria-hidden />
            <b>{t('command.state.shellExited', { code: exitCode })}</b>
          </>
        ) : (
          <>
            <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={1.9} aria-hidden />
            <b>{t('command.state.ended')}</b>
            {took && <span className="command-run-state__time">{took}</span>}
          </>
        )
      actions = (
        <>
          <RunAction icon={LinkSquare02Icon} label={t('command.openTerminal')} onClick={open} />
          {again}
        </>
      )
      break
    case 'gone':
      line = (
        <>
          <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={1.9} aria-hidden />
          <span>{t('command.state.gone')}</span>
        </>
      )
      actions = again
  }

  const tail = (state === 'running' || state === 'password') && run.tail !== '' ? run.tail : null
  return (
    <div
      className="command-run"
      data-state={state}
      data-failed={(state === 'ended' && exitCode !== null && exitCode !== 0) || undefined}
    >
      <div className="command-run-head">
        <span className="command-run-state" role="status">
          {line}
        </span>
        <span aria-hidden className="flex-1" />
        {actions}
      </div>
      {tail !== null && <pre className="command-run-tail">{tail}</pre>}
    </div>
  )
}

/** How long a run has gone, ticking each second while on screen. */
function Elapsed({ since }: { since: number }) {
  const now = useSeconds()
  return <span className="command-run-state__time">{clock((now - since) / 1000)}</span>
}

function RunAction({
  icon,
  label,
  onClick,
  danger,
  ask,
}: {
  icon: IconSvgElement
  label: string
  onClick: () => void
  danger?: boolean
  ask?: boolean
}) {
  return (
    <button
      type="button"
      className="command-run-action"
      data-danger={danger || undefined}
      data-ask={ask || undefined}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <HugeiconsIcon icon={icon} strokeWidth={1.9} aria-hidden />
      <span className="command-run-action__label">{label}</span>
    </button>
  )
}
