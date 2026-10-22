import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpIcon, ChevronDownIcon, FolderIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import type { Project } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { addProjectFromDialog, createSession, warmAgent } from '@renderer/app/actions'
import { onAppEvent } from '@renderer/app/events'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
  ComboboxSeparator,
  ComboboxTrigger,
  useComboboxFilter,
} from '@renderer/components/ui/combobox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@renderer/components/ui/input-group'
import { HeaderTools } from '@renderer/features/shell/header-tools'
import { NoDrag, TopBar } from '@renderer/features/shell/top-bar'
import { errorMessage } from '@renderer/lib/host'
import { isMod } from '@renderer/lib/platform'
import { agentName, isInstalled, usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useProjectsStore } from '@renderer/stores/projects'
import { useSettingsStore } from '@renderer/stores/settings'
import { chooseNewSessionProject, useViewStore } from '@renderer/stores/view'
import { flushDraft, NEW_SESSION_DRAFT, readDraft, writeDraft } from './composer/drafts'
import { nameHints } from './project-names'

/**
 * The New session screen: a composer with the project, or No project, and the agent to start in.
 * The session is created on the first send, which also sends the message.
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
  const name = agentId ? agentName(agentId) : null
  const usable = noProject || (!!project && !project.missing)

  // The agent starts while the message is written; the first send then waits for the session only.
  useEffect(() => {
    if (agentId) warmAgent(agentId)
  }, [agentId])

  let line
  if (!project && !noProject) line = t('newSession.chooseProject')
  else if (project?.missing) line = t('newSession.projectMissing', { project: project.name })
  else if (!name) line = t('newSession.chooseAgent')
  else line = t('newSession.whatToWorkOn', { agent: name })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar>
        <NoDrag className="min-w-0">
          <span className="truncate px-1.5 text-ui font-medium">{t('newSession.title')}</span>
        </NoDrag>
        <span className="flex-1" />
        {project && <HeaderTools projectPath={project.path} />}
      </TopBar>
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 pb-16">
        <p className="animate-in text-[15px] text-muted-foreground fade-in animation-duration-(--duration-slow)">
          {line}
        </p>
      </div>
      <div className="mx-auto w-full max-w-[760px] px-6 pb-3">
        <DraftComposer
          agentId={agentId}
          agentName={name}
          ready={usable}
          projectPath={noProject ? null : (project?.path ?? null)}
        />
        <div className="flex h-row items-center gap-0.5 px-1">
          <ProjectMenu project={noProject ? null : project} noProject={noProject} />
          <AgentMenu agentId={agentId} />
        </div>
      </div>
    </div>
  )
}

function DraftComposer({
  agentId,
  agentName,
  ready,
  projectPath,
}: {
  agentId: AgentId | null
  agentName: string | null
  /** Whether a usable project, or No project, is chosen. */
  ready: boolean
  /** null: No project. */
  projectPath: string | null
}) {
  const { t } = useTranslation('session')
  const [text, setText] = useState(() => readDraft(NEW_SESSION_DRAFT))
  const textarea = useRef<HTMLTextAreaElement>(null)
  const sendKey = useSettingsStore((s) => s.settings.general.sendKey)
  const canSend = !!agentId && ready && text.trim().length > 0

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
    if (canSend) void createSession(agentId, projectPath, null, text)
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

  return (
    <InputGroup variant="composer">
      <InputGroupTextarea
        ref={textarea}
        rows={1}
        value={text}
        onChange={(event) => update(event.target.value)}
        onKeyDown={onKeyDown}
        aria-label={
          agentName ? t('newSession.messageAgent', { agent: agentName }) : t('newSession.message')
        }
        placeholder={
          agentName ? t('newSession.askAgent', { agent: agentName }) : t('newSession.describeTask')
        }
        className="max-h-[min(40svh,24rem)] min-h-(--composer-min) py-[15px] pr-1 pl-4 text-prose leading-[22px] placeholder:text-muted-foreground md:text-prose"
      />
      <InputGroupAddon align="inline-end" className="self-end gap-1.5 pr-3 pb-3 pl-1">
        <InputGroupButton
          size="round"
          variant={canSend ? 'default' : 'secondary'}
          aria-label={t('newSession.send')}
          disabled={!canSend}
          onClick={send}
        >
          <ArrowUpIcon />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}

// The values of the No project and Open project… items, which no project's path can take.
const NO_PROJECT = '\0no-project'
const OPEN_PROJECT = '\0open-project'

interface ProjectGroup {
  value: 'none' | 'recent' | 'open'
  items: string[]
}

/**
 * No project, then the projects by name, most recently opened first, with a search field over
 * them and Open project… last. The items are paths.
 */
function ProjectMenu({ project, noProject }: { project: Project | null; noProject: boolean }) {
  const { t } = useTranslation('session')
  const projects = useProjectsStore((s) => s.projects)
  const [error, setError] = useState<string | null>(null)
  const { contains } = useComboboxFilter()
  const byPath = useMemo(() => new Map(projects.map((p) => [p.path, p])), [projects])
  const hints = useMemo(() => nameHints(projects.map((p) => p.path)), [projects])
  const groups = useMemo<ProjectGroup[]>(
    () => [
      { value: 'none', items: [NO_PROJECT] },
      { value: 'recent', items: projects.map((p) => p.path) },
      { value: 'open', items: [OPEN_PROJECT] },
    ],
    [projects],
  )
  const label = (value: string) =>
    value === NO_PROJECT ? t('newSession.noProject') : (byPath.get(value)?.name ?? value)
  const open = async () => {
    setError(null)
    try {
      const path = await addProjectFromDialog()
      if (path) chooseNewSessionProject(path)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <>
      <Combobox
        items={groups}
        value={noProject ? NO_PROJECT : (project?.path ?? null)}
        onValueChange={(value: string | null) => {
          if (value === OPEN_PROJECT) void open()
          else if (value === NO_PROJECT) chooseNewSessionProject(null)
          else if (value) chooseNewSessionProject(value)
        }}
        itemToStringLabel={label}
        filter={(value: string, query: string) =>
          value === OPEN_PROJECT || contains(`${label(value)} ${hints.get(value) ?? ''}`, query)
        }
      >
        <ComboboxTrigger
          render={
            <Button
              variant="quiet"
              size="compact"
              aria-label={t('newSession.project')}
              title={project?.path}
              className="min-w-0 shrink gap-1 px-2"
            />
          }
        >
          <FolderIcon data-icon="inline-start" />
          <span className="truncate text-foreground">
            {noProject
              ? t('newSession.noProject')
              : (project?.name ?? t('newSession.chooseProjectShort'))}
          </span>
        </ComboboxTrigger>
        <ComboboxContent side="top" sideOffset={6} className="max-w-80">
          <ComboboxInput
            showTrigger={false}
            placeholder={t('newSession.searchProjects')}
            aria-label={t('newSession.searchProjectsLabel')}
            spellCheck={false}
          />
          <ComboboxList className="max-h-none overflow-y-visible">
            {(group: ProjectGroup, index: number) =>
              group.value === 'none' ? (
                <ComboboxGroup key={group.value} items={group.items}>
                  <ComboboxCollection>
                    {(value: string) => (
                      <ComboboxItem key={value} value={value}>
                        {t('newSession.noProject')}
                      </ComboboxItem>
                    )}
                  </ComboboxCollection>
                </ComboboxGroup>
              ) : group.value === 'recent' ? (
                <ComboboxGroup key={group.value} items={group.items}>
                  {index > 0 && <ComboboxSeparator />}
                  <ComboboxLabel>{t('newSession.recent')}</ComboboxLabel>
                  {/* Only the projects scroll, leaving room for the search field and Open project… */}
                  <div className="relative -mx-1.5 max-h-[min(--spacing(72),calc(var(--available-height)---spacing(28)))] scroll-fade-y overflow-y-auto overscroll-contain px-1.5">
                    <ComboboxCollection>
                      {(path: string) => {
                        const p = byPath.get(path)
                        return (
                          p && (
                            <ComboboxItem key={path} value={path} disabled={p.missing} title={path}>
                              <ProjectName name={p.name} hint={hints.get(path)} />
                              {p.missing && (
                                <span className="ml-auto text-xs text-muted-foreground">
                                  {t('newSession.missing')}
                                </span>
                              )}
                            </ComboboxItem>
                          )
                        )
                      }}
                    </ComboboxCollection>
                  </div>
                </ComboboxGroup>
              ) : (
                <ComboboxGroup key={group.value} items={group.items}>
                  {index > 0 ? (
                    <ComboboxSeparator />
                  ) : (
                    projects.length > 0 && (
                      <div className="flex min-h-row items-center px-2 text-ui text-muted-foreground">
                        {t('newSession.noMatchingProjects')}
                      </div>
                    )
                  )}
                  <ComboboxCollection>
                    {(value: string) => (
                      <ComboboxItem key={value} value={value}>
                        {t('newSession.openProject')}
                      </ComboboxItem>
                    )}
                  </ComboboxCollection>
                </ComboboxGroup>
              )
            }
          </ComboboxList>
          {/* Sized by every project, so the menu keeps its width while the list filters. */}
          <div aria-hidden className="invisible h-0 overflow-hidden px-1.5">
            {projects.map((p) => (
              <div key={p.path} className="flex gap-2 pr-8 pl-2 text-ui whitespace-nowrap">
                <ProjectName name={p.name} hint={hints.get(p.path)} />
              </div>
            ))}
          </div>
        </ComboboxContent>
      </Combobox>
      {error && (
        <span className="min-w-0 truncate px-1.5 text-xs text-destructive" title={error}>
          {error}
        </span>
      )}
    </>
  )
}

function AgentMenu({ agentId }: { agentId: AgentId | null }) {
  const { t } = useTranslation('session')
  const agents = useAgentsStore(useShallow((s) => usableAgents(s.order, s.byId)))
  const choose = (id: AgentId) =>
    useViewStore.setState((s) => (s.main.kind === 'new' ? { main: { ...s.main, agentId: id } } : s))

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="quiet"
            size="compact"
            aria-label={t('newSession.agent')}
            className="min-w-0 shrink gap-1.5 px-2"
          />
        }
      >
        {agentId && <AgentMark agent={agentId} size={13} />}
        <span className="truncate text-foreground">
          {agentId ? agentName(agentId) : t('newSession.chooseAgentShort')}
        </span>
        <ChevronDownIcon data-icon="inline-end" className="-ml-0.5 size-3 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={6}>
        <DropdownMenuRadioGroup
          value={agentId ?? undefined}
          onValueChange={(value) => choose(value as AgentId)}
        >
          {agents.map((status) => (
            <DropdownMenuRadioItem
              key={status.id}
              value={status.id}
              disabled={!isInstalled(status)}
              closeOnClick
            >
              <AgentMark agent={status.id} size={14} />
              <span className="min-w-0 flex-1 truncate">{agentName(status.id)}</span>
              {!isInstalled(status) && (
                <span className="text-xs text-muted-foreground">
                  {t('newSession.notInstalled')}
                </span>
              )}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A project's name, with the parent folders that tell it from another of the same name. */
function ProjectName({ name, hint }: { name: string; hint: string | undefined }) {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span className="truncate">{name}</span>
      {hint && <span className="min-w-0 shrink-3 truncate text-muted-foreground">{hint}</span>}
    </span>
  )
}
