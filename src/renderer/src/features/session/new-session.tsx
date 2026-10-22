import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpIcon, ChevronDownIcon, FolderIcon } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { Project } from '@shared/agent-host'
import type { AgentId } from '@shared/thread'
import { addProjectFromDialog, createSession, warmAgent } from '@renderer/app/actions'
import { onAppEvent } from '@renderer/app/events'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { Button } from '@renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
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
import { useViewStore } from '@renderer/stores/view'
import { flushDraft, NEW_SESSION_DRAFT, readDraft, writeDraft } from './composer/drafts'

/**
 * The New session screen: a composer with the project and the agent to start in. The session is
 * created on the first send, which also sends the message.
 */
export function NewSessionView({ project }: { project: Project | null }) {
  const chosenId = useViewStore((s) => (s.main.kind === 'new' ? s.main.agentId : null))
  const installed = useAgentsStore((s) => {
    const status = chosenId ? s.byId[chosenId] : undefined
    return !!status && isInstalled(status)
  })
  const agentId = installed ? chosenId : null
  const name = agentId ? agentName(agentId) : null
  const usable = !!project && !project.missing

  // The agent starts while the message is written; the first send then waits for the session only.
  useEffect(() => {
    if (agentId) warmAgent(agentId)
  }, [agentId])

  let line
  if (!project) line = 'Choose a project to work in'
  else if (project.missing) line = `${project.name} no longer exists`
  else if (!name) line = 'Choose an agent for this session'
  else line = `What should ${name} work on?`

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar>
        <NoDrag className="min-w-0">
          <span className="truncate px-1.5 text-[13px] font-medium">New session</span>
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
          projectPath={usable ? project.path : null}
        />
        <div className="flex h-row items-center gap-0.5 px-1">
          <ProjectMenu project={project} />
          <AgentMenu agentId={agentId} />
        </div>
      </div>
    </div>
  )
}

function DraftComposer({
  agentId,
  agentName,
  projectPath,
}: {
  agentId: AgentId | null
  agentName: string | null
  projectPath: string | null
}) {
  const [text, setText] = useState(() => readDraft(NEW_SESSION_DRAFT))
  const textarea = useRef<HTMLTextAreaElement>(null)
  const sendKey = useSettingsStore((s) => s.settings.general.sendKey)
  const canSend = !!agentId && !!projectPath && text.trim().length > 0

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
        aria-label={agentName ? `Message ${agentName}` : 'Message'}
        placeholder={agentName ? `Ask ${agentName} to…` : 'Describe a task…'}
        className="max-h-[min(40svh,24rem)] min-h-(--composer-min) py-[15px] pr-1 pl-4 text-prose leading-[22px] placeholder:text-muted-foreground md:text-prose"
      />
      <InputGroupAddon align="inline-end" className="self-end gap-1.5 pr-3 pb-3 pl-1">
        <InputGroupButton
          size="round"
          variant={canSend ? 'default' : 'secondary'}
          aria-label="Send"
          disabled={!canSend}
          onClick={send}
        >
          <ArrowUpIcon strokeWidth={2.25} />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}

function ProjectMenu({ project }: { project: Project | null }) {
  const projects = useProjectsStore((s) => s.projects)
  const [error, setError] = useState<string | null>(null)
  const choose = (projectPath: string) => useViewStore.setState({ projectPath })
  const open = async () => {
    setError(null)
    try {
      const path = await addProjectFromDialog()
      if (path) choose(path)
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="quiet"
              size="compact"
              aria-label="Project"
              title={project?.path}
              className="min-w-0 shrink gap-1 px-2"
            />
          }
        >
          <FolderIcon data-icon="inline-start" />
          <span className="truncate text-foreground">{project?.name ?? 'Choose a project'}</span>
          <ChevronDownIcon data-icon="inline-end" className="size-3 opacity-70" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-72">
          {projects.length > 0 && (
            <>
              <DropdownMenuGroup>
                <DropdownMenuLabel>Project</DropdownMenuLabel>
                <div className="relative -mx-1 max-h-72 scroll-fade-y overflow-y-auto overscroll-contain px-1">
                  <DropdownMenuRadioGroup
                    value={project?.path}
                    onValueChange={(value) => choose(String(value))}
                  >
                    {projects.map((p) => (
                      <DropdownMenuRadioItem
                        key={p.path}
                        value={p.path}
                        disabled={p.missing}
                        closeOnClick
                        className="items-start"
                      >
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate">{p.name}</span>
                          <span className="truncate font-mono text-[11.5px] text-muted-foreground">
                            {p.missing ? 'Missing' : p.path}
                          </span>
                        </span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </div>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onClick={() => void open()}>Open project…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {error && (
        <span className="min-w-0 truncate px-1.5 text-xs text-destructive" title={error}>
          {error}
        </span>
      )}
    </>
  )
}

function AgentMenu({ agentId }: { agentId: AgentId | null }) {
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
            aria-label="Agent"
            className="min-w-0 shrink gap-1.5 px-2"
          />
        }
      >
        {agentId && <AgentMark agent={agentId} size={13} />}
        <span className="truncate text-foreground">
          {agentId ? agentName(agentId) : 'Choose an agent'}
        </span>
        <ChevronDownIcon data-icon="inline-end" className="-ml-0.5 size-3 opacity-70" />
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" sideOffset={6} className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Agent</DropdownMenuLabel>
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
                  <span className="text-xs text-muted-foreground">Not installed</span>
                )}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
