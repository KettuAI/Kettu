import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Alert02Icon, GitBranchIcon, GitCommitIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project, SessionSummary, StartNotice } from '@shared/agent-host'
import type { AgentId, SlashCommand, UserContent } from '@shared/thread'
import { startNewSession } from '@renderer/app/actions'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { FolderMark } from '@renderer/components/affect/assistant-home'
import { ChatComposer } from '@renderer/components/affect/chat-composer'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { HostChip } from '@renderer/features/session/composer/host-chip'
import { useModeControl } from '@renderer/features/session/composer/mode-control'
import { isSelect } from '@renderer/features/session/composer/options'
import { Glyph } from '@renderer/features/shell/glyph'
import { ModelMenu } from '@renderer/features/session/composer/model-menu'
import { SendButton } from '@renderer/features/session/composer/send-button'
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
import {
  optionsLoaded,
  optionsOn,
  picksOf,
  preparedFor,
  useAgentOptionsStore,
} from '@renderer/stores/agent-options'
import { agentName, agentsOn, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useGitStore } from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import { sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { useSettingsStore } from '@renderer/stores/settings'
import { refreshLimits } from '@renderer/stores/usage'
import {
  chooseNewSessionHost,
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
import { useAddMenu } from './composer/add-menu'
import { StartStyles, TrayStyles } from './composer/affect-styles'
import { PromptBox } from './composer/prompt-box'
import { usePromptBox } from './composer/use-prompt-box'
import { AgentPicker } from './new-session/agent-picker'
import { HostMenu } from './new-session/host-menu'
import { ProjectMenu } from './new-session/project-menu'
import {
  enterNewSession,
  leaveNewSession,
  noteActivity,
  prepareFor,
  readFirstOptions,
  refreshOnMenu,
  setOption,
  settleOptions,
} from './new-session/prepared'
import {
  greetingMoment,
  greetingPeriod,
  lastStartedAt,
  lineShown,
  pickLine,
  type GreetingMoment,
  type GreetingPeriod,
} from './new-session/greeting'
import { pickupSessions, pickupState } from './new-session/picker'
import { agentNeed, canStart, noAgentCanStart, startValues } from './new-session/start-options'
import { useStartConfig } from './new-session/use-start-config'
import { ParentLink } from './session-header'
import { ColumnScroller } from './session-states'
import { TurnDots } from './turn-dots'

/**
 * The New session screen, on affectUI's start screen: a greeting, then the Chat Composer with the
 * permission mode, model and Send over the text and the project, the agent and the branch on its
 * tray, then the sessions to pick up. The session is created on the first send, which also sends
 * the message; opened for a sub-session, under its parent, in the parent's project.
 */
export function NewSessionView({
  paneId,
  project,
  noProject = false,
  hostId: chosenHost = null,
  parentId = null,
}: {
  /** The pane that shows it; New session's own controls change that pane's view. */
  paneId: string | null
  project: Project | null
  noProject?: boolean
  /** The host chosen before a project, null for this computer; a project decides it once chosen. */
  hostId?: string | null
  /** A sub-session of that session, in its project. */
  parentId?: string | null
}) {
  const { t } = useTranslation('session')
  const chosenId = useViewStore((s) => (paneId ? paneAgent(s.layout, paneId) : null))
  const parent = useSessionsStore((s) => (parentId ? s.byId[parentId] : undefined))
  // The agents listed are those of the host the session will be on.
  const startPath = parent?.projectPath ?? (noProject ? null : (project?.path ?? null))
  const hostId = startPath === null ? (noProject ? null : chosenHost) : hostOfPath(startPath)
  const installed = useAgentsStore((s) => {
    const status = chosenId ? agentsOn(s, hostId).byId[chosenId] : undefined
    return !!status && canStart(status)
  })
  const agentId = installed ? chosenId : null
  // From the kept draft, so a draft left on an earlier visit hides Pick up from the start.
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
      {/* The screen's own bar names nothing and draws no line: the heading below says where you
          are. A sub-session still leads with its parent. The scroller below pads its end by the
          bar's height, so the start centers in the whole main area as in App Shell while menus
          opened in it stay clear of the bar. */}
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
      <ColumnScroller className="flex flex-col pb-(--top-bar)">
        <section className="ui-as-start" data-phase="start">
          <StartStyles />
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
        </section>
      </ColumnScroller>
      <DropOverlay shown={drop.over} starting={false} agentName="" />
    </div>
  )
}

function WelcomeHeading() {
  const { t } = useTranslation('session')
  const name = useAccountStore((s) =>
    s.status?.state === 'signed-in' ? s.status.account.name?.trim() || null : null,
  )
  const lastStarted = useSessionsStore((s) => (s.loaded ? lastStartedAt(s.byId) : undefined))
  // A primitive, so the heading re-renders only when the period or the moment changes.
  const key = useClock(
    (now) => `${greetingPeriod(new Date(now))}:${greetingMoment(now, lastStarted)}`,
  )
  const [period, moment] = key.split(':') as [GreetingPeriod, GreetingMoment]
  const hello = t(`newSession.greeting.hello.${moment === 'back' ? 'back' : period}`)
  const greeting = name ? t('newSession.greeting.named', { hello, name }) : hello
  const own = moment === 'first' || moment === 'back' ? null : moment
  const shortLines = own
    ? (t(`newSession.greeting.lines.${own}`, { returnObjects: true }) as readonly string[])
    : []
  // A period offers its greeting beside its own lines; the other moments replace both.
  const lines =
    moment === 'first'
      ? [t('newSession.greeting.first')]
      : moment === period || moment === 'back'
        ? [greeting, ...shortLines]
        : shortLines
  const index = useMemo(() => pickLine(key, lines.length), [key, lines.length])
  useEffect(() => lineShown(key, index), [key, index])
  return <h1 className="ui-as-start__title">{lines[index]}</h1>
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
  const status = useAgentsStore((s) => (agentId ? agentsOn(s, hostId).byId[agentId] : undefined))
  const limits = status?.limits
  const waitingForNode = useAgentsStore(
    useShallow((s) => {
      if (hostId === null ? !s.loaded : !(hostId in s.hosts)) return null
      const { order, byId } = agentsOn(s, hostId)
      const usable = usableAgents(order, byId).filter((a) => !a.disabled)
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
  const signIn = !!status && agentNeed(status) === 'sign-in'
  const parentId = parent?.id ?? null
  const config = useStartConfig(agentId, undefined, hostId)
  const add = useAddMenu({
    box,
    agentName: name ?? tc('attachments.theAgent'),
    commands: NO_COMMANDS,
  })

  // The session the first message will use opens while it is written, so the menu shows what the
  // agent reports for it and the send only adopts it.
  useEffect(() => {
    prepareFor(agentId && ready && !signIn ? { hostId, agentId, projectPath, parentId } : null)
  }, [hostId, agentId, ready, signIn, projectPath, parentId])

  // Without a folder nothing is prepared, so an agent with no options cached reads them once, and
  // the menu lists its models before a project is chosen.
  const cacheLoaded = useAgentOptionsStore((s) => optionsLoaded(s, hostId))
  useEffect(() => {
    if (agentId && hostId === null && !ready && !signIn && cacheLoaded) {
      void readFirstOptions(hostId, agentId)
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
        await settleOptions(hostId, agentId)
      } catch (error) {
        box.setError(errorMessage(error))
        return
      }
      const optionsState = useAgentOptionsStore.getState()
      const entry = optionsOn(optionsState, hostId)[agentId]
      // Without a prepared session, the values New session showed go with the create.
      const options = entry
        ? startValues(entry, picksOf(optionsState, hostId, agentId), { startMode: true })
        : null
      const preparedId = preparedFor(optionsState, hostId, agentId)?.summary?.id ?? null
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

  const choose = (id: AgentId) => {
    if (paneId) choosePaneAgent(paneId, id)
    requestAnimationFrame(() => editor.current?.focus())
  }

  // The host's most recent project comes with it, as the first project does when none is chosen.
  const projects = useProjectsStore((s) => s.projects)
  const chooseHost = (next: string | null) => {
    const first = projects.find((p) => hostOfPath(p.path) === next && !p.missing)
    chooseNewSessionHost(next, first?.path ?? null)
    requestAnimationFrame(() => editor.current?.focus())
  }

  // New session's picks only change what the session starts with, which the send reads.
  const pick = (optionId: string, value: string | boolean) => {
    if (agentId) setOption(hostId, agentId, optionId, value)
    return Promise.resolve(true)
  }
  const mode = config?.find((o): o is SelectOption => o.category === 'mode' && isSelect(o))
  const modeControl = useModeControl(agentId ? mode : undefined, pick)
  const hasModelMenu =
    !!agentId &&
    !!config?.some(
      (o) => o.type === 'boolean' || o.category === 'model' || o.category === 'thought_level',
    )

  const blocked = !agentId
    ? t('newSession.chooseAgentFirst')
    : !inScratch && !project
      ? t('newSession.chooseProjectFirst')
      : project?.missing && !inScratch
        ? t('newSession.missingLine')
        : (held?.message ?? null)

  return (
    <>
      <div className="ui-as-start__composer kettu-composer" data-variant="new">
        <ChatComposer
          field={
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
              size={{
                minHeight: 'calc(2 * var(--prose-size) + 14px)',
                padding: '0',
                lineHeight: 'calc(var(--prose-size) + 7px)',
              }}
              onKeyDown={onKeyDown}
            />
          }
          onFieldFocus={box.focus}
          addSections={add.sections}
          onAttach={add.onAttach}
          addDisabled={add.disabled}
          {...modeControl}
          models={[]}
          modelSlot={
            hasModelMenu &&
            agentId && (
              <ModelMenu
                agentId={agentId}
                hostId={hostId}
                agentName={name ?? ''}
                config={config ?? []}
                onSelect={pick}
                onOpenChange={(open) => {
                  if (!open || !status) return
                  if (status.state === 'ready' && status.capabilities.reports) {
                    refreshLimits(agentId, hostId).catch((error: unknown) =>
                      console.warn(`Could not read the plan limits: ${errorMessage(error)}`),
                    )
                  }
                  if (status.state === 'ready') refreshOnMenu(hostId, [agentId])
                }}
                account={status?.account ?? null}
                limits={limits ?? []}
                source={status?.version ? `${status.harnessName} ${status.version}` : null}
              />
            )
          }
          voice={false}
          send={
            <Tooltip>
              <TooltipTrigger render={<span className="kettu-send-wrap" />}>
                <SendButton
                  disabled={!canSend}
                  label={t('newSession.send')}
                  onClick={() => void send()}
                />
              </TooltipTrigger>
              <TooltipContent>{blocked ?? t('newSession.send')}</TooltipContent>
            </Tooltip>
          }
          labels={{
            composer: name
              ? t('newSession.messageAgent', { agent: name })
              : t('newSession.message'),
            add: tc('attachments.add'),
            addMenu: tc('attachments.add'),
            approvalMenu: tc('controls.permissionMode'),
            selected: (label) => tc('controls.selected', { label }),
          }}
          foot={
            <div className="ui-as-composer__tray kettu-tray">
              <TrayStyles />
              <span className="kettu-tray__group">
                {parent ? (
                  <>
                    <HostChip hostId={hostId} />
                    <ParentProject project={project} scratch={parent.scratch} />
                  </>
                ) : (
                  <>
                    <HostMenu hostId={hostId} onChoose={chooseHost} />
                    <ProjectMenu
                      project={project}
                      noProject={noProject}
                      onError={setProjectError}
                      chip
                      host={hostId}
                    />
                  </>
                )}
                <AgentPicker agentId={agentId} onChoose={choose} hostId={hostId} />
                {!inScratch && project && <BranchLabel projectPath={project.path} />}
              </span>
            </div>
          }
        />
      </div>
      <div className="kettu-start__notes">
        {(projectError || (project?.missing && !inScratch)) && (
          <p className="kettu-start__error" title={projectError ?? undefined}>
            {projectError ?? t('newSession.missingLine')}
          </p>
        )}
        {(box.error || held?.notice) && (
          <p className="kettu-start__error" role="alert">
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
  const all = useAgentOptionsStore(
    (s) => preparedFor(s, hostId, agentId)?.summary?.prepared?.notices ?? NO_NOTICES,
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
            <Glyph icon={Alert02Icon} size={12} className="mt-0.5 shrink-0 text-warning" />
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
      <TooltipTrigger render={<span className="ui-as-tray-link" data-static="" />}>
        <FolderMark />
        <span className="kettu-tray-link__text">
          {scratch ? t('newSession.noProject') : project?.name}
        </span>
        {project?.missing && !scratch && (
          <span className="kettu-tray-link__danger">{t('newSession.missing')}</span>
        )}
      </TooltipTrigger>
      <TooltipContent>{t('newSession.subSessionProject')}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The branch the session starts on, shown and not chosen: the session's tray owns it once the
 * session runs. It gives way first when the tray runs short.
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
        render={<span className="ui-as-tray-link kettu-tray-link--branch" data-static="" />}
      >
        <Glyph icon={head.branch ? GitBranchIcon : GitCommitIcon} size={13} />
        <span className={cn('kettu-tray-link__text', !head.branch && 'font-mono')}>{name}</span>
      </TooltipTrigger>
      <TooltipContent>
        {name} · {head.branch ? t('newSession.branchHint') : t('newSession.commitHint')}
      </TooltipContent>
    </Tooltip>
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
      className="kettu-pickup"
      data-hidden={hidden || undefined}
    >
      <h2 id="new-session-pickup" className="kettu-pickup__label">
        {t('newSession.pickup.title')}
      </h2>
      {sessions.map((session) => (
        <button
          key={session.id}
          type="button"
          onClick={() => openSession(session.id, session.projectPath)}
          className="kettu-pickup__row"
        >
          <AgentMark agent={session.agentId} size={16} className="shrink-0" />
          <span className="kettu-pickup__title">{sessionTitle(session)}</span>
          <PickupStatus session={session} now={now} />
          <span className="kettu-pickup__project">
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
  switch (state) {
    case 'waiting':
      return (
        <span className="kettu-pickup__status" data-status="waiting">
          <span aria-hidden className="kettu-pickup__dot" />
          {t('newSession.pickup.waiting')}
        </span>
      )
    case 'working':
      return (
        <span className="kettu-pickup__status">
          <TurnDots phase="working" className="size-2.75" />
          {t('newSession.pickup.working')}
        </span>
      )
    case 'failed':
      return (
        <span className="kettu-pickup__status" data-status="failed">
          {t('newSession.pickup.failed')}
        </span>
      )
    case 'signIn':
      return (
        <span className="kettu-pickup__status" data-status="waiting">
          {t('newSession.pickup.signIn')}
        </span>
      )
    case 'finished':
      return (
        <span className="kettu-pickup__status">
          {t('newSession.pickup.finished', { ago: longAgo(session.updatedAt, now) })}
        </span>
      )
  }
}
