import { useState } from 'react'
import { Cancel01Icon, Tick02Icon, TickDouble02Icon } from '@hugeicons/core-free-icons'
import { Trans, useTranslation } from 'react-i18next'
import type { DeviceAccessDecision } from '@shared/device-agent'
import type { DeviceAccessEntry } from '@shared/thread'
import { Icon } from '@renderer/components/affect/app-shell'
import {
  PermissionRequest,
  type PermissionDecision,
} from '@renderer/components/affect/permission-request'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage, host } from '@renderer/lib/host'
import { answeredBy } from '@renderer/features/session/entries/helpers'
import { hostOfPath } from '@renderer/lib/host-paths'
import { useSeconds } from '@renderer/lib/use-now'
import { agentName } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useThreadsStore } from '@renderer/stores/threads'

/**
 * The device request of the turn that runs: the one that waits, else the latest one the user
 * allowed, which stays until the turn ends or the allow is taken back.
 */
function useRequest(sessionId: string): DeviceAccessEntry | null {
  const id = useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    if (!state) return null
    const status = state.session.status
    if (status !== 'running' && status !== 'awaiting_permission') return null
    let allowed: string | null = null
    for (let index = state.order.length - 1; index >= 0; index--) {
      const entry = state.byId[state.order[index]!]
      if (!entry || entry.kind === 'user') break
      if (entry.kind !== 'device_access') continue
      if (entry.decision === null) return entry.id
      const stands = entry.decision === 'always' || (entry.decision === 'session' && !entry.revoked)
      if (stands && !allowed) allowed = entry.id
    }
    return allowed
  })
  const entry = useThreadsStore((s) => (id ? s.replicas[sessionId]?.state?.byId[id] : undefined))
  return entry?.kind === 'device_access' ? entry : null
}

/** Where screenshots go, and the minutes and seconds left to answer, such as 1:52. */
function useReason(entry: DeviceAccessEntry): string {
  const { t } = useTranslation('devices')
  const now = useSeconds()
  if (entry.expiresAt === undefined) return t('request.where')
  const left = Math.max(0, Math.ceil((entry.expiresAt - now) / 1000))
  return t('request.whereUntil', {
    time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`,
  })
}

/**
 * An agent's request to use a device, under the pane's head: the thread's card in a compact form.
 * An answer here or in the thread answers both; an allow folds to one line with Revoke.
 */
export function DeviceRequest({ sessionId }: { sessionId: string }) {
  const entry = useRequest(sessionId)
  return entry ? <Request key={entry.id} sessionId={sessionId} entry={entry} /> : null
}

function Request({ sessionId, entry }: { sessionId: string; entry: DeviceAccessEntry }) {
  const { t } = useTranslation('devices')
  const { t: ts } = useTranslation('session')
  const reason = useReason(entry)
  const agentId = useSessionsStore((s) => s.byId[sessionId]?.agentId ?? null)
  const hostId = useSessionsStore((s) => hostOfPath(s.byId[sessionId]?.projectPath ?? ''))
  const [busy, setBusy] = useState(false)

  const send = (request: Promise<void>): void => {
    setBusy(true)
    request
      // An answer given elsewhere first is no failure here: the card takes it as its patch lands.
      .catch((error: unknown) => {
        if (answeredBy(error) === undefined) toast(errorMessage(error))
      })
      .finally(() => setBusy(false))
  }
  const answer = (decision: DeviceAccessDecision): void =>
    send(host('devices.answerAccess', { sessionId, entryId: entry.id, decision }))

  const always = entry.decision === 'always'
  const decision: PermissionDecision | null =
    entry.decision === null
      ? null
      : // An allow that holds for a while, so the line offers Revoke; an always allow does not.
        { allow: true, scope: always ? 'always' : 'timed', at: 0 }

  return (
    <div className="kp-device-ask">
      <PermissionRequest
        className="ks-permission"
        agent={{
          name: agentId ? agentName(agentId, hostId) : '',
          avatar: agentId ? <AgentMark agent={agentId} size={14} hostId={hostId} /> : undefined,
        }}
        action={t('request.action', { name: entry.deviceName })}
        risk="safe"
        reason={reason}
        scopes={['once']}
        decision={decision}
        onDecisionChange={(next) => {
          if (!next) {
            send(host('devices.revokeAccess', { sessionId, deviceId: entry.deviceId }))
          } else {
            answer(next.allow ? 'session' : 'deny')
          }
        }}
        revocable={!always}
        disabled={busy}
        trailingActions={
          <button
            type="button"
            className="ui-prc__btn ks-permission__always"
            disabled={busy}
            onClick={() => answer('always')}
          >
            <Icon icon={TickDouble02Icon} size={14} />
            {t('request.always')}
          </button>
        }
        labels={{
          title: (name, what) => (
            <Trans
              t={ts}
              i18nKey="permission.card.title"
              values={{ agent: name, action: what }}
              components={{ b: <b dir="auto" /> }}
            />
          ),
          allow: () => (
            <>
              <Icon icon={Tick02Icon} size={14} />
              {ts('deviceAccess.decision.session')}
            </>
          ),
          deny: (
            <>
              <Icon icon={Cancel01Icon} size={14} />
              {t('request.deny')}
            </>
          ),
          result: () => ({
            headline: always ? ts('deviceAccess.answer.always') : ts('deviceAccess.answer.session'),
            note: always ? entry.deviceName : t('request.untilTurnEnds'),
          }),
          revoke: t('request.revoke'),
        }}
      />
    </div>
  )
}
