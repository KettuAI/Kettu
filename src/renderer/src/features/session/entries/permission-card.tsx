import { useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { File01Icon, FileEditIcon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import {
  previewsCommand,
  type PermissionKind,
  type PermissionOption,
  type ToolContent,
  type ToolEntry,
} from '@shared/thread'
import { emitAppEvent } from '@renderer/app/events'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  PermissionRequest,
  type PermissionDecision,
  type PermissionLabels,
  type PermissionPreviewItem,
  type PermissionScope,
} from '@renderer/components/affect/permission-request'
import { SegmentedControl } from '@renderer/components/affect/segmented-control'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { basename, relativePath } from '@renderer/lib/format'
import { cn } from '@renderer/lib/utils'
import { useRoutinesStore } from '@renderer/stores/routines'
import { useSessionsStore } from '@renderer/stores/sessions'
import { codeSpans, respondToPermission, toolLabel } from './helpers'
import { StepCard } from './tool-call'
import { KIND_GLYPH, stepFacts, useToolCallLabels } from './tool-call-model'
import { ContentBlock, ToolMedia } from './tool-parts'
import { useAnswering } from './use-answering'
import { cachedStats, useDiffStats } from './use-diff-stats'

const ACTION_KEY = {
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

/**
 * The agent's options on the card: its allows as the how-long choice, in its order, its first
 * denial as Deny, and any other option as a button of its own before Deny.
 */
interface Answers {
  scopes: PermissionScope[]
  allows: Partial<Record<PermissionScope, PermissionOption>>
  deny: PermissionOption | null
  others: PermissionOption[]
}

function answersOf(options: readonly PermissionOption[]): Answers {
  const allows: Partial<Record<PermissionScope, PermissionOption>> = {}
  const scopes: PermissionScope[] = []
  const deny =
    options.find((o) => o.kind === 'reject_once') ??
    options.find((o) => o.kind === 'reject_always') ??
    null
  const others: PermissionOption[] = []
  for (const option of options) {
    if (option === deny) continue
    const order: PermissionScope[] | null =
      option.kind === 'allow_once'
        ? ['once', 'timed', 'always']
        : option.kind === 'allow_always'
          ? ['always', 'timed', 'once']
          : null
    const scope = order?.find((s) => !allows[s])
    if (!scope) {
      others.push(option)
      continue
    }
    allows[scope] = option
    scopes.push(scope)
  }
  return { scopes, allows, deny, others }
}

/** An option's name as plain words, for a button that sets no code. */
const plainName = (name: string): string =>
  codeSpans(name)
    .map((part) => part.text)
    .join('')

const isAllow = (option: PermissionOption): boolean =>
  option.kind === 'allow_once' || option.kind === 'allow_always'

/** How an answered request reads on the folded card. */
function decisionOf(result: NonNullable<ToolEntry['permissionResult']>): PermissionDecision {
  if (typeof result !== 'object') return { allow: false, scope: 'once', at: 0 }
  return {
    allow: result.kind === 'allow_once' || result.kind === 'allow_always',
    scope: result.kind === 'allow_always' ? 'always' : 'once',
    at: 0,
  }
}

/** What a request would touch: each file it edits with its counts, or reads. */
function previewOf(
  entry: ToolEntry,
  projectPath: string,
  stats: (diff: ToolContent) => { insertions: number; deletions: number } | null,
): PermissionPreviewItem[] {
  const items: PermissionPreviewItem[] = []
  const seen = new Set<string>()
  entry.content.forEach((content, i) => {
    if (content.type !== 'diff') return
    seen.add(content.path)
    const counts = stats(content)
    items.push({
      id: `diff:${i}`,
      label: relativePath(content.path, projectPath),
      icon: <Icon icon={FileEditIcon} size={14} />,
      meta: counts && (
        <span className="tabular">
          <span className="ks-add">+{counts.insertions}</span>{' '}
          <span className="ks-del">−{counts.deletions}</span>
        </span>
      ),
    })
  })
  if (entry.toolKind !== 'execute') {
    entry.locations.forEach((location, i) => {
      if (seen.has(location.path)) return
      seen.add(location.path)
      items.push({
        id: `path:${i}`,
        label: relativePath(location.path, projectPath),
        icon: <Icon icon={entry.toolKind === 'edit' ? FileEditIcon : File01Icon} size={14} />,
      })
    })
  }
  return items
}

/**
 * A tool call that asks for permission, on affectUI's Permission Request: who asks for what, why,
 * and what it touches, then the agent's own answers. Once answered the card folds to one line of
 * what was chosen, which an allowed call's own card follows.
 */
export function PermissionEntry({
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
  const agentId = useSessionsStore((s) => s.byId[sessionId]?.agentId ?? null)
  const routine = useSessionsStore((s) => s.byId[sessionId]?.routine ?? null)
  const level = useRoutinesStore((s) =>
    routine ? (s.byId[routine.routineId]?.scope.level ?? null) : null,
  )
  const { answering, error, away, send } = useAnswering(sessionId)
  const toolLabels = useToolCallLabels()
  const root = useRef<HTMLDivElement>(null)
  const [scope, setScope] = useState<PermissionScope | undefined>(undefined)
  useDiffStats(entry.content)
  const permission = entry.permission
  const result = entry.permissionResult
  const answers = useMemo(() => answersOf(permission?.options ?? []), [permission])
  const label = toolLabel(entry, projectPath)
  const command = label.kind === 'command' ? label.target : null
  const action = t(`permission.card.action.${ACTION_KEY[entry.toolKind]}`)
  const target = command ? command.split('\n')[0]! : label.target
  const preview = previewOf(entry, projectPath, (diff) => cachedStats([diff]))
  const decision = permission ? null : result ? decisionOf(result) : null
  const busy = away || answering !== null

  const respond = async (option: PermissionOption | null | undefined) => {
    if (!option || !permission || busy) return
    // An answer from the card's own buttons would leave the focus on nothing once the card folds;
    // after a denial the user says what to do instead in the composer.
    const focused = !!root.current?.contains(document.activeElement)
    const sent = await send(option.id, () =>
      respondToPermission(sessionId, permission.requestId, option.id),
    )
    if (sent && (focused || !isAllow(option))) emitAppEvent({ kind: 'focus-composer' })
  }

  const scopeWords = (s: PermissionScope): string => {
    const option = answers.allows[s]
    if (!option) return ''
    const alike = answers.scopes.filter((x) => answers.allows[x]?.kind === option.kind).length
    if (alike === 1 && option.kind === 'allow_once') return t('permission.card.once')
    if (alike === 1 && option.kind === 'allow_always') return t('permission.card.always')
    return plainName(option.name)
  }

  const labels: Partial<PermissionLabels> = {
    title: (name, what) => (
      <Trans
        t={t}
        i18nKey="permission.card.title"
        values={{ agent: name, action: what }}
        components={{ b: <b dir="auto" /> }}
      />
    ),
    risk: (risk) => t(`permission.card.${risk}`),
    scope: (s) => scopeWords(s),
    allow: (s) => plainName(answers.allows[s]?.name ?? ''),
    deny: answers.deny ? t('permission.card.deny') : '',
    howLong: t('permission.card.howLong'),
    more: (count) => t('permission.card.more', { count }),
    showLess: t('permission.card.showLess'),
    result: () => answeredWords(),
  }

  // The folded card's line: what was answered, and what follows from it.
  const answeredWords = (): { headline: string; note: string } => {
    if (result === 'cancelled') {
      return {
        headline: t('permission.answer.cancelled'),
        note: t('permission.card.note.cancelled'),
      }
    }
    if (result === 'withdrawn' || !result) {
      return {
        headline: t('permission.answer.withdrawn'),
        note: t('permission.card.note.withdrawn', { agent: agentName }),
      }
    }
    const key = ANSWER_KEY[result.kind]
    const note = t(`permission.card.note.${key}`, { agent: agentName })
    return {
      headline: t(`permission.answer.${key}`),
      note: result.device
        ? t('permission.answer.onDevice', { answer: note, device: result.device.name })
        : note,
    }
  }

  const allowed = typeof result === 'object' && result !== null && decision?.allow === true
  const facts = allowed ? stepFacts(sessionId, entry) : null
  const more: ReactNode[] = []
  if (permission) {
    if (command && previewsCommand(command)) {
      more.push(
        <div key="command" data-selectable="" className="ks-permission__command">
          <pre>
            <span aria-hidden className="select-none">
              ${' '}
            </span>
            {command}
          </pre>
          <span className="ks-permission__cwd">{basename(projectPath)}</span>
        </div>,
      )
    }
    entry.content.forEach((content, i) =>
      more.push(
        <ContentBlock
          key={`content:${i}`}
          sessionId={sessionId}
          entryId={entry.id}
          index={i}
          content={content}
          projectPath={projectPath}
        />,
      ),
    )
    if (media.length > 0) {
      more.push(<ToolMedia key="media" sessionId={sessionId} entryId={entry.id} media={media} />)
    }
    if (level) {
      more.push(
        <p key="scope" className="ks-permission__note">
          {t('permission.outsideScope', { level: t(`routines:permission.level.${level}.name`) })}
        </p>,
      )
    }
  }

  return (
    <div
      ref={ref}
      data-entry-id={entry.id}
      className={cn('flex min-w-0 flex-col gap-3.5', className)}
    >
      <div ref={root} className="min-w-0">
        <PermissionRequest
          className="ks-permission"
          agent={{
            name: agentName,
            avatar: agentId ? <AgentMark agent={agentId} size={14} /> : undefined,
          }}
          action={action}
          target={target ?? undefined}
          toolIcon={<Icon icon={KIND_GLYPH[entry.toolKind]} size={12} />}
          risk={entry.toolKind === 'execute' || entry.toolKind === 'delete' ? 'risky' : 'safe'}
          reason={entry.description}
          previewTitle={t('permission.card.touches')}
          preview={preview}
          scopes={answers.scopes.length > 0 ? answers.scopes : ['once']}
          scope={scope}
          onScopeChange={setScope}
          renderScopes={({ scopes, scope: shown, onChange }) => (
            <SegmentedControl
              aria-label={t('permission.card.howLong')}
              variant="tray"
              value={shown}
              onChange={onChange}
              disabled={busy}
              options={scopes.map((s) => ({ value: s, label: scopeWords(s) }))}
            />
          )}
          decision={decision}
          onDecisionChange={(next) => {
            if (!next) return
            void respond(next.allow ? answers.allows[next.scope] : answers.deny)
          }}
          revocable={false}
          disabled={busy}
          actions={answers.others.map((option) => (
            <button
              key={option.id}
              type="button"
              className="ui-prc__btn"
              disabled={busy}
              title={option.description}
              onClick={() => void respond(option)}
            >
              {plainName(option.name)}
            </button>
          ))}
          labels={labels}
        >
          {more.length > 0 ? more : undefined}
        </PermissionRequest>
        {error && permission && (
          <p role="alert" className="ks-card-error">
            {error}
          </p>
        )}
      </div>
      {facts && (
        <StepCard
          {...facts}
          icon={<Icon icon={facts.glyph} size={14} />}
          sessionId={sessionId}
          entry={entry}
          projectPath={projectPath}
          labels={toolLabels}
        />
      )}
    </div>
  )
}
