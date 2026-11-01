import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowUpIcon, CircleAlertIcon, FolderIcon, GitBranchIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project, SessionSummary, StartNotice } from '@shared/agent-host'
import { NO_SESSION, type ArtifactSummary } from '@shared/artifacts'
import type { AgentId, SlashCommand, UserContent } from '@shared/thread'
import { startNewSession } from '@renderer/app/actions'
import { Button } from '@renderer/components/ui/button'
import { InputGroupButton } from '@renderer/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { ArtifactCard, CardSkeleton } from '@renderer/features/artifacts/artifact-card'
import { OptionMenu } from '@renderer/features/session/composer/control-row'
import type { SelectOption } from '@renderer/features/session/composer/levels'
import { tightestLimit } from '@renderer/features/sidebar/plan-usage'
import { HeaderTools } from '@renderer/features/shell/header-tools'
import { useHostLabel } from '@renderer/features/sidebar/host-label'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { usePane } from '@renderer/features/split/pane-context'
import { basename, limitLabel, resetTime } from '@renderer/lib/format'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isMod } from '@renderer/lib/platform'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { optionsLoaded, optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentName, agentsOn, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { artifactListShown, useArtifactsStore } from '@renderer/stores/artifacts'
import { useGitStore } from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  choosePaneAgent,
  openHarnessSettings,
  openArtifacts,
  paneAgent,
  useViewStore,
} from '@renderer/stores/view'
import { DropOverlay } from './attachments/drop-overlay'
import { useFileDrop } from './attachments/use-file-drop'
import { attachmentContent, attachmentsBlock } from './composer/attachments'
import { hasMessage, NEW_SESSION_DRAFT, readDraft, readDraftAttachments } from './composer/drafts'
import { PromptBox } from './composer/prompt-box'
import { usePromptBox } from './composer/use-prompt-box'
import { AgentMenu } from './new-session/agent-menu'
import { ProjectMenu } from './new-session/project-menu'
import {
  enterNewSession,
  leaveNewSession,
  noteActivity,
  prepareFor,
  readFirstOptions,
  setOption,
  settleOptions,
} from './new-session/prepared'
import { RECENT, recentCards } from './new-session/recent'
import { agentNeed, canStart, noAgentCanStart, startValues } from './new-session/start-options'
import { useStartConfig } from './new-session/use-start-config'
import { ParentLink } from './session-header'
import { ColumnScroller } from './session-states'

/**
 * The New session screen: where to work, which agent and model, and the first message, all in one
 * composer under a heading, with the artifacts changed last below it. The session is created on the
 * first send, which also sends the message; opened for a sub-session, under its parent, in the
 * parent's project.
 */
export function NewSessionView({
  paneId,
  project,
  noProject = false,
  parentId = null,
}: {
  /** The pane that shows it; New session's own controls change that pane's view. */
  paneId: string | null
  project: Project | null
  noProject?: boolean
  /** A sub-session of that session, in its project. */
  parentId?: string | null
}) {
  const { t } = useTranslation('session')
  const chosenId = useViewStore((s) => (paneId ? paneAgent(s.layout, paneId) : null))
  const parent = useSessionsStore((s) => (parentId ? s.byId[parentId] : undefined))
  // The agents listed are those of the host the session will be on.
  const startPath = parent?.projectPath ?? (noProject ? null : (project?.path ?? null))
  const hostId = startPath === null ? null : hostOfPath(startPath)
  const installed = useAgentsStore((s) => {
    const status = chosenId ? agentsOn(s, hostId).byId[chosenId] : undefined
    return !!status && canStart(status)
  })
  const agentId = installed ? chosenId : null
  const toolsPath = project?.path ?? (parent?.scratch ? parent.projectPath : null)
  // From the kept draft, so a draft left on an earlier visit hides Recent artifacts from the start.
  const [holdsMessage, setHoldsMessage] = useState(() =>
    hasMessage(readDraft(NEW_SESSION_DRAFT), readDraftAttachments(NEW_SESSION_DRAFT)),
  )

  const drop = useFileDrop(NEW_SESSION_DRAFT, false)
  const cornered = usePane()?.cornered

  useEffect(() => {
    enterNewSession()
    return () => leaveNewSession()
  }, [])

  return (
    <div className="relative flex h-full min-h-0 flex-col" {...drop.handlers}>
      {/* As in the reference, the screen's own bar names nothing and draws no line: the heading
          below says where you are. A sub-session still leads with its parent. */}
      <TopBar className="shadow-none" cornered={cornered}>
        {parent && (
          <NoDrag className="min-w-0 gap-0.5">
            <ParentLink parent={parent} />
            <span className="shrink-0 truncate px-1.5 text-ui font-medium">
              {t('newSession.subSessionTitle')}
            </span>
          </NoDrag>
        )}
        <span className="flex-1" />
        {toolsPath && <HeaderTools projectPath={toolsPath} />}
      </TopBar>
      <ColumnScroller className="flex flex-col px-7">
        <div className="mx-auto flex w-full max-w-thread flex-1 flex-col justify-end">
          <h1 className="mt-6 mb-6.5 animate-in text-center font-heading text-greeting font-medium text-balance fade-in animation-duration-(--duration-slow)">
            {t('newSession.heading')}
          </h1>
        </div>
        <DraftComposer
          paneId={paneId}
          agentId={agentId}
          hostId={hostId}
          project={project}
          noProject={noProject}
          parent={parent}
          onInput={setHoldsMessage}
        >
          <RecentArtifacts hidden={holdsMessage} />
        </DraftComposer>
      </ColumnScroller>
      <DropOverlay shown={drop.over} starting={false} agentName="" />
    </div>
  )
}

