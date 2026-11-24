// What a plugin's script answers for a mention source and for a link, checked and cut to the
// format's limits before any window or agent sees it. A shape that does not fit is refused with the
// path of the field; a field this Kettu does not know is dropped.

import { PLUGIN_REF_LIMITS as LIMITS } from '@shared/plugin-refs'
import type { PluginLinkCard, PluginMentionContent, PluginMentionItem } from '@shared/plugin-refs'
import type { PluginViewField } from '@shared/plugin-views'
import {
  bad,
  icon,
  optionalText,
  parseBadges,
  record,
  requiredText,
  set,
  type Raw,
} from './view-data'

/** The items a source found for a query: at most `items`, the rest dropped. */
export function parseMentionItems(value: unknown): {
  items: PluginMentionItem[]
  truncated: boolean
} {
  const o = record(value, 'The answer')
  if (!Array.isArray(o.items)) return bad('items', 'must be a list')
  const given = o.items.slice(0, LIMITS.items)
  const ids = new Set<string>()
  const items = given.map((raw: unknown, i): PluginMentionItem => {
    const path = `items[${i}]`
    const item: Raw = record(raw, path)
    const { id } = item
    if (typeof id !== 'string' || id === '' || id.length > LIMITS.itemId) {
      return bad(`${path}.id`, `must be text of 1 to ${LIMITS.itemId} characters`)
    }
    if (ids.has(id)) return bad(`${path}.id`, 'is used by another item')
    ids.add(id)
    const out: PluginMentionItem = {
      id,
      title: requiredText(item, 'title', path, LIMITS.itemTitle),
      ...icon(item),
    }
    set(out, 'subtitle', optionalText(item, 'subtitle', path, LIMITS.itemSubtitle))
    set(out, 'end', optionalText(item, 'end', path, LIMITS.itemEnd))
    // A word that is not a usable one is left out, and one is made from the id or the title.
    set(out, 'word', typeof item.word === 'string' ? item.word : undefined)
    return out
  })
  return { items, truncated: o.items.length > given.length }
}

/** What a mentioned item adds to a message: a text, cut at `content`, and a title. */
export function parseMentionContent(value: unknown): PluginMentionContent {
  const o = record(value, 'The answer')
  const text = optionalText(o, 'text', '', LIMITS.content)
  if (text === undefined || text.trim() === '') return bad('text', 'must be text')
  const content: PluginMentionContent = { text }
  const title = optionalText(o, 'title', '', LIMITS.contentTitle)?.trim()
  if (title) content.title = title
  return content
}

/** A link's card; badges and fields past their limits are dropped, since a card is read at a glance. */
export function parseLinkCard(value: unknown): PluginLinkCard {
  const o = record(value, 'The answer')
  const card: PluginLinkCard = { title: requiredText(o, 'title', '', LIMITS.cardTitle) }
  set(card, 'label', optionalText(o, 'label', '', LIMITS.cardLabel)?.trim() || undefined)
  set(card, 'subtitle', optionalText(o, 'subtitle', '', LIMITS.cardSubtitle))
  set(card, 'body', optionalText(o, 'body', '', LIMITS.cardBody))
  Object.assign(card, icon(o))
  if (o.badges !== undefined && o.badges !== null) {
    const given = Array.isArray(o.badges) ? o.badges.slice(0, LIMITS.cardBadges) : o.badges
    set(card, 'badges', parseBadges(given, 'badges'))
  }
  if (o.fields !== undefined && o.fields !== null) {
    if (!Array.isArray(o.fields)) return bad('fields', 'must be a list')
    card.fields = o.fields.slice(0, LIMITS.cardFields).map((item, i): PluginViewField => {
      const path = `fields[${i}]`
      const field = record(item, path)
      const out: PluginViewField = {
        label: requiredText(field, 'label', path, LIMITS.fieldLabel),
        value: optionalText(field, 'value', path, LIMITS.fieldValue) ?? '',
      }
      if (field.mono === true) out.mono = true
      return out
    })
  }
  return card
}
