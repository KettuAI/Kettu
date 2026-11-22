import { useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { canEditAt, lastSwitchAt, turnsFrom, usedAtEnd } from '@shared/rewind'
import type { ThreadState, ToolEntry } from '@shared/thread'
import { editFromMessage } from '@renderer/app/actions'
import { toast } from '@renderer/components/ui/toast'
import { Popover, PopoverContent } from '@renderer/components/ui/popover'
import { errorMessage } from '@renderer/lib/host'
import { i18n } from '@renderer/lib/i18n'
import { agentsOn, useAgentsStore } from '@renderer/stores/agents'
import { hostOfSession, sessionArchived, useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'
import { EditConfirm, type EditFacts } from './edit-confirm'

// Where each entry is and where the latest agent switch is, once per order of a thread.
const places = new WeakMap<readonly string[], { at: Map<string, number>; switchAt: number }>()

function placeOf(state: ThreadState): { at: Map<string, number>; switchAt: number } {
  let place = places.get(state.order)
  if (!place) {
    place = { at: new Map(state.order.map((id, i) => [id, i])), switchAt: lastSwitchAt(state) }
    places.set(state.order, place)
  }
  return place
}

/**
 * Whether a sent message can be edited from: the user's own that started a turn after the latest
 * agent switch, of a session whose agent can cut its conversation there.
 */
export function useEditable(sessionId: string, entryId: string): boolean {
  const view = useThreadsStore(
    useShallow((s) => {
      const session = s.replicas[sessionId]?.state?.session
      return session
        ? {
            agentId: session.agentId,
            projectPath: session.projectPath,
            ok: session.origin !== 'subagent' && !session.noRewind && session.status !== 'starting',
          }
        : null
    }),
  )
  const capable = useAgentsStore((s) =>
    view
      ? agentsOn(s, hostOfSession(view)).byId[view.agentId]?.capabilities.rewind === true
      : false,
  )
  const archived = useSessionsStore((s) => sessionArchived(s.byId, sessionId))
  const editable = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    if (!state) return false
    const place = placeOf(state)
    const at = place.at.get(entryId)
    return at !== undefined && canEditAt(state, at, place.switchAt)
  })
  return !!view?.ok && capable && !archived && editable
}

const FILE_KINDS = new Set<ToolEntry['toolKind']>(['edit', 'delete', 'move'])

function editFacts(state: ThreadState, entryId: string): EditFacts | null {
  const at = state.order.indexOf(entryId)
  if (at < 0) return null
  const files = new Set<string>()
  let commands = false
  for (const id of state.order.slice(at)) {
    const entry = state.byId[id]
    if (entry?.kind !== 'tool') continue
    if (entry.toolKind === 'execute') commands = true
    if (!FILE_KINDS.has(entry.toolKind) || entry.status !== 'completed') continue
    for (const location of entry.locations) files.add(location.path)
    for (const content of entry.content) if (content.type === 'diff') files.add(content.path)
  }
  const { status, background } = state.session
  return {
    turns: turnsFrom(state, at),
    files: files.size,
    commands,
    running: status === 'running' || status === 'awaiting_permission',
    tasks: background?.filter((task) => task.status === 'running').length ?? 0,
    kept: usedAtEnd({ order: state.order.slice(0, at), byId: state.byId }),
  }
}

/** Only the last message, whose turn changed no files and ran nothing, goes back unasked. */
const asks = (facts: EditFacts): boolean =>
  facts.turns > 1 || facts.files > 0 || facts.commands || facts.running || facts.tasks > 0

async function edit(sessionId: string, entryId: string): Promise<void> {
  try {
    await editFromMessage(sessionId, entryId)
  } catch (error) {
    toast(i18n.t('session:editFrom.failed', { error: errorMessage(error) }), undefined, {
      tone: 'warning',
    })
  }
}

/**
 * Edit from a message: `start` goes back at once when nothing needs saying, and otherwise opens
 * the confirmation under `anchor`; `popover` is where it shows.
 */
export function useEditFrom(
  sessionId: string,
  entryId: string,
): { start: (anchor: Element | null) => void; open: boolean; popover: ReactNode } {
  const [asking, setAsking] = useState<{ anchor: Element; facts: EditFacts } | null>(null)
  const start = (anchor: Element | null) => {
    const state = useThreadsStore.getState().replicas[sessionId]?.state
    const facts = state ? editFacts(state, entryId) : null
    if (!facts) return
    if (!asks(facts) || !anchor) {
      void edit(sessionId, entryId)
      return
    }
    setAsking({ anchor, facts })
  }
  const popover = (
    <Popover open={asking !== null} onOpenChange={(open) => !open && setAsking(null)}>
      {asking && (
        <PopoverContent
          anchor={asking.anchor}
          side="bottom"
          align="end"
          sideOffset={6}
          className="kettu-pop kettu-edit-pop"
        >
          <EditConfirm
            sessionId={sessionId}
            facts={asking.facts}
            onCancel={() => setAsking(null)}
            onEdit={() => {
              setAsking(null)
              void edit(sessionId, entryId)
            }}
          />
        </PopoverContent>
      )}
    </Popover>
  )
  return { start, open: asking !== null, popover }
}
