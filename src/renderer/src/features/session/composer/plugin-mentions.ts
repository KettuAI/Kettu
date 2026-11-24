// The items from plugins that a composer's text mentions: which item each word after an `@` names.
// They live with the draft, in memory and in its saved copy, and go with the message as refs.

import { create } from 'zustand'
import { PLUGIN_REF_LIMITS, type PluginMentionRef } from '@shared/plugin-refs'
import type { UserContent } from '@shared/thread'
import { readDraftMentions, writeDraftMentions } from './drafts'

interface MentionsStore {
  /** By draft: a session's id, or New session's draft key. */
  byDraft: Record<string, readonly PluginMentionRef[]>
}

const useMentionsStore = create<MentionsStore>()(() => ({ byDraft: {} }))

const NONE: readonly PluginMentionRef[] = []

export function draftMentions(draft: string): readonly PluginMentionRef[] {
  return useMentionsStore.getState().byDraft[draft] ?? NONE
}

/** A composer's mentions, for a component; the same empty list when it has none. */
export function useDraftMentions(draft: string): readonly PluginMentionRef[] {
  return useMentionsStore((s) => s.byDraft[draft] ?? NONE)
}

export function setDraftMentions(draft: string, items: readonly PluginMentionRef[]): void {
  useMentionsStore.setState((s) => {
    const byDraft = { ...s.byDraft }
    if (items.length > 0) byDraft[draft] = items
    else delete byDraft[draft]
    return { byDraft }
  })
  writeDraftMentions(draft, [...items])
}

/** The items of plugins a message mentioned, as its content carries them. */
export function contentMentions(content: readonly UserContent[]): PluginMentionRef[] {
  return content.flatMap((item) => {
    if (item.type !== 'ref' || item.ref.kind !== 'plugin') return []
    const { pluginId, source, item: id, word, name } = item.ref
    return [{ pluginId, source, item: id, word, name }]
  })
}

/** Takes up the mentions a draft was saved with, once, as its composer opens. */
export function hydrateDraftMentions(draft: string): void {
  if (draft in useMentionsStore.getState().byDraft) return
  const saved = readDraftMentions(draft)
  if (saved.length > 0) {
    useMentionsStore.setState((s) => ({ byDraft: { ...s.byDraft, [draft]: saved } }))
  }
}

/** Puts mentions back after a send that failed; one the draft names by the same word is kept. */
export function restoreDraftMentions(draft: string, items: readonly PluginMentionRef[]): void {
  const now = draftMentions(draft)
  const words = new Set(now.map((item) => item.word))
  setDraftMentions(draft, [...items.filter((item) => !words.has(item.word)), ...now])
}

/**
 * Records that the user chose an item and returns the word it is written as. An item that is
 * mentioned already keeps its word. A word another item has gets a number. Null when the message
 * already holds as many as it may; mentions whose words are no longer in `text` do not count.
 */
export function addDraftMention(
  draft: string,
  text: string,
  ref: Omit<PluginMentionRef, 'word'>,
  wanted: string,
): string | null {
  const now = draftMentions(draft).filter(
    (item) => text.includes(`@${item.word}`) || text.includes(`\uFF20${item.word}`),
  )
  const same = now.find(
    (item) =>
      item.pluginId === ref.pluginId && item.source === ref.source && item.item === ref.item,
  )
  if (same) return same.word
  if (now.length >= PLUGIN_REF_LIMITS.perMessage) return null
  const words = new Set(now.map((item) => item.word))
  let word = wanted
  for (let n = 2; words.has(word); n++) word = `${wanted}-${n}`
  setDraftMentions(draft, [...now, { ...ref, word }])
  return word
}
