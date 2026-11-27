import { memo, useEffect, useRef, useState } from 'react'
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle02Icon,
  PlugSocketIcon,
  Tick02Icon,
  Undo02Icon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { Trans, useTranslation } from 'react-i18next'
import { restoreStands } from '@shared/mcp-switch'
import type { McpSwitchTarget } from '@shared/mcp-switch'
import type {
  McpAddServer,
  McpChangeEntry as Entry,
  McpCheckSummary,
  McpSwitchItem,
} from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import { PermissionRequest } from '@renderer/components/affect/permission-request'
import { Button } from '@renderer/components/ui/button'
import { toast } from '@renderer/components/ui/toast'
import { emitAppEvent } from '@renderer/app/events'
import { itemKey } from '@renderer/features/marketplace/model'
import { requestSignIn } from '@renderer/features/marketplace/sign-in-request'
import { basename } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { onHost } from '@renderer/lib/host-paths'
import { isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { hostScope, LOCAL_SCOPE } from '@renderer/stores/host-scope'
import { findProjectForPath, useProjectsStore } from '@renderer/stores/projects'
import { openMarketplace } from '@renderer/stores/view'
import { useEntry, useEntryAnimation } from '../use-thread'
import { revealWaiting } from './helpers'
import { useSessionHost } from './session-host'
import { useAnswering } from './use-answering'

/**
 * An agent's addition of an MCP server to Kettu's library, or its switches of library servers:
 * the card while it waits for the user, shaped and answered like a settings change, then one
 * muted line of what came of it.
 */
export const McpChangeEntry = memo(function McpChangeEntry({
  sessionId,
  entryId,
  agentName: asker,
}: {
  sessionId: string
  entryId: string
  agentName: string
}) {
  const entry = useEntry(sessionId, entryId, 'mcp_change')
  const animation = useEntryAnimation(sessionId, entryId)
  if (!entry) return null
  return entry.outcome === null ? (
    <McpCard sessionId={sessionId} entry={entry} agentName={asker} className={animation} />
  ) : entry.action === 'add' ? (
    <AddLine sessionId={sessionId} entry={entry} className={animation} />
  ) : (
    <SwitchLine sessionId={sessionId} entry={entry} className={animation} />
  )
})

/** The server's page in the Marketplace, on the session's host. */
function openServer(hostId: string | null, serverId: string): void {
  openMarketplace({ item: itemKey({ kind: 'mcp', id: serverId }), tab: 'mcp', hostId })
}

/** A project's name in the sidebar, from its path on the session's host. */
function useProjectName(hostId: string | null): (path: string) => string {
  const projects = useProjectsStore((s) => s.projects)
  return (path) => findProjectForPath(projects, onHost(hostId, path))?.name ?? basename(path)
}

/** What a switch is for, in the window's language. */
function useTargetWords(hostId: string | null) {
  const { t } = useTranslation('session')
  const projectName = useProjectName(hostId)
  return (target: McpSwitchTarget): string => {
    switch (target.kind) {
      case 'server':
        return t('mcpChange.whole')
      case 'agent':
        return t('mcpChange.forAgent', { agent: agentName(target.agentId, hostId) })
      case 'project':
        return t('mcpChange.inProject', { project: projectName(target.path) })
      case 'tool':
        return t('mcpChange.tool', { tool: target.tool })
    }
  }
}

function AddRows({ server, hostId }: { server: McpAddServer; hostId: string | null }) {
  const { t } = useTranslation('session')
  const remote = server.type === 'http'
  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: t('mcpChange.name'), value: server.title },
    {
      label: remote ? t('mcpChange.address') : t('mcpChange.command'),
      value: server.target,
      mono: true,
    },
    {
      label: t('mcpChange.runs'),
      value: remote
        ? t(`mcpChange.runsRemote_${server.transport ?? 'streamable-http'}`)
        : t('mcpChange.runsCommand'),
    },
  ]
  if (remote) {
    rows.push({
      label: t('mcpChange.signIn'),
      value: server.oauth
        ? t('mcpChange.signInOAuth')
        : server.values.length > 0
          ? t('mcpChange.signInHeaders')
          : server.oauth === null
            ? t('mcpChange.signInUnknown')
            : t('mcpChange.signInNone'),
    })
  }
  for (const value of server.values) {
    rows.push({
      label: value.name,
      value:
        value.state === 'reference'
          ? value.reference
          : value.state === 'unset'
            ? t('mcpChange.unset')
            : t('mcpChange.fixed'),
      mono: value.state === 'reference',
    })
  }
  rows.push({
    label: t('mcpChange.agents'),
    value:
      server.agents === 'all'
        ? t('mcpChange.everyAgent')
        : server.agents.map((id) => agentName(id, hostId)).join(', '),
  })
  const unset = server.values.some((value) => value.state === 'unset')
  return (
    <div className="ks-settings-rows ks-routine-rows" data-selectable="">
      <ul aria-label={t('mcpChange.rows')}>
        {rows.map((row) => (
          <li key={row.label} className="ks-settings-rows__row">
            <span className="ks-routine-rows__label">{row.label}</span>
            <span
              className={cn(
                'ks-settings-rows__value ks-routine-rows__value',
                row.mono && 'ks-mcp-rows__mono',
              )}
            >
              {row.value}
            </span>
          </li>
        ))}
      </ul>
      {!remote && <p className="ks-routine-rows__note">{t('mcpChange.yourPermissions')}</p>}
      {unset && <p className="ks-routine-rows__note">{t('mcpChange.unsetNote')}</p>}
    </div>
  )
}

