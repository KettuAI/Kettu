import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpIcon, CircleAlertIcon, GitBranchIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project, SessionSummary, StartNotice } from '@shared/agent-host'
import { NO_SESSION, type ArtifactSummary } from '@shared/artifacts'
import type { AgentId, SlashCommand, UserContent } from '@shared/thread'
import { startNewSession } from '@renderer/app/actions'
import { BrandMark } from '@renderer/components/brand'
import { Button } from '@renderer/components/ui/button'
import { InputGroupButton } from '@renderer/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ArtifactCard, CardSkeleton } from '@renderer/features/artifacts/artifact-card'
import { OptionMenu } from '@renderer/features/session/composer/control-row'
import type { SelectOption } from '@renderer/features/session/composer/levels'
import { tightestLimit } from '@renderer/features/sidebar/plan-usage'
import { HeaderTools } from '@renderer/features/shell/header-tools'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { basename, limitLabel, resetTime } from '@renderer/lib/format'
import { isMod } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentName, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { artifactListShown, useArtifactsStore } from '@renderer/stores/artifacts'
import { useGitStore } from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { openAgentSettings, openArtifacts, useViewStore } from '@renderer/stores/view'
import { DropOverlay } from './attachments/drop-overlay'
import { useFileDrop } from './attachments/use-file-drop'
import { attachmentContent, attachmentsBlock } from './composer/attachments'
import { NEW_SESSION_DRAFT } from './composer/drafts'
import { PromptBox } from './composer/prompt-box'
import { usePromptBox } from './composer/use-prompt-box'
import { AgentMenu } from './new-session/agent-menu'
import { ProjectMenu } from './new-session/project-menu'
import {
  enterNewSession,
  leaveNewSession,
  noteActivity,
  prepareFor,
  setOption,
  settleOptions,
} from './new-session/prepared'
import { agentNeed, canStart, noAgentCanStart, startValues } from './new-session/start-options'
import { useStartConfig } from './new-session/use-start-config'
import { ParentLink } from './session-header'

/**
 * The New session screen: where to work, which agent and model, and the first message, all in one
 * composer under a heading, with the artifacts changed last below it. The session is created on the
 * first send, which also sends the message; opened for a sub-session, under its parent, in the
 * parent's project.
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
    return !!status && canStart(status)
  })
  const agentId = installed ? chosenId : null
  const parentId = useViewStore((s) => (s.main.kind === 'new' ? (s.main.parentId ?? null) : null))
  const parent = useSessionsStore((s) => (parentId ? s.byId[parentId] : undefined))
  const toolsPath = project?.path ?? (parent?.scratch ? parent.projectPath : null)

  const drop = useFileDrop(NEW_SESSION_DRAFT, false)

  useEffect(() => {
    enterNewSession()
    return () => leaveNewSession()
  }, [])

  return (
    <div className="relative flex h-full min-h-0 flex-col" {...drop.handlers}>
      {/* As in the reference, the screen's own bar names nothing and draws no line: the heading
          below says where you are. A sub-session still leads with its parent. */}
      <TopBar className="shadow-none">
        {parent && (
          <NoDrag className="min-w-0 gap-0.5">
            {/* The label is short, so the parent's title takes the room left before the tools. */}
            <ParentLink parent={parent} className="max-w-none" />
            <span className="shrink-0 truncate px-1.5 text-ui font-medium">
              {t('newSession.subSessionTitle')}
            </span>
          </NoDrag>
        )}
        <span className="flex-1" />
        {toolsPath && <HeaderTools projectPath={toolsPath} />}
      </TopBar>
      {/* Raised 28 px above centre, so the eye lands on the composer. */}
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto pb-14">
        <div className="my-auto flex w-full max-w-thread flex-col gap-7 px-6 pt-6">
          <div className="flex animate-in items-center justify-center gap-3 fade-in animation-duration-(--duration-slow)">
            {/* At 36 px the mark is as tall as the capitals and sits on the baseline, like a letter. */}
            <BrandMark width={36} className="text-icon" />
            <h1 className="font-serif text-greeting text-balance">{t('newSession.heading')}</h1>
          </div>
          <DraftComposer
            agentId={agentId}
            project={project}
            noProject={noProject}
            parent={parent}
          />
          <RecentArtifacts />
        </div>
      </div>
      <DropOverlay shown={drop.over} starting={false} agentName="" />
    </div>
  )
}

