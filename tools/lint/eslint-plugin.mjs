// @ts-check
// Local ESLint plugin: keeps color literals out of the renderer's strings and templates.
import { colorLiteralMessage, findColorLiterals } from './color-literals.mjs'

/** @type {import('eslint').Rule.RuleModule} */
const noColorLiterals = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow color literals outside the token file' },
    schema: [],
    messages: { literal: '{{ message }}' },
  },
  create(context) {
    const { sourceCode } = context

    /**
     * @param {import('eslint').Rule.Node} node
     * @param {string} text the cooked or raw text that was scanned
     * @param {number} offset where `text` starts in the source, or -1 when it cannot be mapped
     */
    function check(node, text, offset) {
      for (const { index, match } of findColorLiterals(text)) {
        const loc = offset < 0 ? node.loc : sourceCode.getLocFromIndex(offset + index)
        context.report({
          node,
          loc: loc ?? node.loc ?? undefined,
          messageId: 'literal',
          data: { message: colorLiteralMessage(match) },
        })
      }
    }

    return {
      Literal(node) {
        if (typeof node.value !== 'string') return
        // The offset only maps when the source holds the value as written, without escapes.
        const raw = node.raw ?? ''
        const plain = raw.length === node.value.length + 2
        check(node, node.value, plain && node.range ? node.range[0] + 1 : -1)
      },
      TemplateElement(node) {
        check(node, node.value.raw, node.range ? node.range[0] + 1 : -1)
      },
    }
  },
}

export const rules = { 'no-color-literals': noColorLiterals }

export default { meta: { name: 'kettu' }, rules }
