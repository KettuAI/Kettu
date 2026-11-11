import { useState } from 'react'
import { ArrowUp01Icon, ComputerTerminal01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import { harnessOf, isAgentId } from '@shared/agents'
import type { ToolEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { ToolCallAction, ToolCallSection } from '@renderer/components/affect/tool-call-card'
import { useTerminalAllowed } from '@renderer/stores/hosts'
import { useSessionsStore } from '@renderer/stores/sessions'
import { ansiRuns, exitOf, shellTail } from './shell'
import { useToolCallLabels } from './tool-call-model'

const TONE = {
  red: 'text-code-danger',
  green: 'text-code-success',
  dim: 'text-(--syntax-comment)',
  bold: 'font-bold text-primary',
} as const

// Past this the row cuts a command short, so its section shows it whole.
const LONG_COMMAND = 60

export function Printed({ text }: { text: string }) {
  return ansiRuns(text).map((run, i) =>
    run.tone ? (
      <span key={i} className={TONE[run.tone]}>
        {run.text}
      </span>
    ) : (
      run.text
    ),
  )
}

/**
 * A command and what it printed, as sections of its step's card: the command only when the row
 * cut it short, then the output's last 12 lines with the earlier ones a click away, and the exit
 * code beside it when the command failed. Only red, green and dim survive of the output's colors.
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
  const labels = useToolCallLabels()
  const [all, setAll] = useState(false)
  const agentId = useSessionsStore((s) => s.byId[sessionId]?.agentId ?? null)
  const harness = agentId && isAgentId(agentId) ? harnessOf(agentId) : null
  const exit = exitOf(output, status, harness)
  const printed = exit.output?.replace(/\n$/, '') ?? ''
  const { shown, earlier } = shellTail(printed)
  const terminal = useTerminalAllowed(projectPath)
  const whole = command.includes('\n') || command.length > LONG_COMMAND
  const failed = (exit.code !== null && exit.code !== 0) || status === 'failed'
  return (
    <div data-selectable="" className="ks-shell">
      {whole && (
        <ToolCallSection label={t('toolCall.section.command')} copy={command} labels={labels}>
          <pre className="ks-shell-command">{command}</pre>
        </ToolCallSection>
      )}
      {(printed !== '' || failed) && (
        <ToolCallSection
          label={t('toolCall.section.output')}
          extra={
            failed && (
              <span className="ks-shell-exit">
                ·{' '}
                {exit.code !== null && exit.code !== 0
                  ? t('toolCall.exitCode', { code: exit.code })
                  : t('status.failed')}
              </span>
            )
          }
          actions={
            terminal && (
              <ToolCallAction
                label={t('block.openInTerminal')}
                onClick={() => emitAppEvent({ kind: 'run-in-terminal', panel: sessionId, command })}
              >
                <HugeiconsIcon icon={ComputerTerminal01Icon} strokeWidth={1.9} aria-hidden />
              </ToolCallAction>
            )
          }
          copy={printed === '' ? undefined : printed}
          labels={labels}
        >
          {printed === '' ? (
            <p className="ks-shell-none">{t('toolCall.noOutput')}</p>
          ) : (
            <div className="ks-shell-output">
              {earlier > 0 && !all && (
                <button type="button" className="ks-shell-earlier" onClick={() => setAll(true)}>
                  <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={1.9} aria-hidden />
                  {t('toolCall.earlierLines', { count: earlier })}
                </button>
              )}
              {all && earlier > 0 && (
                <div className="ks-fold-in">
                  <div>
                    <pre>
                      <Printed text={printed.split('\n').slice(0, earlier).join('\n')} />
                    </pre>
                  </div>
                </div>
              )}
              <pre>
                <Printed text={shown} />
              </pre>
            </div>
          )}
        </ToolCallSection>
      )}
    </div>
  )
}
