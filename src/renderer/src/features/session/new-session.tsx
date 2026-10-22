import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpIcon, GitBranchIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project, SessionSummary } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { createSession, warmAgent } from '@renderer/app/actions'
import { onAppEvent } from '@renderer/app/events'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@renderer/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { OptionMenu } from '@renderer/features/session/composer/control-row'
import type { SelectOption } from '@renderer/features/session/composer/levels'
import { tightestLimit } from '@renderer/features/sidebar/plan-usage'
import { HeaderTools } from '@renderer/features/shell/header-tools'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { basename, limitLabel, resetTime, shortAgo } from '@renderer/lib/format'
import { isMod } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { pickOption, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentName, isInstalled, useAgentsStore } from '@renderer/stores/agents'
import { useGitStore } from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import { isScratchFolder, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { openSession, useViewStore } from '@renderer/stores/view'
import { flushDraft, NEW_SESSION_DRAFT, readDraft, writeDraft } from './composer/drafts'
import { AgentMenu } from './new-session/agent-menu'
import { ProjectMenu } from './new-session/project-menu'
import { startValues } from './new-session/start-options'
import { useStartConfig } from './new-session/use-start-config'

/**
 * The New session screen: where to work, which agent and model, and the first message, all in one
 * composer under a heading, with the sessions used last below it. The session is created on the
 * first send, which also sends the message.
 */
export function NewSessionView({
  project,
  noProject = false,
}: {
  project: Project | null
  noProject?: boolean
}) {
  const { t } = useTranslation('session')
  const chosenId = useViewStore((s) => (s.main.kind === 'new' ? s.main.agentId : null))
  const installed = useAgentsStore((s) => {
    const status = chosenId ? s.byId[chosenId] : undefined
    return !!status && isInstalled(status)
  })
  const agentId = installed ? chosenId : null

  // The agent starts while the message is written; the first send then waits for the session only.
  useEffect(() => {
    if (agentId) warmAgent(agentId)
  }, [agentId])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar>
        <NoDrag className="min-w-0">
          <span className="truncate px-1.5 text-ui font-medium">{t('newSession.title')}</span>
        </NoDrag>
        <span className="flex-1" />
        {project && <HeaderTools projectPath={project.path} />}
      </TopBar>
      {/* Raised 28 px above centre, so the eye lands on the composer. */}
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-14">
        <div className="my-auto flex w-full max-w-[760px] flex-col gap-7 pt-6">
          <h1 className="animate-in text-center text-title font-semibold text-balance fade-in animation-duration-(--duration-slow)">
            {t('newSession.heading')}
          </h1>
          <DraftComposer agentId={agentId} project={project} noProject={noProject} />
          <RecentSessions />
        </div>
      </div>
    </div>
  )
}

