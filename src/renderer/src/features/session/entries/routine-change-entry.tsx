import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowRight01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  Delete02Icon,
  PlayIcon,
  TimeScheduleIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { WORKING_RUNS } from '@shared/routines'
import type { RoutineAction, RoutineCardFields, RoutineChangeEntry as Entry } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { PermissionRequest } from '@renderer/components/affect/permission-request'
import { Button } from '@renderer/components/ui/button'
import { emitAppEvent } from '@renderer/app/events'
import { minutesLabel, scheduleWords } from '@renderer/features/routines/model'
import { basename } from '@renderer/lib/format'
import { host } from '@renderer/lib/host'
import { onHost } from '@renderer/lib/host-paths'
import { isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { findProjectForPath, useProjectsStore } from '@renderer/stores/projects'
import { openRoutine } from '@renderer/stores/view'
import { useEntry, useEntryAnimation } from '../use-thread'
import { revealWaiting } from './helpers'
import { useSessionHost } from './session-host'
import { useAnswering } from './use-answering'

/**
 * An agent's creation, change, deletion or run of a Routine: the card while it waits for the user,
 * shaped and answered like a settings change, then one muted line of what came of it.
 */
export const RoutineChangeEntry = memo(function RoutineChangeEntry({
  sessionId,
  entryId,
  agentName: asker,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const entry = useEntry(sessionId, entryId, 'routine_change')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return entry.outcome === null ? (
    <RoutineCard sessionId={sessionId} entry={entry} agentName={asker} className={animation} />
  ) : (
    <RoutineLine sessionId={sessionId} entry={entry} className={animation} />
  )
})

type Field = 'name' | 'schedule' | 'project' | 'agent' | 'scope' | 'timeLimit' | 'enabled'

/** Which rows each card lists, in order; a change lists only what differs, its name always. */
const FIELDS: Record<RoutineAction, readonly Field[]> = {
  create: ['name', 'schedule', 'project', 'agent', 'scope', 'timeLimit'],
  update: ['name', 'enabled', 'schedule', 'project', 'agent', 'scope', 'timeLimit'],
  delete: ['name', 'schedule', 'project', 'agent'],
  run: ['name', 'scope'],
}

/** Words for a Routine's settings, in the window's language, for the session's host. */
function useWords(hostId: string | null) {
  const { t } = useTranslation('session')
  const { t: tr } = useTranslation('routines')
  const projects = useProjectsStore((s) => s.projects)
  return (field: Field, routine: RoutineCardFields): string => {
    switch (field) {
      case 'name':
        return routine.name
      case 'schedule':
        return scheduleWords(routine.schedule)
      case 'project': {
        if (routine.projectPath === null) return tr('routine.noProject')
        const path = onHost(hostId, routine.projectPath)
        return findProjectForPath(projects, path)?.name ?? basename(routine.projectPath)
      }
      case 'agent':
        return [agentName(routine.agentId, hostId), routine.model, routine.effort]
          .filter(Boolean)
          .join(' · ')
      case 'scope':
        return `${tr(`permission.level.${routine.scope.level}.name`)} · ${
          routine.scope.web ? t('routineChange.web') : t('routineChange.noWeb')
        }`
      case 'timeLimit':
        return minutesLabel(routine.timeLimitMinutes)
      case 'enabled':
        return routine.enabled ? t('routineChange.on') : t('routineChange.off')
    }
  }
}

function useLabels(): Record<Field | 'prompt', string> {
  const { t } = useTranslation('session')
  const { t: tr } = useTranslation('routines')
  return {
    name: t('routineChange.name'),
    enabled: t('routineChange.state'),
    schedule: tr('routine.schedule'),
    project: tr('routine.project'),
    agent: tr('routine.agent'),
    scope: tr('routine.permissions'),
    timeLimit: tr('routine.timeLimit'),
    prompt: tr('routine.prompt'),
  }
}

/** A prompt's first lines, with Show all while more is hidden. */
function PromptBlock({ prompt, struck = false }: { prompt: string; struck?: boolean }) {
  const { t } = useTranslation('session')
  const text = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)
  useLayoutEffect(() => {
    const el = text.current
    if (el && !open) setOverflows(el.scrollHeight > el.clientHeight + 1)
  }, [prompt, open])
  const body = (
    <span ref={text} className="ks-routine-rows__prompt-text" data-clamped={!open || undefined}>
      {prompt}
    </span>
  )
  return (
    <div className="ks-routine-rows__prompt">
      {struck ? <del className="ks-routine-rows__old">{body}</del> : body}
      {(overflows || open) && (
        <button
          type="button"
          className="ks-routine-rows__more"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? t('routineChange.showLess') : t('routineChange.showAll')}
        </button>
      )}
    </div>
  )
}