const NO_COMMANDS: SlashCommand[] = []

function DraftComposer({
  agentId,
  project,
  noProject,
  parent,
}: {
  agentId: AgentId | null
  project: Project | null
  noProject: boolean
  parent: SessionSummary | undefined
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation('composer')
  const [projectError, setProjectError] = useState<string | null>(null)
  const sendKey = useSettingsStore((s) => s.settings.general.sendKey)
  const limits = useAgentsStore((s) => (agentId ? s.byId[agentId]?.limits : undefined))
  const waitingForNode = useAgentsStore(
    useShallow((s) => (s.loaded ? noAgentCanStart(usableAgents(s.order, s.byId)) : null)),
  )
  const now = useNow()
  const name = agentId ? agentName(agentId) : null
  // A sub-session of a session started with No project shares its parent's scratch folder.
  const inScratch = noProject || !!parent?.scratch
  const projectPath = parent?.projectPath ?? (noProject ? null : (project?.path ?? null))
  const box = usePromptBox({
    draft: NEW_SESSION_DRAFT,
    sessionId: null,
    projectPath,
    disabled: false,
    onActivity: noteActivity,
  })
  const { text, attachments, textarea } = box
  const ready = inScratch || (!!project && !project.missing)
  const held = attachmentsBlock(attachments, text)
  const canSend = !!agentId && ready && (text.trim().length > 0 || attachments.length > 0) && !held
  const tightest = limits ? tightestLimit(limits, now) : null
  const reached = tightest?.state === 'reached' ? tightest : null
  const sending = useRef(false)
  // An agent that must sign in first opens no session until it has.
  const signIn = useAgentsStore((s) => {
    const status = agentId ? s.byId[agentId] : undefined
    return !!status && agentNeed(status) === 'sign-in'
  })
  const parentId = parent?.id ?? null

  // The session the first message will use opens while it is written, so the menu shows what the
  // agent reports for it and the send only adopts it.
  useEffect(() => {
    prepareFor(agentId && ready && !signIn ? { agentId, projectPath, parentId } : null)
  }, [agentId, ready, signIn, projectPath, parentId])

  useEffect(() => {
    textarea.current?.focus()
  }, [textarea])

  // The message leaves the draft with the request and comes back to it if the start fails.
  const send = async () => {
    if (!canSend || sending.current) return
    sending.current = true
    try {
      await settleOptions()
      const { byId, picks, prepared } = useAgentOptionsStore.getState()
      const entry = byId[agentId]
      // Without a prepared session, the values New session showed go with the create.
      const options = entry ? startValues(entry, picks[agentId]) : null
      const preparedId = prepared?.agentId === agentId ? (prepared.summary?.id ?? null) : null
      const content: UserContent[] = [
        ...(text.trim() ? [{ type: 'text' as const, text }] : []),
        ...attachmentContent(attachments),
      ]
      void startNewSession(agentId, projectPath, content, options, preparedId)
    } finally {
      sending.current = false
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return
    const sends = sendKey === 'enter' ? !event.shiftKey && !isMod(event) : isMod(event)
    if (!sends) return
    event.preventDefault()
    void send()
  }

  const choose = (id: AgentId, model: string | null) => {
    useViewStore.setState((s) => (s.main.kind === 'new' ? { main: { ...s.main, agentId: id } } : s))
    const { byId, prepared } = useAgentOptionsStore.getState()
    const config =
      prepared?.agentId === id && prepared.summary?.prepared
        ? prepared.summary.prepared.config
        : byId[id]?.config
    const modelOption = config?.find((o) => o.category === 'model')
    if (model !== null && modelOption) setOption(id, modelOption.id, model)
    requestAnimationFrame(() => textarea.current?.focus())
  }

  const blocked = !agentId
    ? t('newSession.chooseAgentFirst')
    : !inScratch && !project
      ? t('newSession.chooseProjectFirst')
      : project?.missing && !inScratch
        ? t('newSession.missingLine')
        : (held?.message ?? null)

  return (
    <div className="flex flex-col gap-1.5">
      <PromptBox
        box={box}
        agentId={agentId}
        agentName={name ?? tc('attachments.theAgent')}
        commands={NO_COMMANDS}
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
        label={name ? t('newSession.messageAgent', { agent: name }) : t('newSession.message')}
        className="min-h-17 pt-3.5 pr-5 pb-1 pl-5"
        stacked
        onKeyDown={onKeyDown}
        end={
          <Tooltip>
            <TooltipTrigger render={<span />}>
              <InputGroupButton
                size="round"
                variant={canSend ? 'default' : 'secondary'}
                aria-label={t('newSession.send')}
                disabled={!canSend}
                onClick={() => void send()}
              >
                <ArrowUpIcon />
              </InputGroupButton>
            </TooltipTrigger>
            <TooltipContent>{blocked ?? t('newSession.send')}</TooltipContent>
          </Tooltip>
        }
      />
      {/* Where and with what the session starts, under the box as in the reference. */}
      <div className="flex h-control min-w-0 items-center gap-0.5 px-2.5">
        {parent ? (
          <ParentProject project={project} scratch={parent.scratch} />
        ) : (
          <ProjectMenu project={project} noProject={noProject} onError={setProjectError} />
        )}
        {!inScratch && project && <BranchLabel projectPath={project.path} />}
        <span className="min-w-2 flex-1" />
        <AgentMenu agentId={agentId} onChoose={choose} />
        <ModeMenu agentId={agentId} />
      </div>
      {(projectError || (project?.missing && !inScratch)) && (
        <p className="truncate px-5 text-xs text-danger" title={projectError ?? undefined}>
          {projectError ?? t('newSession.missingLine')}
        </p>
      )}
      {(box.error || held?.notice) && (
        <p className="animate-in px-5 text-xs text-danger fade-in" role="alert">
          {box.error ?? held?.message}
        </p>
      )}
      {agentId && <StartNotices agentId={agentId} />}
      {waitingForNode && <NoAgentLine waitingForNode={waitingForNode} />}
    </div>
  )
}

const NO_NOTICES: StartNotice[] = []

/** Each value the session will not start with as chosen, and why, before the first message. */
function StartNotices({ agentId }: { agentId: AgentId }) {
  const { t } = useTranslation('session')
  const all = useAgentOptionsStore((s) =>
    s.prepared?.agentId === agentId
      ? (s.prepared.summary?.prepared?.notices ?? NO_NOTICES)
      : NO_NOTICES,
  )
  // A switch meant to be off that the session lacks loses nothing.
  const notices = all.filter((n) => !(n.type === 'boolean' && n.actual === null && !n.wanted))
  if (notices.length === 0) return null
  const agent = agentName(agentId)
  return (
    <ul className="flex flex-col gap-0.5 px-5">
      {notices.map((notice) => {
        const text = noticeText(t, agent, notice)
        return (
          <li
            key={notice.optionId}
            className="flex min-w-0 items-start gap-1.5 text-xs text-secondary"
          >
            <CircleAlertIcon className="mt-0.5 size-3 shrink-0 text-warning" aria-hidden />
            <span className="min-w-0">{text}</span>
          </li>
        )
      })}
    </ul>
  )
}

function noticeText(
  t: ReturnType<typeof useTranslation<'session'>>['t'],
  agent: string,
  notice: StartNotice,
): string {
  const { option, wanted, actual, reason } = notice
  if (notice.type === 'boolean') {
    if (actual === null) return t('newSession.startNotice.noSwitch', { agent, option })
    return t(wanted ? 'newSession.startNotice.switchOff' : 'newSession.startNotice.switchOn', {
      agent,
      option,
    })
  }
  if (actual === null) {
    return t('newSession.startNotice.noOption', { agent, option, wanted: String(wanted) })
  }
  const values = { agent, option, wanted: String(wanted), actual: String(actual) }
  return notice.category === 'model'
    ? t(`newSession.startNotice.model.${reason}`, values)
    : t(`newSession.startNotice.option.${reason}`, values)
}

/** While no agent can start: why, in one line, and the way to Settings › Agents to fix it. */
function NoAgentLine({ waitingForNode }: { waitingForNode: string[] }) {
  const { t } = useTranslation('session')
  const text =
    waitingForNode.length > 0
      ? t('newSession.noAgentNode', { agents: waitingForNode, count: waitingForNode.length })
      : t('newSession.noAgent')
  return (
    <div className="flex min-w-0 items-center gap-2 px-5">
      <p className="truncate text-xs text-destructive" title={text}>
        {text}
      </p>
      <Button
        variant="outline"
        size="xs"
        className="shrink-0"
        onClick={() => openAgentSettings(null)}
      >
        {t('newSession.setUpAgents')}
      </Button>
    </div>
  )
}

function Slash() {
  return (
    <span aria-hidden className="shrink-0 text-xs text-muted-foreground">
      /
    </span>
  )
}

/** A sub-session's project, shown and not chosen: it works in its parent's. */
function ParentProject({ project, scratch }: { project: Project | null; scratch: boolean }) {
  const { t } = useTranslation('session')
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="flex h-control min-w-12 shrink-10 items-center gap-1 overflow-hidden px-2 text-control text-muted-foreground" />
        }
      >
        <span className="truncate font-medium text-foreground">
          {scratch ? t('newSession.noProject') : project?.name}
        </span>
        {project?.missing && !scratch && (
          <span className="shrink-0 text-danger">{t('newSession.missing')}</span>
        )}
      </TooltipTrigger>
      <TooltipContent>{t('newSession.subSessionProject')}</TooltipContent>
    </Tooltip>
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
            <span className="flex h-control min-w-8 shrink-1000 items-center gap-1 overflow-hidden px-2 text-control text-muted-foreground" />
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
        setOption(agentId, optionId, value)
        return Promise.resolve(true)
      }}
    />
  )
}

