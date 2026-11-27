import { useEffect, useRef, useState } from 'react'
import { Copy01Icon, StopIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { BackgroundTaskView } from '@shared/thread'
import { Button } from '@renderer/components/ui/button'
import { Printed } from '@renderer/features/session/entries/shell-block'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import type { TaskOutput } from './use-task-output'

/**
 * A task opened in place: the end of what it printed, straight on the surface under it, then
 * Stop while it runs and Copy. `command` shows what it runs first, for a row that does not. With
 * no `output`, for a task whose output Kettu cannot read, it shows only the command.
 */
export function TaskDetail({
  task,
  output,
  command = false,
  onStop,
  stopping = false,
}: {
  task: BackgroundTaskView
  output: TaskOutput | null
  command?: boolean
  onStop?: () => void
  stopping?: boolean
}) {
  const { t } = useTranslation('board')
  const live = task.status === 'running'
  const pre = useRef<HTMLPreElement>(null)
  // The tail stays in view while the user has not scrolled up from it.
  const atEnd = useRef(true)
  const [copied, setCopied] = useState(false)
  const text = output?.text ?? null
  useEffect(() => {
    const element = pre.current
    if (element && atEnd.current) element.scrollTop = element.scrollHeight
  }, [text])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const notes = [output?.truncated && t('detail.truncated'), live && t('detail.refreshed')].filter(
    Boolean,
  )
  const commandLabel =
    task.schedule?.mode === 'timer'
      ? 'detail.timer'
      : task.schedule?.mode === 'cron'
        ? 'detail.schedule'
        : task.kind === 'monitor'
          ? 'detail.watching'
          : 'detail.command'
  return (
    <div className="kb-detail" data-selectable="">
      {command && (
        <>
          <span className="kb-detail__label">{t(commandLabel)}</span>
          <pre className="kb-detail__command">{task.command ?? task.title}</pre>
        </>
      )}
      {output && (
        <>
          <span className="kb-detail__label">{t('detail.output')}</span>
          {text ? (
            <pre
              ref={pre}
              className="kb-detail__output"
              onScroll={(event) => {
                const { scrollTop, clientHeight, scrollHeight } = event.currentTarget
                atEnd.current = scrollHeight - scrollTop - clientHeight < 8
              }}
            >
              <Printed text={text.replace(/\n$/, '')} />
            </pre>
          ) : (
            text === '' && <p className="kb-detail__none">{t('detail.noOutput')}</p>
          )}
          {output.error && (
            <p role="alert" className="kb-detail__error">
              {t('detail.readFailed', { error: output.error })}
            </p>
          )}
          {notes.length > 0 && <p className="kb-detail__note">{notes.join(' ')}</p>}
          <div className="kb-detail__acts">
            {live && onStop && (
              <Button variant="destructive-tint" size="xs" disabled={stopping} onClick={onStop}>
                <PaneIcon icon={StopIcon} size={12} />
                {t('actions.stop')}
              </Button>
            )}
            <Button
              variant="outline"
              size="xs"
              disabled={!text}
              onClick={() => {
                void navigator.clipboard.writeText(text ?? '').then(() => setCopied(true))
              }}
            >
              <PaneIcon icon={copied ? Tick02Icon : Copy01Icon} size={12} />
              {t(copied ? 'actions.copied' : 'actions.copy')}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
