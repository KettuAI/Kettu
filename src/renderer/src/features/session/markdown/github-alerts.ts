// GitHub alerts: a quote whose first line is `[!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`
// or `[!CAUTION]`.

interface HastNode {
  type: string
  tagName?: string
  value?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

export const ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const
export type AlertKind = (typeof ALERT_KINDS)[number]

// The marker alone on its line: followed by a line break, or by nothing.
const MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i

export function alertKind(value: unknown): AlertKind | null {
  return ALERT_KINDS.find((kind) => kind === value) ?? null
}

/** The quote's first paragraph, which holds the marker, or null. */
function firstParagraph(quote: HastNode): HastNode | null {
  for (const child of quote.children ?? []) {
    if (child.type === 'text' && !child.value?.trim()) continue
    return child.type === 'element' && child.tagName === 'p' ? child : null
  }
  return null
}

/**
 * Marks each alert's quote with `dataAlert` and takes its marker line out. It runs after the
 * sanitizer, which would drop the attribute, and only the quote element carries it, so a reply's
 * own HTML cannot set it.
 */
export function githubAlerts() {
  const visit = (node: HastNode): void => {
    if (node.type === 'element' && node.tagName === 'blockquote') {
      const paragraph = firstParagraph(node)
      const first = paragraph?.children?.[0]
      const marker = first?.type === 'text' && first.value ? MARKER.exec(first.value) : null
      if (paragraph && first && marker) {
        const kind = marker[1]!.toLowerCase()
        node.properties = { ...node.properties, dataAlert: kind }
        const children = paragraph.children!
        first.value = first.value!.slice(marker[0].length)
        // With line breaks kept, the marker's line ends in a `<br>` and the text after it.
        if (first.value === '' && children[1]?.type === 'element' && children[1].tagName === 'br') {
          children.splice(1, 1)
          const next = children[1]
          if (next?.type === 'text') next.value = next.value!.replace(/^\n/, '')
        }
        if (first.value === '') children.shift()
        if (children.length === 0) node.children = node.children!.filter((c) => c !== paragraph)
      }
    }
    node.children?.forEach(visit)
  }
  return visit
}
