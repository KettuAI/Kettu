import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConversationHit } from '@shared/agent-host'
import { longEnough, queryWords } from '@shared/search-fold'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { awayHosts, otherHosts, useHostsStore } from '@renderer/stores/hosts'
import { windowHosts } from '@renderer/stores/window-host'

/** How long the query rests before the hosts are asked. */
const DEBOUNCE_MS = 200

export interface ConversationHits {
  hits: ConversationHit[]
  /** The query is too short to ask for. */
  short: boolean
  /** Some host has not answered yet. */
  searching: boolean
  /** Why the hosts that failed could not answer; empty when none did. */
  failures: string[]
  /** The names of the hosts that were offline, so not asked. */
  away: string[]
  retry: () => void
}

interface Answers {
  /** The request they answer. */
  key: string
  byHost: Record<string, ConversationHit[]>
  failed: Record<string, string>
}

const NO_ANSWERS: Answers = { key: '', byHost: {}, failed: {} }

/** The hosts the window shows that can be asked now, and the names of those that are offline. */
function planHosts(): { hosts: (string | null)[]; away: string[] } {
  const offline = new Set(awayHosts())
  const names = new Map(otherHosts(useHostsStore.getState()).map((host) => [host.id, host.name]))
  const shown = windowHosts()
  return {
    hosts: shown.filter((hostId) => hostId === null || !offline.has(hostId)),
    away: shown.flatMap((hostId) =>
      hostId !== null && offline.has(hostId) ? [names.get(hostId) ?? hostId] : [],
    ),
  }
}

/**
 * What was said in the sessions of the hosts the window shows, found by each host as the query
 * rests. A host's answer shows as it comes, and one that comes after the query changed is dropped.
 */
export function useConversationHits(query: string): ConversationHits {
  const words = useMemo(() => queryWords(query.trim()), [query])
  const ready = longEnough(words)
  const text = words.join(' ')
  const [rested, setRested] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [answers, setAnswers] = useState<Answers>(NO_ANSWERS)

  useEffect(() => {
    if (!ready) return
    const timer = setTimeout(() => setRested(text), DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [ready, text])

  const key = ready && rested === text ? `${attempt}:${text}` : null
  const plan = useMemo(() => (key === null ? null : planHosts()), [key])

  useEffect(() => {
    if (key === null || plan === null) return
    let live = true
    const answer = (update: (current: Answers) => Answers): void => {
      if (live)
        setAnswers((current) => update(current.key === key ? current : { ...NO_ANSWERS, key }))
    }
    for (const hostId of plan.hosts) {
      const from = hostId ?? ''
      hostAt(hostId, 'sessions.search', { query: text }).then(
        ({ hits }) =>
          answer((current) => ({ ...current, byHost: { ...current.byHost, [from]: hits } })),
        (error: unknown) =>
          answer((current) => ({
            ...current,
            failed: { ...current.failed, [from]: errorMessage(error) },
          })),
      )
    }
    return () => {
      live = false
    }
  }, [key, plan, text])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])
  const current = answers.key === key ? answers : NO_ANSWERS
  const hits = useMemo(() => Object.values(current.byHost).flat(), [current])
  const answered = Object.keys(current.byHost).length + Object.keys(current.failed).length
  return {
    hits: key === null ? [] : hits,
    short: query.trim() !== '' && !ready,
    searching: ready && (plan === null || answered < plan.hosts.length),
    failures: key === null ? [] : Object.values(current.failed),
    away: plan?.away ?? [],
    retry,
  }
}
