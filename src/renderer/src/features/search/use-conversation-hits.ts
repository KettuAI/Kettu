import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ConversationHit, SearchIndexing } from '@shared/agent-host'
import { longEnough, queryWords } from '@shared/search-fold'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { awayHosts, otherHosts, useHostsStore } from '@renderer/stores/hosts'
import { windowHosts } from '@renderer/stores/window-host'

/** How long the query rests before the hosts are asked. */
const DEBOUNCE_MS = 120
/** An answer later than this is slow: the results shown meanwhile stay, or rows stand in for them. */
const SLOW_MS = 150
/** A host that has not answered by now is named, so a slow one is known to be what is awaited. */
const WAITING_MS = 1_500

export interface ConversationHits {
  /** The latest answers; those of the query before stay until a host answers the new one. */
  hits: ConversationHit[]
  /** The query is too short to ask for. */
  short: boolean
  /** Some host has not answered the query yet. */
  searching: boolean
  /** It has taken longer than a quick answer does. */
  slow: boolean
  /** The hosts still awaited once it has taken long, null being this computer. */
  waiting: (string | null)[]
  /** How far the hosts' indexes are, summed, while any is being built; null when none is. */
  indexing: SearchIndexing | null
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
  building: Record<string, SearchIndexing>
}

const NO_ANSWERS: Answers = { key: '', byHost: {}, failed: {}, building: {} }

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
  // The request a slow or long wait was timed out for.
  const [slowFor, setSlowFor] = useState<string | null>(null)
  const [waitingFor, setWaitingFor] = useState<string | null>(null)

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
      // The first answer to a request replaces what the one before had shown.
      if (live)
        setAnswers((current) => update(current.key === key ? current : { ...NO_ANSWERS, key }))
    }
    for (const hostId of plan.hosts) {
      const from = hostId ?? ''
      hostAt(hostId, 'sessions.search', { query: text }).then(
        ({ hits, indexing }) =>
          answer((current) => ({
            ...current,
            byHost: { ...current.byHost, [from]: hits },
            building: indexing ? { ...current.building, [from]: indexing } : current.building,
          })),
        (error: unknown) =>
          answer((current) => ({
            ...current,
            failed: { ...current.failed, [from]: errorMessage(error) },
          })),
      )
    }
    const slow = setTimeout(() => setSlowFor(key), SLOW_MS)
    const waiting = setTimeout(() => setWaitingFor(key), WAITING_MS)
    return () => {
      live = false
      clearTimeout(slow)
      clearTimeout(waiting)
    }
  }, [key, plan, text])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])
  const fresh = answers.key === key ? answers : NO_ANSWERS
  const answered = new Set([...Object.keys(fresh.byHost), ...Object.keys(fresh.failed)])
  const searching = ready && (plan === null || answered.size < plan.hosts.length)
  const hits = useMemo(() => Object.values(answers.byHost).flat(), [answers.byHost])
  const building = Object.values(answers.building)
  return {
    // Kept while the next query waits to be asked or answered, not once it is too short.
    hits: ready ? hits : [],
    short: query.trim() !== '' && !ready,
    searching,
    slow: searching && slowFor === key,
    waiting:
      searching && key !== null && waitingFor === key
        ? (plan?.hosts ?? []).filter((hostId) => !answered.has(hostId ?? ''))
        : [],
    indexing:
      ready && building.length > 0
        ? {
            done: building.reduce((sum, item) => sum + item.done, 0),
            total: building.reduce((sum, item) => sum + item.total, 0),
          }
        : null,
    failures: key === null ? [] : Object.values(fresh.failed),
    away: plan?.away ?? [],
    retry,
  }
}
