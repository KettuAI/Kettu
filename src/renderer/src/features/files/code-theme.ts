// The Files pane editor's colors, from the Shiki theme code blocks and diffs take: a CodeMirror
// highlight style built from the theme's TextMate rules.

import { HighlightStyle, syntaxHighlighting, type TagStyle } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags, type Tag } from '@lezer/highlight'
import { normalizeTheme, type BundledTheme, type ThemeRegistrationResolved } from 'shiki'
import { bundledThemes } from 'shiki/themes'

// The scopes Shiki's grammars give the tokens each tag marks, the likeliest first. A tag left out,
// or one the theme styles none of the scopes of, takes its parent tag's rule: `operator` has none,
// since member access dots would take it while Shiki's grammars call them punctuation.
const SCOPES: [Tag | Tag[], string[]][] = [
  [tags.comment, ['comment']],
  [tags.string, ['string.quoted']],
  [tags.special(tags.string), ['string.template']],
  [tags.regexp, ['string.regexp']],
  [tags.escape, ['constant.character.escape']],
  [tags.number, ['constant.numeric']],
  [tags.bool, ['constant.language.boolean']],
  [tags.null, ['constant.language.null']],
  [tags.atom, ['constant.language', 'support.constant']],
  [tags.color, ['constant.other.color']],
  [tags.unit, ['keyword.other.unit']],
  [tags.keyword, ['keyword', 'storage.type', 'storage.modifier']],
  [tags.controlKeyword, ['keyword.control']],
  [tags.definitionKeyword, ['storage.type']],
  [tags.moduleKeyword, ['keyword.control.import']],
  [tags.operatorKeyword, ['keyword.operator.expression']],
  [tags.modifier, ['storage.modifier']],
  [tags.self, ['variable.language.this']],
  [tags.derefOperator, ['punctuation.accessor']],
  [tags.arithmeticOperator, ['keyword.operator.arithmetic']],
  [tags.logicOperator, ['keyword.operator.logical']],
  [tags.bitwiseOperator, ['keyword.operator.bitwise']],
  [tags.compareOperator, ['keyword.operator.comparison']],
  [tags.updateOperator, ['keyword.operator.increment']],
  [tags.definitionOperator, ['keyword.operator.assignment']],
  [tags.typeOperator, ['keyword.operator.type']],
  [tags.punctuation, ['punctuation']],
  [tags.angleBracket, ['punctuation.definition.tag']],
  [tags.function(tags.punctuation), ['storage.type.function.arrow']],
  [tags.variableName, ['variable.other.readwrite']],
  [[tags.function(tags.variableName), tags.function(tags.propertyName)], ['entity.name.function']],
  [tags.standard(tags.variableName), ['support.function', 'support.variable']],
  [tags.special(tags.variableName), ['variable']],
  [tags.propertyName, ['variable.other.property', 'support.type.property-name']],
  [tags.definition(tags.propertyName), ['meta.object-literal.key']],
  [tags.typeName, ['entity.name.type', 'support.type']],
  [tags.standard(tags.typeName), ['storage.type', 'support.type']],
  [
    tags.className,
    ['entity.other.attribute-name.class', 'entity.name.type.class', 'entity.name.class'],
  ],
  [tags.definition(tags.className), ['entity.name.type.class', 'entity.name.class']],
  [tags.constant(tags.className), ['entity.other.attribute-name.pseudo-class']],
  [tags.namespace, ['entity.name.namespace', 'entity.name.type.module']],
  [tags.labelName, ['entity.other.attribute-name.id', 'entity.name.label']],
  [tags.macroName, ['entity.name.function.macro']],
  [tags.tagName, ['entity.name.tag']],
  [tags.attributeName, ['entity.other.attribute-name']],
  [tags.heading, ['markup.heading', 'entity.name.section']],
  [tags.emphasis, ['markup.italic']],
  [tags.strong, ['markup.bold']],
  [tags.strikethrough, ['markup.strikethrough']],
  [tags.url, ['markup.underline.link']],
  [tags.quote, ['markup.quote']],
  [tags.contentSeparator, ['meta.separator']],
  [tags.monospace, ['markup.inline.raw', 'markup.raw']],
  [tags.inserted, ['markup.inserted']],
  [tags.deleted, ['markup.deleted']],
  [tags.changed, ['markup.changed']],
  [tags.invalid, ['invalid.illegal']],
]

