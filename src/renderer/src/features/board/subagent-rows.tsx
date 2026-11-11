import { useState } from 'react'
import { StopIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import {
  useLoadSubagent,
  useProgressOf,
  useSubagentDigest,
} from '@renderer/features/session/subagent/progress'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { shortDuration } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { sessionTitle } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { askedStep, currentStep, subagentFailed, subagentWaiting } from './board-model'
import { Ago, Row, StatusGlyph, type RowState } from './row-parts'

function useStop(sessionId: string) {
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const stop = () => {
    setStopping(true)
    setError(null)
    host('sessions.cancel', { sessionId })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setStopping(false))
  }
  return { stop, stopping, error }
}

/** A sub-agent the session started. A click opens its page; a running one can be stopped here. */
export function SubagentRow({ child }: { child: SessionSummary }) {
  const { t } = useTranslation('board')
  const { t: ts } = useTranslation('session')
  useLoadSubagent(child, true)
  const digest = useSubagentDigest(child.id)
  const progress = useProgressOf(child, digest)
  const { stop, stopping, error } = useStop(child.id)
  const waiting = subagentWaiting(child)
  const failed = subagentFailed(child)
  const cancelled = !progress.running && !failed && digest?.stopReason === 'cancelled'
  const state: RowState = waiting
    ? 'needs'
    : progress.running
      ? 'running'
      : failed
        ? 'failed'
        : cancelled
          ? 'stopped'
          : 'done'
  const title = sessionTitle(child)
  const tools = progress.tools === null ? null : ts('subagent.tools', { count: progress.tools })
  const detail = waiting
    ? (askedStep(digest, child.projectPath) ?? t('strip.waiting'))
    : progress.running
      ? [currentStep(digest, child.projectPath), tools].filter(Boolean).join(' · ')
      : [
          failed ? t('status.failed') : cancelled ? ts('status.cancelled') : null,
          tools,
          progress.elapsedMs === null ? null : shortDuration(progress.elapsedMs),
        ]
          .filter(Boolean)
          .join(' · ')
  const canStop = progress.running && !waiting && !!digest?.canCancel

  return (
    <div className="kb-item">
      <Row
        label={t('actions.openTitle', { title })}
        onClick={() => openSession(child.id, child.projectPath)}
        glyph={<StatusGlyph state={state} />}
        head={
          <>
            <span className="kb-title">{title}</span>
            {waiting ? (
              <span className="kb-pill kb-pill--need">{t('status.needs')}</span>
            ) : (
              child.description && <span className="kb-tag">{child.description}</span>
            )}
          </>
        }
        detail={detail}
        when={
          progress.running ? (
            progress.elapsedMs === null ? null : (
              <span>{shortDuration(progress.elapsedMs)}</span>
            )
          ) : (
            <Ago at={child.updatedAt} />
          )
        }
        actions={
          canStop && (
            <button
              type="button"
              className="kb-mini kb-mini--stop"
              aria-label={t('actions.stopTitle', { title })}
              disabled={stopping}
              onClick={stop}
            >
              <PaneIcon icon={StopIcon} size={13} />
              {t('actions.stop')}
            </button>
          )
        }
        hint={
          <span className={waiting ? 'kb-mini kb-mini--solid' : 'kb-mini'}>
            {t('actions.open')}
          </span>
        }
      />
      {error && (
        <p role="alert" className="kb-row-error">
          {error}
        </p>
      )}
    </div>
  )
}

/** Above the groups: a sub-agent that waits for the user, with the call it asks to make. */
export function NeedsStrip({ child }: { child: SessionSummary }) {
  const { t } = useTranslation('board')
  const digest = useSubagentDigest(child.id)
  const title = sessionTitle(child)
  return (
    <div role="group" aria-label={t('strip.label')} className="kb-need">
      <StatusGlyph state="needs" />
      <span className="kb-need__text">
        <b>{title}</b>
        <span>{askedStep(digest, child.projectPath) ?? t('strip.waiting')}</span>
      </span>
      <button
        type="button"
        className="kp-btn kp-btn--sm kp-btn--solid"
        aria-label={t('actions.openTitle', { title })}
        onClick={() => openSession(child.id, child.projectPath)}
      >
        {t('actions.open')}
      </button>
    </div>
  )
}
