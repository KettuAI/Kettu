import { useState } from 'react'
import { CheckIcon, SquareTerminalIcon, XIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { harnessOf, isAgentId } from '@shared/agents'
import type { ToolEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { cn } from '@renderer/lib/utils'
import { useTerminalAllowed } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import {
  BlockAction,
  BlockFrame,
  BlockSpacer,
} from '@renderer/features/session/markdown/block-frame'
import { ansiRuns, exitOf, shellTail } from './shell'

const TONE = {
  red: 'text-code-danger',
  green: 'text-code-success',
  dim: 'text-(--syntax-comment)',
  bold: 'font-bold text-primary',
} as const

// Past this the header cuts a command short, so it shows whole above the output too.
const LONG_COMMAND = 60

/**
 * A command and what it printed, as a terminal shows them: the command in the header with its
 * exit code on the right, and the output's last 12 lines, the earlier ones a click away. Only
 * red, green and dim survive of the output's colors.
 */
export function ShellBlock({
  sessionId,
  projectPath,
  command,
  output,
  status,
}: {
  sessionId: string
  projectPath: string
  command: string
  output: string | null
  status: ToolEntry['status']
}) {
  const { t } = useTranslation('session')
  const [all, setAll] = useState(false)
  const agentId = useSessionsStore((s) => s.byId[sessionId]?.agentId ?? null)
  const harness = agentId && isAgentId(agentId) ? harnessOf(agentId) : null
  const exit = exitOf(output, status, harness)
  const printed = exit.output?.replace(/\n$/, '') ?? ''
  const { shown, earlier } = shellTail(printed, all)
  const terminal = useTerminalAllowed(projectPath)
  const [first, ...more] = command.split('\n')
  // An approval shows only this block, so a long command must never hide behind the cut.
  const whole = more.length > 0 || command.length > LONG_COMMAND
  return (
    <BlockFrame
      data-selectable=""
      header={
        <>
          <SquareTerminalIcon aria-hidden className="size-3.25 shrink-0 text-tertiary" />
          <span className="block-frame-name font-mono text-xs text-primary" title={command}>
            <span className="text-(--syntax-comment) select-none">$ </span>
            {first}
            {more.length > 0 && <span className="text-tertiary"> …</span>}
          </span>
          <BlockSpacer />
          {exit.code !== null ? (
            <span
              className={cn(
                'shell-exit',
                exit.code === 0 ? 'text-code-success' : 'text-code-danger',
              )}
            >
              {exit.code === 0 ? (
                <CheckIcon aria-hidden strokeWidth={2} />
              ) : (
                <XIcon aria-hidden strokeWidth={2} />
              )}
              {t('block.exit', { code: exit.code })}
            </span>
          ) : (
            status === 'failed' && (
              <span className="shell-exit text-code-danger">
                <XIcon aria-hidden strokeWidth={2} />
                {t('status.failed')}
              </span>
            )
          )}
          {terminal && (
            <BlockAction
              label={t('block.openInTerminal')}
              onClick={() => emitAppEvent({ kind: 'run-in-terminal', panel: sessionId, command })}
            >
              <SquareTerminalIcon />
            </BlockAction>
          )}
        </>
      }
    >
      {whole && <pre className="shell-command">{command}</pre>}
      {earlier > 0 && (
        <button type="button" className="shell-earlier" onClick={() => setAll(true)}>
          {t('block.showEarlier', { count: earlier })}
        </button>
      )}
      {shown !== '' && (
        <pre className="shell-output">
          {ansiRuns(shown).map((run, i) =>
            run.tone ? (
              <span key={i} className={TONE[run.tone]}>
                {run.text}
              </span>
            ) : (
              run.text
            ),
          )}
        </pre>
      )}
    </BlockFrame>
  )
}
