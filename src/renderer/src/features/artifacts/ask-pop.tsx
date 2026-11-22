import { useState } from 'react'
import { Cancel01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Icon } from '@renderer/components/affect/app-shell'
import { Button } from '@renderer/components/affect/button'
import { errorMessage } from '@renderer/lib/host'
import { formatShortcut } from '@renderer/lib/platform'
import type { AskChip, AskMessage } from './ask-subject'
import { ToolPop } from './comment-pop'
import { sendKey } from './pop-place'
import { sendToSession, useTargetName, type SendTargets } from './send-targets'
import { ToMenu } from './send-to'

type Box = { left: number; top: number; right: number; bottom: number }

/**
 * Asking an agent about what is selected, beside it: one sentence, sent at once with the selection
 * drawn as a picture, then where it went, with Open session. A failed send keeps the sentence.
 */
export function AskPop({
  at,
  chips,
  onRemoveChip,
  targets,
  target,
  onTarget,
  project,
  message,
  onOpenSession,
  onClose,
}: {
  /** What it is beside; null for the middle of the content area. */
  at: Box | null
  chips: AskChip[]
  onRemoveChip: ((key: string) => void) | null
  targets: SendTargets
  target: string
  onTarget: (target: string) => void
  project: string
  message: AskMessage
  onOpenSession: (sessionId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation('artifacts')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  const name = useTargetName()
  const MAX = 4
  const shown = chips.length > MAX ? chips.slice(0, MAX - 1) : chips

  const send = () => {
    if (!text.trim() || busy) return
    setBusy(true)
    setError(null)
    const to = target
    message(text)
      .then(({ text: body, images }) => sendToSession(project, to, body, images))
      .then(
        (how) => {
          setBusy(false)
          if (how === 'drafted') onClose()
          else setSent(to)
        },
        (reason: unknown) => {
          setBusy(false)
          setError(errorMessage(reason))
        },
      )
  }

  return (
    <ToolPop at={at} width={340} label={t('ask.label')} onClose={onClose} className="k-vt-ask">
      {() =>
        sent ? (
          <span role="status" className="k-vt-ask__done">
            <span className="k-vt-ask__ok">
              <Icon icon={Tick02Icon} size={15} />
              {t('ask.sentTo', { session: name(targets, sent) })}
            </span>
            <Button variant="ghost" size="sm" onClick={() => onOpenSession(sent)}>
              {t('ask.openSession')}
            </Button>
          </span>
        ) : (
          <>
            <span className="k-vt-chips">
              {shown.map((chip) => (
                <span key={chip.key} className="k-vt-chip" title={chip.label}>
                  <span className="k-vt-chip__name">{chip.label}</span>
                  {onRemoveChip && chips.length > 1 && (
                    <button
                      type="button"
                      aria-label={t('ask.remove', { name: chip.label })}
                      onClick={() => onRemoveChip(chip.key)}
                      className="k-vt-chip__x"
                    >
                      <Icon icon={Cancel01Icon} size={12} />
                    </button>
                  )}
                </span>
              ))}
              {shown.length < chips.length && (
                <span
                  className="k-vt-chip k-vt-chip--more"
                  title={chips
                    .slice(shown.length)
                    .map((chip) => chip.label)
                    .join(', ')}
                >
                  +{chips.length - shown.length}
                </span>
              )}
            </span>
            <textarea
              autoFocus
              value={text}
              rows={2}
              maxLength={4_000}
              placeholder={t('ask.placeholder')}
              aria-label={t('ask.placeholder')}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (!sendKey(event)) return
                event.preventDefault()
                send()
              }}
              className="k-av-text k-vt-field"
            />
            {error && (
              <p role="alert" className="k-av-error">
                {t('ask.failed', { error })}
              </p>
            )}
            <span className="k-vt-ask__foot">
              <ToMenu targets={targets} target={target} onPick={onTarget} compact />
              <Button size="sm" disabled={!text.trim()} loading={busy} onClick={send}>
                {error ? t('viewer.retry') : t('comments.send')}
                <kbd className="k-vt-kbd">{formatShortcut('Mod+Enter')}</kbd>
              </Button>
            </span>
          </>
        )
      }
    </ToolPop>
  )
}