function SwitchRows({ items, hostId }: { items: McpSwitchItem[]; hostId: string | null }) {
  const { t } = useTranslation('session')
  const words = useTargetWords(hostId)
  const state = (on: boolean) => (on ? t('mcpChange.on') : t('mcpChange.off'))
  return (
    <ul className="ks-settings-rows" aria-label={t('mcpChange.rows')} data-selectable="">
      {items.map((item, index) => (
        <li key={index}>
          <div className="ks-settings-rows__row">
            <span className="ks-settings-rows__name">
              <span className="ks-settings-rows__place">{item.title} › </span>
              {words(item.target)}
            </span>
            <span className="ks-settings-rows__value">
              <del>{state(item.from)}</del>
              <span aria-hidden className="ks-settings-rows__arrow">
                →
              </span>
              <ins>{state(item.to)}</ins>
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

/**
 * The card: the MCP server mark and what the agent wants, who asks on which computer, the rows on
 * a sunk block, Open server page at the left for a switch, and Don't and the action at the right.
 */
function McpCard({
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
      host('market.answerMcpChange', { sessionId, entryId: entry.id, decision }),
    )
    if (sent && decision === 'confirm') setDoing(true)
    if (sent && focused) emitAppEvent({ kind: 'focus-composer' })
  }

  const add = entry.action === 'add'
  const on = entry.items.every((item) => item.to)
  const kind = add ? 'add' : on ? 'on' : 'off'
  const where = name !== null ? 'Other' : isMac ? 'Mac' : 'Computer'
  const who = t(`mcpChange.who${where}_${add ? 'add' : 'switch'}`, {
    agent: asker,
    ...(name !== null ? { computer: name } : {}),
  })
  const title = t(`mcpChange.title_${kind}`)
  const button = add ? t('mcpChange.add') : on ? t('mcpChange.turnOn') : t('mcpChange.turnOff')
  const first = entry.items[0]

  return (
    <div ref={card} data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <PermissionRequest
        className="ks-permission ks-settings-card ks-routine-card"
        agent={{ name: asker, avatar: <Icon icon={PlugSocketIcon} size={16} /> }}
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
          !add &&
          first && (
            <button
              type="button"
              className="ui-prc__btn ks-permission__other ks-settings-card__view"
              onClick={() => openServer(hostId, first.serverId)}
            >
              {t('mcpChange.view')}
              <Icon icon={ArrowRight01Icon} size={12} />
            </button>
          )
        }
        labels={{
          title: () => <b>{title}</b>,
          risk: () => t('status.needsApproval'),
          allow: () => (
            <>
              <Icon icon={Tick02Icon} size={14} />
              {doing ? t('mcpChange.doing') : button}
            </>
          ),
          deny: (
            <>
              <Icon icon={Cancel01Icon} size={14} />
              {t('mcpChange.decline')}
            </>
          ),
        }}
      >
        {entry.server ? (
          <AddRows server={entry.server} hostId={hostId} />
        ) : (
          <SwitchRows items={entry.items} hostId={hostId} />
        )}
      </PermissionRequest>
      {error && (
        <p role="alert" className="ks-card-error">
          {error}
        </p>
      )}
    </div>
  )
}

/** The notes after a line: the computer, the device that answered, or why it was not done. */
function useNotes(entry: Entry, computer: string | null): string[] {
  const { t } = useTranslation('session')
  const outcome = entry.outcome!
  return [
    computer,
    entry.device ? t('settingsChange.answeredOn', { device: entry.device.name }) : null,
    outcome.kind === 'expired' ? t('settingsChange.noAnswer') : null,
    outcome.kind === 'failed' ? outcome.message : null,
  ].filter((note): note is string => !!note)
}

/** What the check after an addition found, in the window's language; checking until it ends. */
function useCheckWords(): (check: McpCheckSummary | undefined) => string {
  const { t } = useTranslation('session')
  return (check) => {
    if (check === undefined) return t('mcpChange.checking')
    switch (check.state) {
      case 'connected':
        return t('mcpChange.connected', { count: check.tools })
      case 'needs-sign-in':
        return t('mcpChange.needsSignIn')
      case 'project-only':
        return t('mcpChange.projectOnly')
      case 'error':
        return t('mcpChange.checkFailed', {
          reason: t(`mcpChange.reason.${check.reason}`, { defaultValue: check.reason }),
        })
    }
  }
}

/** What came of an addition: added with what its check found, or not, and Open while it is added. */
function AddLine({
  sessionId,
  entry,
  className,
}: {
  sessionId: string
  entry: Entry
  className?: string
}) {
  const { t } = useTranslation('session')
  const { hostId, name } = useSessionHost(sessionId)
  const server = entry.server!
  const outcome = entry.outcome!
  const done = outcome.kind === 'done'
  const notes = useNotes(entry, name)
  const checkWords = useCheckWords()
  const check = done ? outcome.check : undefined
  const checkNote = done ? checkWords(check) : null

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
            i18nKey={done ? 'mcpChange.added' : 'mcpChange.notAdded'}
            values={{ name: server.title }}
            components={{ b: <b /> }}
          />
        </span>
        {checkNote && <span className="ks-settings-line__note">· {checkNote}</span>}
        {notes.map((note) => (
          <span key={note} className="ks-settings-line__note">
            · {note}
          </span>
        ))}
        {done && check?.state === 'needs-sign-in' && (
          <Button
            variant="quiet"
            size="xs"
            className="ks-settings-line__undo"
            onClick={() => {
              requestSignIn(hostId, server.serverId)
              openServer(hostId, server.serverId)
            }}
          >
            {t('mcpChange.signInButton')}
          </Button>
        )}
        {done && (
          <Button
            variant="quiet"
            size="xs"
            className="ks-settings-line__undo"
            onClick={() => openServer(hostId, server.serverId)}
          >
            {t('mcpChange.open')}
            <Icon icon={ArrowRight01Icon} size={12} />
          </Button>
        )}
      </div>
    </div>
  )
}

/** Whether the switches still stand where this client can tell, as the host's Undo checks. */
function useStands(hostId: string | null, entry: Entry, live: boolean): boolean {
  const scope = live ? (hostId === null ? LOCAL_SCOPE : hostScope(hostId)) : LOCAL_SCOPE
  return scope.useSettingsStore((s) => {
    if (!live || !s.loaded || entry.restore === null) return true
    return entry.restore.every((restore) => {
      const server = s.settings.marketplace.mcp.find((item) => item.id === restore.serverId)
      return server !== undefined && restoreStands(server, restore)
    })
  })
}

/** What came of switches, as one muted line: made, undone or not made, and Undo while they stand. */
function SwitchLine({
  sessionId,
  entry,
  className,
}: {
  sessionId: string
  entry: Entry
  className?: string
}) {
  const { t } = useTranslation('session')
  const { hostId, name } = useSessionHost(sessionId)
  const words = useTargetWords(hostId)
  const projectName = useProjectName(hostId)
  const [open, setOpen] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const outcome = entry.outcome!
  const done = outcome.kind === 'done'
  const undone = done && outcome.undone === true
  const live = done && !undone && outcome.stale !== true && entry.restore !== null
  const stands = useStands(hostId, entry, live)
  const notes = useNotes(entry, name)
  const items = entry.items
  const one = items.length === 1 ? items[0]! : null
  const state = (on: boolean) => (on ? t('mcpChange.on') : t('mcpChange.off'))
  const what = (item: McpSwitchItem) =>
    t('mcpChange.row', {
      server: item.title,
      target: words(item.target),
      from: state(item.from),
      to: state(item.to),
    })
  const target = one?.target
  const label = one
    ? undone
      ? t('mcpChange.undone', { what: what(one) })
      : done
        ? null
        : t('mcpChange.notSwitched', { what: what(one) })
    : t(
        undone
          ? 'mcpChange.undoneMany'
          : done
            ? 'mcpChange.switchedMany'
            : 'mcpChange.notSwitchedMany',
        { count: items.length },
      )

  const undo = async (): Promise<void> => {
    setUndoing(true)
    try {
      await host('market.undoMcpChange', { sessionId, entryId: entry.id })
    } catch (error) {
      toast(errorMessage(error))
    } finally {
      setUndoing(false)
    }
  }

  return (
    <div data-entry-id={entry.id} className={cn('min-w-0', className)}>
      <div className="ks-settings-line">
        <HugeiconsIcon
          icon={undone ? Undo02Icon : done ? CheckmarkCircle02Icon : CancelCircleIcon}
          strokeWidth={1.9}
          aria-hidden
          className={cn('size-3.5 shrink-0', done && !undone && 'ks-settings-line__done')}
        />
        <span className="min-w-0 truncate">
          {label ?? (
            <Trans
              t={t}
              i18nKey={`mcpChange.switched_${target!.kind}_${one!.to ? 'on' : 'off'}`}
              values={{
                name: one!.title,
                agent: target!.kind === 'agent' ? agentName(target!.agentId, hostId) : '',
                project: target!.kind === 'project' ? projectName(target!.path) : '',
                tool: target!.kind === 'tool' ? target!.tool : '',
              }}
              components={{ b: <b /> }}
            />
          )}
        </span>
        {!one && (
          <button
            type="button"
            className="ks-settings-line__toggle"
            aria-expanded={open}
            aria-label={t('mcpChange.showRows')}
            onClick={() => setOpen((o) => !o)}
          >
            <Icon icon={ArrowDown01Icon} size={12} />
          </button>
        )}
        {notes.map((note) => (
          <span key={note} className="ks-settings-line__note">
            · {note}
          </span>
        ))}
        {live && stands && (
          <Button
            variant="quiet"
            size="xs"
            disabled={undoing}
            className="ks-settings-line__undo"
            aria-label={t('mcpChange.undoLabel', { name: one ? one.title : items[0]!.title })}
            onClick={() => void undo()}
          >
            <Icon icon={Undo02Icon} size={12} />
            {t('mcpChange.undo')}
          </Button>
        )}
      </div>
      {!one && open && (
        <ul className="ks-settings-line__rows" data-selectable="">
          {items.map((item, index) => (
            <li key={index}>
              {undone ? what({ ...item, from: item.to, to: item.from }) : what(item)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