const NO_COMMANDS: SlashCommand[] = []

function DraftComposer({
  paneId,
  agentId,
  hostId,
  project,
  noProject,
  parent,
  onInput,
  children,
}: {
  paneId: string | null
  agentId: AgentId | null
  /** The other host the session will be on, null for this computer. */
  hostId: string | null
  project: Project | null
  noProject: boolean
  parent: SessionSummary | undefined
  /** Told on each change whether the draft holds what Send takes. */
  onInput: (holdsMessage: boolean) => void
  children?: ReactNode
}) {
  const { t } = useTranslation('session')
  const { t: tc } = useTranslation('composer')
  const [projectError, setProjectError] = useState<string | null>(null)
  const sendKey = useSettingsStore((s) => s.settings.general.sendKey)
  const limits = useAgentsStore((s) =>
    agentId ? agentsOn(s, hostId).byId[agentId]?.limits : undefined,
  )
  const waitingForNode = useAgentsStore(
    useShallow((s) => {
      if (hostId === null ? !s.loaded : !(hostId in s.hosts)) return null
      const { order, byId } = agentsOn(s, hostId)
      return noAgentCanStart(usableAgents(order, byId))
    }),
  )
  const now = useNow()
  const name = agentId ? agentName(agentId, hostId) : null
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
  const { text, attachments, editor } = box
  const ready = inScratch || (!!project && !project.missing)
  const held = attachmentsBlock(attachments, text)
  const holdsMessage = hasMessage(text, attachments)
  const canSend = !!agentId && ready && holdsMessage && !held
  const tightest = limits ? tightestLimit(limits, now) : null
  const reached = tightest?.state === 'reached' ? tightest : null
  const sending = useRef(false)
  // An agent that must sign in first opens no session until it has.
  const signIn = useAgentsStore((s) => {
    const status = agentId ? agentsOn(s, hostId).byId[agentId] : undefined
    return !!status && agentNeed(status) === 'sign-in'
  })
  const parentId = parent?.id ?? null

  // The session the first message will use opens while it is written, so the menu shows what the
  // agent reports for it and the send only adopts it.
  useEffect(() => {
    prepareFor(agentId && ready && !signIn ? { agentId, projectPath, parentId } : null)
  }, [agentId, ready, signIn, projectPath, parentId])

  // Without a folder nothing is prepared, so an agent with no options cached reads them once, and
  // the menu lists its models before a project is chosen.
  const cacheLoaded = useAgentOptionsStore((s) => optionsLoaded(s, hostId))
  useEffect(() => {
    if (agentId && hostId === null && !ready && !signIn && cacheLoaded) {
      void readFirstOptions(agentId)
    }
  }, [agentId, hostId, ready, signIn, cacheLoaded])

  useEffect(() => {
    editor.current?.focus()
  }, [editor])

  useEffect(() => onInput(holdsMessage), [holdsMessage, onInput])

  // The message leaves the draft with the request and comes back to it if the start fails.
  const send = async () => {
    if (!canSend || sending.current) return
    sending.current = true
    try {
      await settleOptions()
      const optionsState = useAgentOptionsStore.getState()
      const { picks, prepared } = optionsState
      const entry = optionsOn(optionsState, hostId)[agentId]
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

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return
    const sends = sendKey === 'enter' ? !event.shiftKey && !isMod(event) : isMod(event)
    if (!sends) return
    event.preventDefault()
    void send()
  }

  const choose = (id: AgentId, model: string | null) => {
    if (paneId) choosePaneAgent(paneId, id)
    const state = useAgentOptionsStore.getState()
    const { prepared } = state
    const config =
      prepared?.agentId === id && prepared.summary?.prepared
        ? prepared.summary.prepared.config
        : optionsOn(state, hostId)[id]?.config
    const modelOption = config?.find((o) => o.category === 'model')
    if (model !== null && modelOption) setOption(id, modelOption.id, model)
    requestAnimationFrame(() => editor.current?.focus())
  }

  const blocked = !agentId
    ? t('newSession.chooseAgentFirst')
    : !inScratch && !project
      ? t('newSession.chooseProjectFirst')
      : project?.missing && !inScratch
        ? t('newSession.missingLine')
        : (held?.message ?? null)

  return (
    <>
      <div className="mx-auto w-full max-w-thread shrink-0">
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
          // 112 px high empty, with the row of + and Send under the text.
          size={{ minHeight: '62px', padding: '15px 16px 2px 16px' }}
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
                  className="disabled:text-disabled disabled:opacity-100"
                >
                  <ArrowUpIcon />
                </InputGroupButton>
              </TooltipTrigger>
              <TooltipContent>{blocked ?? t('newSession.send')}</TooltipContent>
            </Tooltip>
          }
        />
      </div>
      {/* The lower part starts the top bar's height taller: the column begins that far below the
          sheet's top, so an even split of the rest about the box centres it on the sheet. */}
      <div className="mx-auto flex w-full max-w-thread flex-1 basis-(--top-bar) flex-col">
        {/* Where and with what the session starts, under the box as in the reference. */}
        <div className="flex h-9.5 min-w-0 items-center gap-0.5 px-0.5 pt-1">
          {parent ? (
            <ParentProject project={project} scratch={parent.scratch} />
          ) : (
            <ProjectMenu project={project} noProject={noProject} onError={setProjectError} />
          )}
          {!inScratch && project && <BranchLabel projectPath={project.path} />}
          <span className="min-w-2 flex-1" />
          <AgentMenu agentId={agentId} onChoose={choose} folderless={!ready} hostId={hostId} />
          <ModeMenu agentId={agentId} hostId={hostId} />
        </div>
        {(projectError || (project?.missing && !inScratch)) && (
          <p className="truncate px-2.75 text-xs text-danger" title={projectError ?? undefined}>
            {projectError ?? t('newSession.missingLine')}
          </p>
        )}
        {(box.error || held?.notice) && (
          <p className="animate-in px-2.75 text-xs text-danger fade-in" role="alert">
            {box.error ?? held?.message}
          </p>
        )}
        {agentId && <StartNotices agentId={agentId} hostId={hostId} />}
        {waitingForNode && <NoAgentLine waitingForNode={waitingForNode} hostId={hostId} />}
        {children}
      </div>
    </>
  )
}

