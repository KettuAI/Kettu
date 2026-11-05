import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUpIcon, CircleAlertIcon, FolderIcon, GitBranchIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project, SessionSummary, StartNotice } from '@shared/agent-host'
import type { AgentId, SlashCommand, UserContent } from '@shared/thread'
import { startNewSession } from '@renderer/app/actions'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { BrandFox } from '@renderer/components/brand'
import { Button } from '@renderer/components/ui/button'
import { InputGroupButton } from '@renderer/components/ui/input-group'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { OptionMenu } from '@renderer/features/session/composer/control-row'
import { SEND_FILL } from '@renderer/features/session/composer/send-button'
import type { SelectOption } from '@renderer/features/session/composer/levels'
import { tightestLimit } from '@renderer/features/sidebar/plan-usage'
import { useHostLabel } from '@renderer/features/sidebar/host-label'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { usePane } from '@renderer/features/split/pane-context'
import { basename, limitLabel, longAgo, resetTime } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isMod } from '@renderer/lib/platform'
import { useClock, useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { useAccountStore } from '@renderer/stores/account'
import { optionsLoaded, optionsOn, useAgentOptionsStore } from '@renderer/stores/agent-options'
import { agentName, agentsOn, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useGitStore } from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import {
  choosePaneAgent,
  openAgentSettings,
  openHarnessSettings,
  openSession,
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
import { AgentPicker } from './new-session/agent-picker'
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
import { pickupSessions, pickupState } from './new-session/picker'
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
      </TopBar>
      <ColumnScroller className="@container flex flex-col px-8">
        {/* Centred in the column. Auto margins fall away once the block is taller than the sheet,
            so a short window still scrolls from the top. */}
        <div className="mx-auto my-auto flex w-full max-w-175 flex-col py-8">
          <WelcomeHeading />
          <DraftComposer
            paneId={paneId}
            agentId={agentId}
            hostId={hostId}
            project={project}
            noProject={noProject}
            parent={parent}
            onInput={setHoldsMessage}
          >
            <PickUp hidden={holdsMessage} />
          </DraftComposer>
        </div>
      </ColumnScroller>
      <DropOverlay shown={drop.over} starting={false} agentName="" />
    </div>
  )
}

function greetingPeriod(now: number): 'morning' | 'afternoon' | 'evening' {
  const hour = new Date(now).getHours()
  if (hour >= 5 && hour < 12) return 'morning'
  if (hour >= 12 && hour < 18) return 'afternoon'
  return 'evening'
}

function WelcomeHeading() {
  const { t } = useTranslation('session')
  const period = useClock(greetingPeriod)
  const name = useAccountStore((s) =>
    s.status?.state === 'signed-in' ? s.status.account.name?.trim() || null : null,
  )
  return (
    <h1 className="mb-7 animate-in text-center font-greeting text-greeting font-normal text-balance wrap-anywhere fade-in animation-duration-(--duration-slow)">
      <BrandFox size={40} className="mr-3 inline-block size-[1.2em] align-middle" />
      {t(`newSession.${name ? 'greetingNamed' : 'greeting'}.${period}`, { name })}
    </h1>
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
      const usable = usableAgents(order, byId)
      return usable.length === 0 ? [] : noAgentCanStart(usable)
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
      try {
        await settleOptions(agentId)
      } catch (error) {
        box.setError(errorMessage(error))
        return
      }
      const optionsState = useAgentOptionsStore.getState()
      const { picks, prepared } = optionsState
      const entry = optionsOn(optionsState, hostId)[agentId]
      // Without a prepared session, the values New session showed go with the create.
      const options = entry ? startValues(entry, picks[agentId], { startMode: true }) : null
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
      {/* Taller and rounder than a session's composer, which keeps its own look. */}
      <div className="@container/draft w-full shrink-0 [&>[data-slot=input-group]]:rounded-[18px]">
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
              : t('newSession.describeTask')
          }
          label={name ? t('newSession.messageAgent', { agent: name }) : t('newSession.message')}
          // Three lines high empty, with the row of +, the pickers and Send under the text.
          size={{ minHeight: '96px', padding: '16px 12px 14px 18px' }}
          stacked
          onKeyDown={onKeyDown}
          lead={
            <>
              {parent ? (
                <ParentProject project={project} scratch={parent.scratch} />
              ) : (
                <ProjectMenu
                  project={project}
                  noProject={noProject}
                  onError={setProjectError}
                  chip
                />
              )}
              <AgentPicker agentId={agentId} onChoose={(id) => choose(id, null)} hostId={hostId} />
              {!inScratch && project && <BranchLabel projectPath={project.path} />}
            </>
          }
          end={
            <>
              <ModeMenu agentId={agentId} hostId={hostId} />
              {agentId && (
                <AgentMenu
                  agentId={agentId}
                  onChoose={choose}
                  folderless={!ready}
                  hostId={hostId}
                  modelOnly
                />
              )}
              <Tooltip>
                <TooltipTrigger render={<span />}>
                  <InputGroupButton
                    size="round"
                    variant={canSend ? 'default' : 'secondary'}
                    aria-label={t('newSession.send')}
                    disabled={!canSend}
                    onClick={() => void send()}
                    className={cn(
                      canSend && SEND_FILL,
                      'disabled:text-disabled disabled:opacity-100',
                    )}
                  >
                    <ArrowUpIcon strokeWidth={2} />
                  </InputGroupButton>
                </TooltipTrigger>
                <TooltipContent>{blocked ?? t('newSession.send')}</TooltipContent>
              </Tooltip>
            </>
          }
        />
      </div>
      <div className="flex w-full flex-col gap-1 pt-2 empty:hidden">
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
      </div>
      {children}
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
  const noneYet = waitingForNode.length === 0
  return (
    <div className="flex min-w-0 items-center gap-2 px-2.75">
      <p
        className={cn('truncate text-xs', noneYet ? 'text-secondary' : 'text-destructive')}
        title={text}
      >
        {text}
      </p>
      {hostId === null && (
        <Button
          variant="outline"
          size="xs"
          className="shrink-0"
          onClick={() => (noneYet ? openAgentSettings(null) : openHarnessSettings(null))}
        >
          {t(noneYet ? 'newSession.addAgent' : 'newSession.installHarness')}
        </Button>
      )}
    </div>
  )
}

