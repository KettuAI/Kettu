import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import { unarchiveSession } from '@renderer/app/actions'
import { AgentTile } from '@renderer/components/agents/agent-mark'
import { toast } from '@renderer/components/ui/toast'
import { useNearView } from '@renderer/features/session/media/near-view'
import { DeleteSessionDialog } from '@renderer/features/sidebar/session-menu'
import { errorMessage } from '@renderer/lib/host'
import { mediumAgo } from '@renderer/lib/format'
import { useNow } from '@renderer/lib/use-now'
import { sessionTitle } from '@renderer/stores/sessions'
import { ItemLine, Thing } from './rows'
import { ControlError, DangerButton, SetButton } from './controls'

/** Rows drawn in full per idle moment: about a frame's work. */
const IDLE_BATCH = 30
/** The longest a batch waits for an idle moment, so the list ends up whole on a busy window. */
const IDLE_WAIT_MS = 50

const toDraw = new Set<() => void>()
let drawing = false

function whenIdle(run: () => void): void {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: IDLE_WAIT_MS })
  else setTimeout(run, IDLE_WAIT_MS)
}

/** Draws the row in full in a later batch; the returned function takes it off the list. */
function drawWhenIdle(draw: () => void): () => void {
  toDraw.add(draw)
  if (!drawing) {
    drawing = true
    whenIdle(drawBatch)
  }
  return () => toDraw.delete(draw)
}

function drawBatch(): void {
  let drawn = 0
  for (const draw of toDraw) {
    if (drawn++ === IDLE_BATCH) break
    toDraw.delete(draw)
    draw()
  }
  drawing = toDraw.size > 0
  if (drawing) whenIdle(drawBatch)
}

/**
 * An archived session's row. Unless `eager`, as the rows the page opens on are, it draws only its
 * mark and text, at the same height, until it comes near the view or the window is idle, so a long
 * list opens without building every row's buttons and dialog first, and ends up whole.
 */
export function ArchivedRow({
  summary,
  where,
  eager,
}: {
  summary: SessionSummary
  where: string
  eager: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const near = useNearView(ref, !eager, '.kettu-settings__page')
  const [idle, setIdle] = useState(false)
  const [opened] = useState(Date.now)
  useEffect(() => (eager ? undefined : drawWhenIdle(() => setIdle(true))), [eager])
  if (eager || near || idle) return <FullRow summary={summary} where={where} />
  return (
    <div ref={ref} className="ui-sg-row">
      <RowThing summary={summary} where={where} now={opened} />
    </div>
  )
}

function RowThing({
  summary,
  where,
  now,
}: {
  summary: SessionSummary
  where: string
  now: number
}) {
  const { t } = useTranslation('settings')
  return (
    <Thing
      mark={<AgentTile agent={summary.agentId} size={32} />}
      name={<span className="k-name">{sessionTitle(summary)}</span>}
    >
      <ItemLine>
        {t('archived.description', {
          project: where,
          when: summary.archivedAt ? mediumAgo(summary.archivedAt, now) : '',
        })}
      </ItemLine>
    </Thing>
  )
}

function FullRow({ summary, where }: { summary: SessionSummary; where: string }) {
  const { t } = useTranslation('settings')
  const now = useNow()
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const title = sessionTitle(summary)
  const restore = async () => {
    setError(null)
    try {
      await unarchiveSession(summary.id)
      toast(t('archived.restored', { project: where }))
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <div className="ui-sg-row">
      <RowThing summary={summary} where={where} now={now} />
      <ControlError error={error} />
      <span className="ui-sg-control">
        <SetButton onClick={() => void restore()}>{t('archived.restore')}</SetButton>
        <DangerButton onClick={() => setDeleting(true)}>{t('archived.delete')}</DangerButton>
      </span>
      <DeleteSessionDialog
        sessionId={summary.id}
        title={title}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => toast(t('archived.deleted'))}
      />
    </div>
  )
}