const NO_NOTICES: StartNotice[] = []

/** Each value the session will not start with as chosen, and why, before the first message. */
function StartNotices({ agentId, hostId }: { agentId: AgentId; hostId: string | null }) {
  const { t } = useTranslation('session')
  const all = useAgentOptionsStore((s) =>
    s.prepared?.agentId === agentId
      ? (s.prepared.summary?.prepared?.notices ?? NO_NOTICES)
      : NO_NOTICES,
  )
  // A switch meant to be off that the session lacks loses nothing.
  const notices = all.filter((n) => !(n.type === 'boolean' && n.actual === null && !n.wanted))
  if (notices.length === 0) return null
  const agent = agentName(agentId, hostId)
  return (
    <ul className="flex flex-col gap-0.5 px-2.75">
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

/**
 * While no agent can start: why, in one line, and the way to Settings › Agents to fix it; on
 * another host only why, since this computer's Settings do not set up its agents.
 */
function NoAgentLine({
  waitingForNode,
  hostId,
}: {
  waitingForNode: string[]
  hostId: string | null
}) {
  const { t } = useTranslation('session')
  const hostLabel = useHostLabel(hostId)
  const text =
    hostId !== null
      ? t('newSession.noAgentOnHost', { host: hostLabel })
      : waitingForNode.length > 0
        ? t('newSession.noAgentNode', { agents: waitingForNode, count: waitingForNode.length })
        : t('newSession.noAgent')
  return (
    <div className="flex min-w-0 items-center gap-2 px-2.75">
      <p className="truncate text-xs text-destructive" title={text}>
        {text}
      </p>
      {hostId === null && (
        <Button
          variant="outline"
          size="xs"
          className="shrink-0"
          onClick={() => openHarnessSettings(null)}
        >
          {t('newSession.installHarness')}
        </Button>
      )}
    </div>
  )
}

function Slash() {
  return (
    <span aria-hidden className="mx-0.5 shrink-0 text-control text-border-strong">
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
          <span className="flex h-7 min-w-12 shrink-10 items-center gap-1 overflow-hidden px-2.25 text-control text-muted-foreground" />
        }
      >
        <FolderIcon className="size-3.5 shrink-0" />
        <span className="truncate text-foreground">
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
            <span className="flex h-7 min-w-7.75 shrink-1000 items-center gap-1.25 overflow-hidden px-1.5 text-muted-foreground" />
          }
        >
          <GitBranchIcon className="size-3.5 shrink-0" />
          <span className="truncate font-mono text-code">{name}</span>
        </TooltipTrigger>
        <TooltipContent>
          {name} · {head.branch ? t('newSession.branchHint') : t('newSession.commitHint')}
        </TooltipContent>
      </Tooltip>
    </>
  )
}