/** A sub-session's project, shown and not chosen: it works in its parent's. */
function ParentProject({ project, scratch }: { project: Project | null; scratch: boolean }) {
  const { t } = useTranslation('session')
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="flex h-7.5 min-w-12 shrink-10 items-center gap-1.5 overflow-hidden rounded-xl bg-subtle px-2.25 text-control text-secondary" />
        }
      >
        <FolderIcon className="size-3.75 shrink-0" />
        <span className="truncate text-primary">
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

/**
 * The branch the session starts on, shown and not chosen: the top bar's git status owns it, so a
 * narrow composer leaves it out before its pickers run short. It sizes from the room left on the
 * row rather than its name, so it truncates instead of pushing the controls onto a second line.
 */
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
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="flex h-7.5 max-w-44 min-w-7.75 shrink-1000 grow items-center gap-1.5 overflow-hidden px-2.25 text-control text-primary contain-inline-size @max-[34rem]/draft:hidden" />
        }
      >
        <GitBranchIcon className="size-3.75 shrink-0 text-secondary" />
        <span className={cn('truncate', !head.branch && 'font-mono text-code')}>{name}</span>
      </TooltipTrigger>
      <TooltipContent>
        {name} · {head.branch ? t('newSession.branchHint') : t('newSession.commitHint')}
      </TooltipContent>
    </Tooltip>
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
 * The sessions changed last, each with what it is doing and its project, to open again; with none,
 * nothing shows. Hidden while a message is written, as the draft is the work at hand.
 */
function PickUp({ hidden }: { hidden: boolean }) {
  const { t } = useTranslation('session')
  const byId = useSessionsStore((s) => s.byId)
  const sessions = useMemo(() => pickupSessions(byId), [byId])
  const projects = useProjectsStore((s) => s.projects)
  const now = useNow()
  if (sessions.length === 0) return null
  return (
    <section
      aria-labelledby="new-session-pickup"
      inert={hidden}
      className={cn(
        'mt-10 flex flex-col transition-[opacity,translate,visibility] duration-(--duration-slow) ease-out-quart',
        hidden && 'invisible translate-y-2 opacity-0 motion-reduce:translate-y-0',
      )}
    >
      <h2 id="new-session-pickup" className="mb-1.5 px-2.5 text-hint font-medium text-tertiary">
        {t('newSession.pickup.title')}
      </h2>
      {sessions.map((session) => (
        <button
          key={session.id}
          type="button"
          onClick={() => openSession(session.id, session.projectPath)}
          className="flex h-10.5 min-w-0 items-center gap-3 rounded-segments px-2.5 text-left outline-none transition-colors duration-(--duration-fast) hover:bg-hover focus-ring"
        >
          <AgentMark agent={session.agentId} size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-row text-primary">
            {sessionTitle(session)}
          </span>
          <PickupStatus session={session} now={now} />
          <span className="w-16 shrink-0 truncate text-right text-control text-tertiary">
            {session.scratch
              ? t('newSession.noProject')
              : (projects.find((p) => p.path === session.projectPath)?.name ??
                basename(session.projectPath))}
          </span>
        </button>
      ))}
    </section>
  )
}

function PickupStatus({ session, now }: { session: SessionSummary; now: number }) {
  const { t } = useTranslation('session')
  const state = pickupState(session)
  const line = 'flex shrink-0 items-center gap-1.5 text-control'
  switch (state) {
    case 'waiting':
      return (
        <span className={cn(line, 'text-attention')}>
          <span aria-hidden className="size-1.75 rounded-full bg-attention-dot" />
          {t('newSession.pickup.waiting')}
        </span>
      )
    case 'working':
      return (
        <span className={cn(line, 'text-secondary')}>
          <Spinner aria-hidden className="size-3" />
          {t('newSession.pickup.working')}
        </span>
      )
    case 'failed':
      return <span className={cn(line, 'text-danger')}>{t('newSession.pickup.failed')}</span>
    case 'signIn':
      return <span className={cn(line, 'text-attention')}>{t('newSession.pickup.signIn')}</span>
    case 'finished':
      return (
        <span className={cn(line, 'text-tertiary')}>
          {t('newSession.pickup.finished', { ago: longAgo(session.updatedAt, now) })}
        </span>
      )
  }
}
