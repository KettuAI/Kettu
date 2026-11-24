import { useEffect, useMemo, useState } from 'react'
import {
  mentionWord,
  PLUGIN_REF_LIMITS,
  type PluginMentionDecl,
  type PluginMentionItem,
  type PluginRefSource,
} from '@shared/plugin-refs'
import type { PluginViewError } from '@shared/plugin-views'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { usePluginRefs } from '@renderer/stores/plugin-refs'

// How long the typing rests before the plugins are asked, so a word is not searched letter by letter.
const TYPING_MS = 180

/** One mention source of a plugin, with what it found for the query last asked. */
export interface PluginMentionGroup {
  source: PluginRefSource
  decl: PluginMentionDecl
  items: PluginMentionItem[]
  truncated: boolean
  /** Asked, and not answered yet; the items of the query before stay shown meanwhile. */
  searching: boolean
  error: PluginViewError | null
}

/** One item in the list, with the word it is written as after the `@`. */
export interface PluginRow {
  plugin: true
  /** Where its group is in `groups`. */
  group: number
  item: PluginMentionItem
  word: string
}

export interface PluginMentions {
  groups: PluginMentionGroup[]
  /** The items of every group in order, which the keyboard moves through after the files. */
  rows: PluginRow[]
  /** Where each group's first row is in `rows`. */
  starts: number[]
  /** Something to show: an item, or a source that failed. */
  visible: boolean
}

interface Answer {
  /** The query it answers. */
  query: string
  items: PluginMentionItem[]
  truncated: boolean
  error: PluginViewError | null
}

const NONE: PluginMentions = { groups: [], rows: [], starts: [], visible: false }

/**
 * What the plugins that offer items to mention find for the query, each source on its own, so one
 * that is slow or fails never holds the files or another plugin back. Nothing is asked while no
 * mention is typed, and the answers are dropped when the list closes.
 */
export function usePluginMentions(hostId: string | null, query: string | null): PluginMentions {
  const sources = usePluginRefs(hostId)
  const pairs = useMemo(
    () =>
      sources.flatMap((source) =>
        source.mentions.map((decl) => ({ source, decl, key: `${source.pluginId}\n${decl.id}` })),
      ),
    [sources],
  )
  const wanted = query !== null && pairs.length > 0
  const [typed, setTyped] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, Answer>>({})
  // Closing the list drops what it found.
  if (!wanted && typed !== null) setTyped(null)
  if (!wanted && Object.keys(answers).length > 0) setAnswers({})

  useEffect(() => {
    if (!wanted) return
    const timer = setTimeout(() => setTyped(query), query === '' ? 0 : TYPING_MS)
    return () => clearTimeout(timer)
  }, [wanted, query])

  useEffect(() => {
    if (typed === null) return
    let current = true
    for (const { decl, source, key } of pairs) {
      hostAt(hostId, 'plugins.mentionSearch', {
        pluginId: source.pluginId,
        source: decl.id,
        query: typed.slice(0, PLUGIN_REF_LIMITS.query),
      })
        .then(
          (result): Answer =>
            result.ok
              ? {
                  query: typed,
                  items: result.items,
                  truncated: result.truncated === true,
                  error: null,
                }
              : { query: typed, items: [], truncated: false, error: result.error },
          (error: unknown): Answer => ({
            query: typed,
            items: [],
            truncated: false,
            error: { code: 'request_failed', detail: errorMessage(error) },
          }),
        )
        .then((answer) => {
          if (current) setAnswers((now) => ({ ...now, [key]: answer }))
        })
    }
    return () => {
      current = false
    }
  }, [typed, hostId, pairs])

  return useMemo(() => {
    if (!wanted) return NONE
    const groups = pairs.map(({ source, decl, key }): PluginMentionGroup => {
      const answer = answers[key]
      return {
        source,
        decl,
        items: answer?.items ?? [],
        truncated: answer?.truncated ?? false,
        // The items shown are those of the query before until the one asked for answers.
        searching: answer === undefined || answer.query !== typed,
        error: answer?.error ?? null,
      }
    })
    const rows: PluginRow[] = []
    const starts = groups.map((group, index) => {
      const start = rows.length
      for (const item of group.items) {
        rows.push({ plugin: true, group: index, item, word: mentionWord(item) })
      }
      return start
    })
    const visible = groups.some((group) => group.items.length > 0 || group.error !== null)
    return { groups, rows, starts, visible }
  }, [wanted, pairs, answers, typed])
}
