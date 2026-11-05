import { useRef, type Ref } from 'react'
import {
  CheckIcon,
  FolderIcon,
  HandIcon,
  PencilIcon,
  Undo2Icon,
  XIcon,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { previewsCommand, type PermissionKind, type ToolEntry } from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { basename } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import {
  AnswerList,
  CardError,
  OptionName,
  WaitingCard,
  WaitingHeader,
  WaitingStatus,
} from './answer-list'
import { primaryOption, respondToPermission, toolLabel } from './helpers'
import { ContentBlock, KIND_ICON, Target, ToolMedia } from './tool-parts'
import { useAnswering } from './use-answering'
import { useDiffStats } from './use-diff-stats'

const ASK_KEY = {
  read: 'read',
  edit: 'edit',
  delete: 'delete',
  move: 'move',
  search: 'search',
  execute: 'execute',
  think: 'other',
  fetch: 'fetch',
  switch_mode: 'switchMode',
  other: 'other',
} as const satisfies Record<ToolEntry['toolKind'], string>

const ANSWER_KEY = {
  allow_once: 'allowOnce',
  allow_always: 'allowAlways',
  reject_once: 'rejectOnce',
  reject_always: 'rejectAlways',
} as const satisfies Record<PermissionKind, string>

/** What the agent says a command does, short enough to sit in the header after the verb. */
function headerNote(text: string | undefined): string | null {
  return text && text.length <= 60 && !text.includes('\n') ? text : null
}

/**
 * A request waiting for the user, in the tool call's own card: its row as the header, what it
 * would run or change, then its options as tiles in the agent's order. A choice answers at once.
 */
export function PermissionCard({
  ref,
  sessionId,
  entry,
  projectPath,
  agentName,
  media,
  className,
}: {
  ref: Ref<HTMLDivElement>
  sessionId: string
  entry: ToolEntry
  projectPath: string
  agentName: string
  media: string[]
  className?: string
}) {
  const { t } = useTranslation(['session', 'routines'])
  const routine = useSessionsStore((s) => s.byId[sessionId]?.routine ?? null)
  const level = useRoutinesStore((s) =>
    routine ? (s.byId[routine.routineId]?.scope.level ?? null) : null,
  )
  const { answering, error, away, send } = useAnswering(sessionId)
  const stats = useDiffStats(entry.content)
  const list = useRef<HTMLDivElement>(null)
  const permission = entry.permission!
  const question = entry.question
  const label = toolLabel(entry, projectPath)
  const command = label.kind === 'command' ? label.target : null
  const note = headerNote(entry.description)
  const Icon =
    question !== undefined
      ? HandIcon
      : entry.toolKind === 'edit'
        ? PencilIcon
        : KIND_ICON[entry.toolKind]

  const respond = async (index: number) => {
    const option = permission.options[index]
    if (!option) return
    // An answer from the card's own tiles would leave the focus on nothing once the card goes;
    // a denial or Something else goes on in the composer, where the user says what instead.
    const focused = !!list.current?.contains(document.activeElement)
    const sent = await send(option.id, () =>
      respondToPermission(sessionId, permission.requestId, option.id),
    )
    if (sent && (focused || option.kind === 'reject_once' || option.kind === 'reject_always')) {
      emitAppEvent({ kind: 'focus-composer' })
    }
  }

  return (
    <WaitingCard
      ref={ref}
      entryId={entry.id}
      label={question !== undefined ? t('question.label') : t('permission.label')}
      description={
        question !== undefined
          ? t('question.ask', { agent: agentName })
          : t(`permission.ask.${ASK_KEY[entry.toolKind]}`, { agent: agentName })
      }
      className={className}
    >
      <WaitingHeader>
        <Icon aria-hidden className="size-4 shrink-0" />
        {question !== undefined ? (
          <span className="min-w-0 flex-1 truncate text-ui font-semibold text-foreground">
            {t('question.label')}
          </span>
        ) : command ? (
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="shrink-0 text-ui font-semibold text-foreground">
              {t('permission.runCommand')}
            </span>
            {note && <span className="min-w-0 truncate text-control text-tertiary">· {note}</span>}
          </span>
        ) : label.verb ? (
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="shrink-0 text-ui font-semibold text-foreground">{label.verb}</span>
            {label.target && <Target label={label} />}
            {stats && (stats.insertions > 0 || stats.deletions > 0) && (
              <span className="flex shrink-0 gap-1.5 font-mono text-xs tabular">
                <span className="text-success">+{stats.insertions}</span>
                <span className="text-danger">−{stats.deletions}</span>
              </span>
            )}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-ui font-semibold text-foreground">
            {label.target}
          </span>
        )}
        <WaitingStatus>
          {question !== undefined ? t('question.asksYou') : t('status.needsApproval')}
        </WaitingStatus>
      </WaitingHeader>
      {question !== undefined && (
        <p data-selectable="" className="px-5 pt-2 text-row leading-normal text-foreground">
          {question}
        </p>
      )}
      {question === undefined && entry.description && !note && (
        <p data-selectable="" className="px-5 pt-2 text-row text-secondary">
          {entry.description}
        </p>
      )}
      {command && (
        <div
          data-selectable=""
          className="mx-5 mt-3 rounded-xl bg-code-block px-3.5 py-2.5 font-mono text-command leading-relaxed text-foreground shadow-sunk"
        >
          <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">
            <span aria-hidden className="mr-2 text-tertiary select-none">
              $
            </span>
            {previewsCommand(command) ? command : command.split('\n')[0]}
          </pre>
          <p className="mt-1.5 flex min-w-0 items-center gap-1.5 font-sans text-hint text-tertiary">
            <FolderIcon aria-hidden className="size-3.25 shrink-0" />
            <span className="truncate">{basename(projectPath)}</span>
          </p>
        </div>
      )}
      {entry.content.map((content, i) => (
        <div key={i} className="mx-5 mt-3 min-w-0">
          <ContentBlock
            sessionId={sessionId}
            entryId={entry.id}
            index={i}
            content={content}
            projectPath={projectPath}
          />
        </div>
      ))}
      {media.length > 0 && (
        <div className="mx-5 mt-3">
          <ToolMedia sessionId={sessionId} entryId={entry.id} media={media} />
        </div>
      )}
      {level && (
        <p className="px-5 pt-3 text-xs text-tertiary">
          {t('permission.outsideScope', {
            level: t(`routines:permission.level.${level}.name`),
          })}
        </p>
      )}
      <AnswerList
        ref={list}
        label={t('permission.answerGroup')}
        answers={permission.options.map((option) => ({
          key: option.id,
          label: <OptionName name={option.name} />,
          ...(option.description ? { description: option.description } : {}),
        }))}
        primary={primaryOption(permission.options)}
        answering={answering}
        disabled={away}
        onAnswer={(index) => void respond(index)}
      />
      <CardError error={error} />
    </WaitingCard>
  )
}

/** The gray tag a tool row carries once its request is answered: what was chosen, and where. */
export function PermissionAnswer({
  result,
  question,
}: {
  result: NonNullable<ToolEntry['permissionResult']>
  question: boolean
}) {
  const { t } = useTranslation('session')
  const asked = typeof result === 'object' ? result.questions : undefined
  const given = asked?.filter((q) => q.answered) ?? []
  const answer =
    result === 'cancelled'
      ? t('permission.answer.cancelled')
      : result === 'withdrawn'
        ? t('permission.answer.withdrawn')
        : asked
          ? given.length === 0
            ? t('question.skipped')
            : asked.length > 1
              ? t('question.answered', { answered: given.length, total: asked.length })
              : (given[0]!.answer ?? t('question.answeredOne'))
          : result.name
            ? result.name
            : question && result.kind === 'reject_once'
              ? t('question.answeredOther')
              : result.by === 'routine'
                ? t('permission.answer.allowedByRoutine')
                : t(`permission.answer.${ANSWER_KEY[result.kind]}`)
  const device = typeof result === 'object' ? result.device : undefined
  const Icon: LucideIcon =
    result === 'withdrawn'
      ? Undo2Icon
      : result === 'cancelled' || result.kind === 'reject_once' || result.kind === 'reject_always'
        ? XIcon
        : CheckIcon
  return (
    <span
      className={cn(
        'inline-flex h-5.5 min-w-0 shrink animate-in items-center gap-1.25 rounded-lg bg-muted px-2 text-small leading-none font-medium text-secondary animation-duration-(--duration-base) fade-in',
      )}
    >
      {!asked && <Icon aria-hidden strokeWidth={2} className="size-3 shrink-0" />}
      <span className="min-w-0 truncate">{answer}</span>
      {device && <span className="shrink-0 font-normal text-tertiary">· {device.name}</span>}
    </span>
  )
}