function DraftComposer({
  agentId,
  project,
  noProject,
}: {
  agentId: AgentId | null
  project: Project | null
  noProject: boolean
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation('composer')
  const [text, setText] = useState(() => readDraft(NEW_SESSION_DRAFT))
  const [projectError, setProjectError] = useState<string | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const sendKey = useSettingsStore((s) => s.settings.general.sendKey)
  const limits = useAgentsStore((s) => (agentId ? s.byId[agentId]?.limits : undefined))
  const now = useNow()
  const name = agentId ? agentName(agentId) : null
  const projectPath = noProject ? null : (project?.path ?? null)
  const ready = noProject || (!!project && !project.missing)
  const canSend = !!agentId && ready && text.trim().length > 0
  const tightest = limits ? tightestLimit(limits, now) : null
  const reached = tightest?.state === 'reached' ? tightest : null

  useEffect(() => {
    textarea.current?.focus()
    return () => flushDraft(NEW_SESSION_DRAFT)
  }, [])

  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.kind === 'focus-composer') textarea.current?.focus()
        if (event.kind === 'insert-into-composer' && !event.sessionId) {
          setText((current) => {
            const next = current ? `${current.replace(/\s+$/, '')}\n\n${event.text}` : event.text
            writeDraft(NEW_SESSION_DRAFT, next)
            return next
          })
          requestAnimationFrame(() => {
            const el = textarea.current
            if (!el) return
            el.focus()
            el.setSelectionRange(el.value.length, el.value.length)
          })
        }
      }),
    [],
  )

  // As in the session's composer: keeps the last line off the box's edge while typing at the end.
  useLayoutEffect(() => {
    const el = textarea.current
    if (!el || document.activeElement !== el || el.selectionEnd !== el.value.length) return
    if (el.scrollHeight > el.clientHeight) el.scrollTop = el.scrollHeight
  }, [text])

  const update = (next: string) => {
    setText(next)
    writeDraft(NEW_SESSION_DRAFT, next)
  }

  // The text stays in the draft until the session exists, so a failed start loses nothing.
  const send = () => {
    if (!canSend) return
    const { byId, picks } = useAgentOptionsStore.getState()
    const entry = byId[agentId]
    const options = entry ? startValues(entry, picks[agentId]) : null
    void createSession(agentId, projectPath, null, text, options)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME composition: Enter confirms the candidate, it never sends.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key !== 'Enter') return
    const sends = sendKey === 'enter' ? !event.shiftKey && !isMod(event) : isMod(event)
    if (!sends) return
    event.preventDefault()
    send()
  }

  const choose = (id: AgentId, model: string | null) => {
    useViewStore.setState((s) => (s.main.kind === 'new' ? { main: { ...s.main, agentId: id } } : s))
    const modelOption = useAgentOptionsStore
      .getState()
      .byId[id]?.config.find((o) => o.category === 'model')
    if (model !== null && modelOption) pickOption(id, modelOption.id, model)
    requestAnimationFrame(() => textarea.current?.focus())
  }

  const blocked = !agentId
    ? t('newSession.chooseAgentFirst')
    : !noProject && !project
      ? t('newSession.chooseProjectFirst')
      : project?.missing && !noProject
        ? t('newSession.missingLine')
        : null

  return (
    <InputGroup variant="composer">
      <div className="flex w-full min-w-0 flex-col">
        <div className="flex h-row min-w-0 items-center gap-0.5 px-1.5 pt-1.5">
          <ProjectMenu project={project} noProject={noProject} onError={setProjectError} />
          {!noProject && project && <BranchLabel projectPath={project.path} />}
          <Slash />
          <AgentMenu agentId={agentId} onChoose={choose} />
          <span className="min-w-2 flex-1" />
          <ModeMenu agentId={agentId} />
        </div>
        {(projectError || (project?.missing && !noProject)) && (
          <p
            className="truncate px-3.5 pt-1 text-xs text-destructive"
            title={projectError ?? undefined}
          >
            {projectError ?? t('newSession.missingLine')}
          </p>
        )}
        <div className="flex min-w-0 items-end">
          <InputGroupTextarea
            ref={textarea}
            rows={1}
            value={text}
            onChange={(event) => update(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label={
              name ? t('newSession.messageAgent', { agent: name }) : t('newSession.message')
            }
            placeholder={
              reached?.resetsAt
                ? tc('prompt.placeholder.limitReached', {
                    limit: limitLabel(reached),
                    time: resetTime(reached.resetsAt),
                  })
                : name
                  ? t('newSession.askAgent', { agent: name })
                  : t('newSession.describeTask')
            }
            className="max-h-[min(40svh,24rem)] min-h-(--composer-min) pt-2 pr-1 pb-[15px] pl-3.5 text-prose leading-[22px] placeholder:text-muted-foreground md:text-prose"
          />
          <InputGroupAddon align="inline-end" className="self-end gap-1.5 pr-3 pb-3 pl-1">
            <Tooltip>
              <TooltipTrigger render={<span />}>
                <InputGroupButton
                  size="round"
                  variant={canSend ? 'default' : 'secondary'}
                  aria-label={t('newSession.send')}
                  disabled={!canSend}
                  onClick={send}
                >
                  <ArrowUpIcon />
                </InputGroupButton>
              </TooltipTrigger>
              <TooltipContent>{blocked ?? t('newSession.send')}</TooltipContent>
            </Tooltip>
          </InputGroupAddon>
        </div>
      </div>
    </InputGroup>
  )
}

function Slash() {
  return (
    <span aria-hidden className="shrink-0 text-xs text-muted-foreground">
      /
    </span>
  )
}

/** The branch the session starts on, shown and not chosen: the top bar's git status owns it. */
function BranchLabel({ projectPath }: { projectPath: string }) {
  const { t } = useTranslation('session')
  const head = useGitStore((s) => {
    const status = s.status[projectPath]
    return status?.repo ? status.head : null
  })
  if (!head) return null
  const name = head.branch ?? head.oid?.slice(0, 7)
  if (!name) return null
  return (
    <>
      <Slash />
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="flex h-control min-w-8 shrink-1000 items-center gap-1 overflow-hidden px-2 text-[12.5px] text-muted-foreground" />
          }
        >
          <GitBranchIcon className="size-3.5 shrink-0" />
          <span className="truncate font-mono text-meta">{name}</span>
        </TooltipTrigger>
        <TooltipContent>
          {name} · {head.branch ? t('newSession.branchHint') : t('newSession.commitHint')}
        </TooltipContent>
      </Tooltip>
    </>
  )
}