/** The card's rows on a sunk block: each setting's value, or for a change its old and new value. */
function RoutineRows({ entry, hostId }: { entry: Entry; hostId: string | null }) {
  const { t } = useTranslation('session')
  const { t: tr } = useTranslation('routines')
  const words = useWords(hostId)
  const labels = useLabels()
  const { routine, before } = entry
  const rows: { field: Field; from: string | null; to: string }[] = []
  for (const field of FIELDS[entry.action]) {
    const to = words(field, routine)
    const from = before ? words(field, before) : null
    if (before && field !== 'name' && from === to) continue
    rows.push({ field, from: from === to ? null : from, to })
  }
  const promptChanged = before !== null && before.prompt !== routine.prompt
  const showPrompt = entry.action === 'create' || promptChanged
  const note: ReactNode =
    entry.action === 'delete'
      ? entry.sessions
        ? tr('routine.deleteWithSessions', { count: entry.sessions })
        : tr('routine.deleteNoSessions')
      : entry.action === 'run'
        ? t('routineChange.slot', { count: WORKING_RUNS })
        : null
  return (
    <div className="ks-settings-rows ks-routine-rows" data-selectable="">
      <ul aria-label={t('routineChange.rows')}>
        {rows.map((row) => (
          <li key={row.field} className="ks-settings-rows__row">
            <span className="ks-routine-rows__label">{labels[row.field]}</span>
            <span className="ks-settings-rows__value ks-routine-rows__value">
              {row.from !== null && (
                <>
                  <del>{row.from}</del>
                  <span aria-hidden className="ks-settings-rows__arrow">
                    →
                  </span>
                </>
              )}
              <ins>{row.to}</ins>
            </span>
          </li>
        ))}
      </ul>
      {showPrompt && (
        <div className="ks-routine-rows__block">
          <span className="ks-routine-rows__label">{labels.prompt}</span>
          {promptChanged && before && <PromptBlock prompt={before.prompt} struck />}
          <PromptBlock prompt={routine.prompt} />
        </div>
      )}
      {note && <p className="ks-routine-rows__note">{note}</p>}
    </div>
  )
}

const BUTTONS = {
  create: { icon: Tick02Icon, key: 'routineChange.create' },
  update: { icon: Tick02Icon, key: 'routineChange.change' },
  delete: { icon: Delete02Icon, key: 'routineChange.delete' },
  run: { icon: PlayIcon, key: 'routineChange.run' },
} as const satisfies Record<RoutineAction, { icon: unknown; key: string }>

/**
 * The card: the Routines mark and what the agent wants, who asks on which computer, the rows on a
 * sunk block, View in Routines at the left, and Don't and the action at the right.
 */
