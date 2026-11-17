// Emoji shortcodes in a reply, such as `:tada:`, drawn as emoji.

import remarkEmoji from 'remark-emoji'

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
}

// Their text is a link's own words, a path or code, which stays as written.
const SKIP = new Set([
  'link',
  'linkReference',
  'inlineCode',
  'code',
  'html',
  'definition',
  'inlineMath',
  'math',
])
// A shortcode stuck to a word, as in `a:b:c` or `x:tada:y`, is not one.
const GLUED = /\w:[\w+-]+:|:[\w+-]+:\w/

/** Draws a reply's shortcodes as emoji, outside links and code. */
export function emojiShortcodes() {
  // The plugin looks at the tree it is given, so each text node is handed over in a root of its own.
  const replace = (remarkEmoji as unknown as () => (tree: MdNode) => void)()
  const visit = (node: MdNode): void => {
    if (!node.children || SKIP.has(node.type)) return
    node.children = node.children.flatMap((child) => {
      if (child.type !== 'text') {
        visit(child)
        return [child]
      }
      if (!child.value || GLUED.test(child.value)) return [child]
      const holder: MdNode = { type: 'paragraph', children: [child] }
      replace(holder)
      return holder.children!
    })
  }
  return visit
}