/** The agent's mode for the session to start in, once its options are known. */
function ModeMenu({ agentId }: { agentId: AgentId | null }) {
  const config = useStartConfig(agentId)
  const mode = config?.find(
    (o): o is SelectOption => o.category === 'mode' && o.type === 'select' && !!o.choices?.length,
  )
  if (!agentId || !mode) return null
  return (
    <OptionMenu
      option={mode}
      side="bottom"
      onSelect={(optionId, value) => {
        pickOption(agentId, optionId, value)
        return Promise.resolve(true)
      }}
    />
  )
}

const RECENT = 3

/** The sessions used last, in any project, to pick up where they left off. */
function RecentSessions() {
  const { t } = useTranslation('session')
  const now = useNow()
  const recent = useSessionsStore(
    useShallow((s) =>
      Object.values(s.byId)
        .filter((summary) => summary.parentId === null && summary.origin === 'user')
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, RECENT),
    ),
  )
  const byId = useSessionsStore((s) => s.byId)
  const projects = useProjectsStore((s) => s.projects)
  if (recent.length === 0) return null
  const where = (summary: SessionSummary) =>
    isScratchFolder(byId, summary.projectPath)
      ? t('newSession.noProject')
      : (projects.find((p) => p.path === summary.projectPath)?.name ??
        basename(summary.projectPath))
  return (
    <section aria-label={t('newSession.recentLabel')} className="flex flex-col px-1">
      <h2 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
        {t('newSession.recent')}
      </h2>
      {recent.map((summary) => (
        <button
          key={summary.id}
          type="button"
          onClick={() => openSession(summary.id, summary.projectPath)}
          className="flex min-h-row items-center gap-2 rounded-lg px-2 text-left text-ui outline-none transition-colors duration-(--duration-fast) hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <AgentMark agent={summary.agentId} size={14} />
          <span className="min-w-0 flex-1 truncate">{sessionTitle(summary)}</span>
          <span className="max-w-40 shrink-0 truncate text-xs text-muted-foreground">
            {where(summary)}
          </span>
          <span className="w-12 shrink-0 text-right font-mono text-meta text-muted-foreground tabular">
            {shortAgo(summary.updatedAt, now)}
          </span>
        </button>
      ))}
    </section>
  )
}