function RoutineCard({
  sessionId,
  entry,
  agentName: asker,
  className,
}: {
  sessionId: string
  entry: Entry
  agentName: string
  className?: string
}) {
  const { t } = useTranslation('session')
  const { answering, error, away, send } = useAnswering(sessionId)
  const { hostId, name } = useSessionHost(sessionId)
  const card = useRef<HTMLDivElement>(null)
  // Confirmed here or elsewhere: the card holds until the host says what came of it.
  const [doing, setDoing] = useState(false)

  useEffect(() => {
    revealWaiting(card.current)
  }, [])

  const answer = async (decision: 'confirm' | 'decline'): Promise<void> => {
    if (away || answering !== null || doing) return
    const focused = !!card.current?.contains(document.activeElement)
    const sent = await send(decision, () =>
      host('routines.answerChange', { sessionId, entryId: entry.id, decision }),
    )
    if (sent && decision === 'confirm') setDoing(true)
    if (sent && focused) emitAppEvent({ kind: 'focus-composer' })
  }

  const action = entry.action
  const where = name !== null ? 'Other' : isMac ? 'Mac' : 'Computer'
  const who = t(`routineChange.who${where}_${action}`, {
    agent: asker,
    ...(name !== null ? { computer: name } : {}),
  })
  const title = t(`routineChange.title_${action}`)
  const button = BUTTONS[action]
  const routineId = entry.routineId

  return (
    <div ref={card} data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <PermissionRequest
        className={cn(
          'ks-permission ks-settings-card ks-routine-card',
          action === 'delete' && 'ks-routine-card--danger',
        )}
        agent={{ name: asker, avatar: <Icon icon={TimeScheduleIcon} size={16} /> }}
        action={title}
        target={who}
        risk="risky"
        scopes={['once']}
        decision={null}
        onDecisionChange={(next) => {
          if (next) void answer(next.allow ? 'confirm' : 'decline')
        }}
        revocable={false}
        disabled={answering !== null || doing || away}
        actions={
          routineId !== null && (
            <button
              type="button"
              className="ui-prc__btn ks-permission__other ks-settings-card__view"
              onClick={() => openRoutine(routineId)}
            >
              {t('routineChange.view')}
              <Icon icon={ArrowRight01Icon} size={12} />
            </button>
          )
        }
        labels={{
          title: () => <b>{title}</b>,
          risk: () => t('status.needsApproval'),
          allow: () => (
            <>
              <Icon icon={button.icon} size={14} />
              {doing ? t('routineChange.doing') : t(button.key)}
            </>
          ),
          deny: (
            <>
              <Icon icon={Cancel01Icon} size={14} />
              {t('routineChange.decline')}
            </>
          ),
        }}
      >
        <RoutineRows entry={entry} hostId={hostId} />
      </PermissionRequest>
      {error && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
    </div>
  )
}

/** What came of a card, as one muted line: done or not, and Open for a Routine that is there. */
function RoutineLine({
  sessionId,
  entry,
  className,
}: {
  sessionId: string
  entry: Entry
  className?: string
}) {
  const { t } = useTranslation('session')
  const { name } = useSessionHost(sessionId)
  const outcome = entry.outcome!
  const done = outcome.kind === 'done'
  const key = `routineChange.${done ? 'done' : 'notDone'}_${entry.action}` as const
  const notes = [
    name,
    entry.device ? t('settingsChange.answeredOn', { device: entry.device.name }) : null,
    outcome.kind === 'expired' ? t('settingsChange.noAnswer') : null,
    outcome.kind === 'failed' ? outcome.message : null,
  ].filter((note): note is string => !!note)
  const opens = done && entry.action !== 'delete' ? outcome.routineId : null

  return (
    <div data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <div className="ks-settings-line">
        <HugeiconsIcon
          icon={done ? CheckmarkCircle02Icon : CancelCircleIcon}
          strokeWidth={1.9}
          aria-hidden
          className={cn('size-3.5 shrink-0', done && 'ks-settings-line__done')}
        />
        <span className="min-w-0 truncate">
          <Trans
            t={t}
            i18nKey={key}
            values={{ name: entry.routine.name }}
            components={{ b: <b /> }}
          />
        </span>
        {notes.map((note) => (
          <span key={note} className="ks-settings-line__note">
            · {note}
          </span>
        ))}
        {opens !== null && (
          <Button
            variant="quiet"
            size="xs"
            className="ks-settings-line__undo"
            onClick={() => openRoutine(opens)}
          >
            {t('routineChange.open')}
            <Icon icon={ArrowRight01Icon} size={12} />
          </Button>
        )}
      </div>
    </div>
  )
}