/** The agent's mode for the session to start in, once its options are known. */
function ModeMenu({ agentId, hostId }: { agentId: AgentId | null; hostId: string | null }) {
  const config = useStartConfig(agentId, undefined, hostId)
  const mode = config?.find(
    (o): o is SelectOption => o.category === 'mode' && o.type === 'select' && !!o.choices?.length,
  )
  if (!agentId || !mode) return null
  return (
    <OptionMenu
      option={mode}
      side="bottom"
      align="end"
      className="text-control font-normal has-data-[icon=inline-end]:pr-2.25"
      onSelect={(optionId, value) => {
        setOption(agentId, optionId, value)
        return Promise.resolve(true)
      }}
    />
  )
}

/**
 * The artifacts changed last, in any project, to open again; with none, nothing shows. Hidden, it
 * stays mounted, so it keeps loading and comes back with its cards.
 */
function RecentArtifacts({ hidden }: { hidden: boolean }) {
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

  const { cards, shown } = recentCards(recent, failed, hidden)
  const where = (artifact: ArtifactSummary) =>
    artifact.scratch
      ? t('newSession.noProject')
      : (projects.find((p) => p.path === artifact.project)?.name ?? basename(artifact.project))
  return (
    <section
      aria-label={t('newSession.recentArtifacts')}
      inert={!shown}
      className={cn(
        '@container mt-12 mb-6 flex flex-col gap-1.5 transition-[opacity,translate,visibility] duration-(--duration-slow) ease-out-quart',
        !shown &&
          'invisible translate-y-2 opacity-0 motion-reduce:translate-y-0 **:data-[slot=skeleton]:animate-none',
      )}
    >
      <div className="flex items-center justify-between">
        <h2 className="flex h-7.5 items-center px-1 text-xs font-medium text-tertiary">
          {t('newSession.recentArtifacts')}
        </h2>
        <Button
          variant="quiet"
          size="sm"
          onClick={openArtifacts}
          className="px-2.25 text-ui font-normal text-secondary"
        >
          {t('newSession.viewAll')}
        </Button>
      </div>
      {/* Two across in a narrow window, so a canvas's pages still read. */}
      <div className="grid grid-cols-3 gap-4 @max-[32.5rem]:grid-cols-2">
        {cards.map((artifact, index) => (
          <div
            key={artifact?.id ?? index}
            className={cn('min-w-0', index === RECENT - 1 && '@max-[32.5rem]:hidden')}
          >
            {artifact ? (
              <ArtifactCard
                artifact={artifact}
                lead={where(artifact)}
                time={{ at: artifact.updatedAt, opened: false }}
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
