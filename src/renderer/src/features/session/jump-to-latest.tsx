import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { StopReason, ThreadState } from '@shared/thread'
import {
  MessageScrollerButton,
  useMessageScrollerScrollable,
} from '@renderer/components/ui/message-scroller'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph } from '@renderer/features/shell/glyph'
import { useThreadsStore } from '@renderer/stores/threads'
import { stopReasonText } from './entries/helpers'
import { CELLS, turnDotStyles } from './turn-dot-patterns'
import { turnPhase } from './turn-phase'

type Mark = 'idle' | 'running' | 'waiting' | 'ended' | 'failed'

// Kettu's own records, which may follow the entry that ended a turn.
const AFTER_END = new Set([
  'git',
  'artifact',
  'browser_origin',
  'device_access',
  'computer_app',
  'computer_setup',
  'project_mcp',
  'problem_report',
  'session_started',
])

interface Ending {
  kind: 'ended' | 'failed' | null
  stopReason: StopReason | null
  durationMs: number
}

const NO_ENDING: Ending = { kind: null, stopReason: null, durationMs: 0 }

/**
 * How the latest turn ended, from the thread's last entries: with new content to read, with an
 * error, or neither, as when the user cancelled it.
 */
function turnEnding(state: ThreadState | null | undefined): Ending {
  if (!state) return NO_ENDING
  if (state.session.status === 'failed') return { ...NO_ENDING, kind: 'failed' }
  const { order, byId } = state
  for (let i = order.length - 1; i >= 0; i--) {
    const entry = byId[order[i]!]
    if (!entry) continue
    if (entry.kind === 'turn_end') {
      if (entry.stopReason === 'cancelled') return NO_ENDING
      return { kind: 'ended', stopReason: entry.stopReason, durationMs: entry.durationMs }
    }
    if (entry.kind === 'notice' && (entry.cause || entry.severity === 'error')) {
      return { ...NO_ENDING, kind: 'failed' }
    }
    if (!AFTER_END.has(entry.kind)) return NO_ENDING
  }
  return NO_ENDING
}

/**
 * Jumps to the thread's end. At rest it is an ink chevron; the turn's nine dots in the fox orange
 * appear only while there is a state to carry, the status line being out of view: the phase's
 * motion while the turn runs, the centre beating while it waits for the user, a red mark when it
 * failed. A turn that ended out of view turns the chevron fox orange until the end comes into
 * view. Pointing at it always shows the chevron.
 */
export const JumpToLatest = memo(function JumpToLatest({
  sessionId,
  working,
}: {
  sessionId: string
  working: boolean
}) {
  const { t } = useTranslation('session')
  const { end: below } = useMessageScrollerScrollable()
  const { phase, count } = useThreadsStore(
    useShallow((s) => turnPhase(s.replicas[sessionId]?.state)),
  )
  const ending = useThreadsStore(useShallow((s) => turnEnding(s.replicas[sessionId]?.state)))

  const [wasWorking, setWasWorking] = useState(working)
  const [unseen, setUnseen] = useState(false)
  if (working !== wasWorking) {
    setWasWorking(working)
    setUnseen(!working && below)
  }
  if (unseen && !below) setUnseen(false)

  let mark: Mark = 'idle'
  if (working) mark = phase === 'approval' ? 'waiting' : 'running'
  else if (unseen && ending.kind) mark = ending.kind

  let state: string | null = null
  if (working) state = t(`thread.phase.${phase}`, { count })
  else if (mark === 'ended' && ending.stopReason)
    state = stopReasonText(ending.stopReason, ending.durationMs)
  else if (mark === 'failed') state = t('thread.jump.failed')

  const styles = mark === 'running' && phase !== 'approval' ? turnDotStyles(phase) : null

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <MessageScrollerButton
            variant="ghost"
            data-jump=""
            data-mark={mark}
            aria-label={state ? t('thread.jump.labelWith', { state }) : t('thread.jump.label')}
            className="ks-jump size-[34px] rounded-full data-[direction=end]:bottom-3"
          />
        }
      >
        <Glyph icon={ArrowDown01Icon} size={18} className="ks-jump__arrow size-[18px]" />
        <svg data-jump-dots viewBox="0 0 16 16" aria-hidden className="ks-jump__dots size-4">
          {CELLS.map(([x, y], i) => (
            <circle
              key={`${x}${y}`}
              data-cell={i}
              data-still={styles && !styles[i] ? '' : undefined}
              cx={3 + x * 5}
              cy={3 + y * 5}
              r={1.6}
              style={styles?.[i]}
            />
          ))}
        </svg>
      </TooltipTrigger>
      <TooltipContent>
        {state ? t('thread.jump.tooltipWith', { state }) : t('thread.jump.label')}
      </TooltipContent>
    </Tooltip>
  )
})