const RECENT = 3

/** The artifacts changed last, in any project, to open again; with none, nothing shows. */
function RecentArtifacts() {
  const { t } = useTranslation('session')
  const { t: ta } = useTranslation('artifacts')
  const recent = useArtifactsStore(useShallow((s) => s.list?.slice(0, RECENT) ?? null))
  const failed = useArtifactsStore((s) => s.error !== null)
  const projects = useProjectsStore((s) => s.projects)
  // Only the cards' session names, so other sessions' updates do not re-render the list.
  const sessions = useSessionsStore(
    useShallow((s) =>
      (recent ?? []).map(({ sessionId }) => {
        if (sessionId === NO_SESSION) return ta('page.imported')
        const summary = s.byId[sessionId]
        return summary ? sessionTitle(summary) : ta('page.deletedSession')
      }),
    ),
  )

  useEffect(() => {
    artifactListShown(true)
    return () => artifactListShown(false)
  }, [])

  // Before the first read, cards hold their places; a failed read hides the group.
  if (recent ? recent.length === 0 : failed) return null
  const where = (artifact: ArtifactSummary) =>
    artifact.scratch
      ? t('newSession.noProject')
      : (projects.find((p) => p.path === artifact.project)?.name ?? basename(artifact.project))
  return (
    <section
      aria-label={t('newSession.recentArtifacts')}
      className="@container flex flex-col gap-2 px-1"
    >
      <div className="flex items-center justify-between pl-2">
        <h2 className="text-ui text-secondary">{t('newSession.recentArtifacts')}</h2>
        <Button variant="quiet" size="sm" onClick={openArtifacts}>
          {t('newSession.viewAll')}
        </Button>
      </div>
      {/* Two across in a narrow window, so a canvas's pages still read. */}
      <div className="grid grid-cols-3 gap-3 @max-[32.5rem]:grid-cols-2">
        {(recent ?? Array.from({ length: RECENT }, () => null)).map((artifact, index) => (
          <div
            key={artifact?.id ?? index}
            className={cn('min-w-0', index === RECENT - 1 && '@max-[32.5rem]:hidden')}
          >
            {artifact ? (
              <ArtifactCard
                artifact={artifact}
                lead={where(artifact)}
                project={where(artifact)}
                session={sessions[index] ?? ''}
                tabbable
                variant="recent"
              />
            ) : (
              <CardSkeleton variant="recent" />
            )}
          </div>
        ))}
      </div>
    </section>
  )
}
