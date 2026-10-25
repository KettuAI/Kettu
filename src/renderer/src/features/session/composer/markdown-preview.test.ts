import { describe, expect, it } from 'vitest'
import { EditorSelection, EditorState } from '@codemirror/state'
import { previewDecorations } from './markdown-preview'

/**
 * The decorations for `doc`, sorted: `line:<classes> <at>` for a line, then `bullet`, a mark's
 * class or `hide` with the range. Focused when a selection is given, unless `focused` says not.
 */
function drawn(
  doc: string,
  selection?: { anchor: number; head?: number },
  focused = selection !== undefined,
  visible?: { from: number; to: number }[],
): string[] {
  const state = EditorState.create({
    doc,
    selection: selection && EditorSelection.single(selection.anchor, selection.head),
  })
  const out: string[] = []
  previewDecorations(state, focused, visible).between(0, doc.length, (from, to, deco) => {
    const spec = deco.spec as { class?: string; widget?: unknown }
    if (from === to) out.push(`line:${spec.class} ${from}`)
    else out.push(`${spec.widget ? 'bullet' : (spec.class ?? 'hide')} ${from}-${to}`)
  })
  return out.sort()
}

describe('previewDecorations', () => {
  it('hides the marks of bold unless the focused caret touches it', () => {
    const hidden = ['cm-md-strong 0-8', 'hide 0-2', 'hide 6-8']
    const shown = ['cm-md-mark 0-2', 'cm-md-mark 6-8', 'cm-md-strong 0-8']
    expect(drawn('**bold** x')).toEqual(hidden)
    expect(drawn('**bold** x', { anchor: 4 })).toEqual(shown)
    expect(drawn('**bold** x', { anchor: 8 })).toEqual(shown)
    expect(drawn('**bold** x', { anchor: 10 })).toEqual(hidden)
    expect(drawn('**bold** x', { anchor: 4 }, false)).toEqual(hidden)
  })

  it('shows the marks of each element a selection touches, and only those', () => {
    expect(drawn('**a** **b**', { anchor: 1 })).toEqual([
      'cm-md-mark 0-2',
      'cm-md-mark 3-5',
      'cm-md-strong 0-5',
      'cm-md-strong 6-11',
      'hide 6-8',
      'hide 9-11',
    ])
    expect(drawn('**a** **b**', { anchor: 0, head: 11 })).toEqual([
      'cm-md-mark 0-2',
      'cm-md-mark 3-5',
      'cm-md-mark 6-8',
      'cm-md-mark 9-11',
      'cm-md-strong 0-5',
      'cm-md-strong 6-11',
    ])
  })

  it('styles emphasis, Chinese emphasis, strikethrough and inline code', () => {
    expect(drawn('*em* _em_')).toEqual([
      'cm-md-em 0-4',
      'cm-md-em 5-9',
      'hide 0-1',
      'hide 3-4',
      'hide 5-6',
      'hide 8-9',
    ])
    expect(drawn('*强调*')).toEqual(['cm-md-em-han 0-4', 'hide 0-1', 'hide 3-4'])
    expect(drawn('~~s~~')).toEqual(['cm-md-strike 0-5', 'hide 0-2', 'hide 3-5'])
    expect(drawn('`code`')).toEqual(['cm-md-code 0-6', 'hide 0-1', 'hide 5-6'])
  })

  it('styles heading lines and hides their marks unless the caret is on the line', () => {
    expect(drawn('## Title')).toEqual(['hide 0-3', 'line:cm-md-h cm-md-h2 0'])
    expect(drawn('## Title', { anchor: 5 })).toEqual(['cm-md-mark 0-2', 'line:cm-md-h cm-md-h2 0'])
    expect(drawn('## Title ##')).toEqual(['hide 0-3', 'hide 9-11', 'line:cm-md-h cm-md-h2 0'])
    expect(drawn('Title\n===')).toEqual([
      'cm-md-mark 6-9',
      'line:cm-md-h cm-md-h1 0',
      'line:cm-md-h cm-md-h1 6',
    ])
  })

  it('draws a bullet for an unordered item and mutes an ordered number', () => {
    expect(drawn('a\n- item', { anchor: 0 })).toEqual(['bullet 2-3'])
    expect(drawn('a\n- item', { anchor: 5 })).toEqual(['cm-md-mark 2-3'])
    expect(drawn('1. one')).toEqual(['cm-md-number 0-2'])
  })

  it('styles the lines of a quote, a lazy line included', () => {
    expect(drawn('> quote')).toEqual(['hide 0-2', 'line:cm-md-quote 0'])
    expect(drawn('> a\nb')).toEqual(['hide 0-2', 'line:cm-md-quote 0', 'line:cm-md-quote 4'])
  })

  it('styles the text of an inline link and hides the rest', () => {
    expect(drawn('[t](https://x.y)')).toEqual(['cm-md-link 1-2', 'hide 0-1', 'hide 2-16'])
    expect(drawn('[t](https://x.y)', { anchor: 1 })).toEqual([
      'cm-md-link 1-2',
      'cm-md-mark 0-1',
      'cm-md-mark 2-16',
    ])
    // A view plugin may not hide a line break, so these marks stay, dimmed.
    expect(drawn('[a](\nu)')).toEqual(['cm-md-link 1-2', 'cm-md-mark 2-7', 'hide 0-1'])
  })

  it('leaves what it does not draw as typed', () => {
    for (const doc of [
      '```\n**no**\n```',
      '    code',
      '![a](b) https://bare.example',
      'see [1] and a[0]',
      '<https://x.y> \\*no\\*',
      '| a | b |\n| - | - |\n| 1 | 2 |',
    ])
      expect(drawn(doc)).toEqual([])
  })

  it('draws only the visible ranges', () => {
    expect(drawn('**a**\n\n**b**', undefined, false, [{ from: 7, to: 12 }])).toEqual([
      'cm-md-strong 7-12',
      'hide 10-12',
      'hide 7-9',
    ])
  })
})