interface Style {
  foreground?: string
  fontStyle?: string
}

/** The theme's rules by selector, a later rule for a selector overriding what it sets. */
function rulesOf(theme: ThemeRegistrationResolved): Map<string, Style> {
  const rules = new Map<string, Style>()
  for (const { scope, settings } of theme.settings) {
    const selectors = typeof scope === 'string' ? scope.split(',') : (scope ?? [])
    for (const selector of selectors.map((s) => s.trim())) {
      // A selector naming the scopes around a token never matches a tag, which stands alone.
      if (!selector || selector.includes(' ')) continue
      const rule = rules.get(selector) ?? {}
      if (settings.foreground !== undefined) rule.foreground = settings.foreground
      if (settings.fontStyle !== undefined) rule.fontStyle = settings.fontStyle
      rules.set(selector, rule)
    }
  }
  return rules
}

/** A scope's style as TextMate resolves it: each part from the longest selector that is a prefix. */
function styleOf(rules: Map<string, Style>, scope: string): Style {
  const style: Style = {}
  for (let end = scope.length; end > 0; end = scope.lastIndexOf('.', end - 1)) {
    const rule = rules.get(scope.slice(0, end))
    style.foreground ??= rule?.foreground
    style.fontStyle ??= rule?.fontStyle
  }
  return style
}

/** CodeMirror's highlight rules for a Shiki theme: each tag styled as its first styled scope. */
export function highlightSpecs(theme: ThemeRegistrationResolved): TagStyle[] {
  const rules = rulesOf(theme)
  const specs: TagStyle[] = []
  for (const [tag, scopes] of SCOPES) {
    const style = scopes
      .map((scope) => styleOf(rules, scope))
      .find((s) => s.foreground !== undefined || s.fontStyle !== undefined)
    if (!style) continue
    const words = style.fontStyle?.split(' ') ?? []
    const lines: string[] = []
    if (words.includes('underline')) lines.push('underline')
    if (words.includes('strikethrough')) lines.push('line-through')
    specs.push({
      tag,
      // Shiki stands in placeholders for colors that are not hex, such as `inherit`.
      ...(style.foreground && {
        color: theme.colorReplacements?.[style.foreground.toLowerCase()] ?? style.foreground,
      }),
      ...(words.includes('italic') && { fontStyle: 'italic' }),
      ...(words.includes('bold') && { fontWeight: 'bold' }),
      ...(lines.length > 0 && { textDecoration: lines.join(' ') }),
    })
  }
  return specs
}

const loaded = new Map<string, Promise<Extension>>()

/**
 * The editor's colors under a Shiki theme in the app's light or dark mode, with the surfaces the
 * pane gives it. Each is built once and kept, so the same promise comes back for the same choice.
 */
export function editorTheme(id: BundledTheme, dark: boolean): Promise<Extension> {
  const key = `${id} ${dark}`
  let extension = loaded.get(key)
  if (!extension) {
    extension = bundledThemes[id]().then(({ default: raw }) => {
      const theme = normalizeTheme(raw)
      return [
        EditorView.theme(
          {
            '&': { color: theme.fg, backgroundColor: 'var(--bg-app)' },
            '.cm-content': { caretColor: 'var(--text-primary)' },
            '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--text-primary)' },
            '.cm-gutters': {
              backgroundColor: 'var(--bg-app)',
              color: 'var(--text-disabled)',
              borderRightColor: 'transparent',
            },
            // The line being edited shows only while the editor has the focus.
            '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
            '&.cm-focused .cm-activeLine, &.cm-focused .cm-activeLineGutter': {
              backgroundColor: 'var(--bg-hover)',
            },
            // CodeMirror's own selection rules are more specific than a theme's.
            '&.cm-focused .cm-selectionBackground, & .cm-line::selection, & .cm-selectionLayer .cm-selectionBackground, .cm-content ::selection':
              { background: 'var(--selection) !important' },
            '& .cm-selectionMatch': { backgroundColor: 'var(--selection)' },
          },
          { dark },
        ),
        syntaxHighlighting(HighlightStyle.define(highlightSpecs(theme))),
      ]
    })
    loaded.set(key, extension)
  }
  return extension
}
