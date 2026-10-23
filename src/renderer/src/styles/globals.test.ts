import { describe, expect, it } from 'vitest'
import css from './globals.css?raw'

// The text between the braces of every block that opens after `header`.
function blocksAfter(header: string): string[] {
  const blocks: string[] = []
  for (let from = css.indexOf(header); from >= 0; from = css.indexOf(header, from + 1)) {
    const open = css.indexOf('{', from)
    let depth = 0
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++
      else if (css[i] === '}' && --depth === 0) {
        blocks.push(css.slice(open + 1, i))
        break
      }
    }
  }
  return blocks
}

// The selectors of the rule in `block` that sets `animation: none`, without nesting prefixes.
function stoppedSelectors(block: string): string[] {
  const rule = /([^{}]+)\{[^{}]*animation:\s*none\s*!important[^{}]*\}/.exec(block)
  expect(rule, 'no rule stops animations').not.toBeNull()
  return rule![1].split(',').map((selector) => selector.trim().replace(/^&\s*/, ''))
}

// The two places that turn reduce motion on: the OS setting and Settings > Appearance.
const osBlocks = blocksAfter('@media (prefers-reduced-motion: reduce)').filter((block) =>
  block.includes('animation: none'),
)
const settingBlocks = blocksAfter(":root[data-reduce-motion='always']")

describe('reduce motion in globals.css', () => {
  it('has one block for the OS setting and one for the Settings override', () => {
    expect(osBlocks).toHaveLength(1)
    expect(settingBlocks).toHaveLength(1)
  })

  it.each([
    ['the OS setting', osBlocks],
    ['the Settings override', settingBlocks],
  ])('holds looping animations still under %s', (_name, blocks) => {
    // Spinners and pulses loop forever, so they must stop; one-shot animations may play.
    expect(stoppedSelectors(blocks[0])).toEqual(
      expect.arrayContaining(['.animate-spin', '.animate-pulse', '.animate-ping']),
    )
  })

  it('stops the same loops in both blocks', () => {
    expect(stoppedSelectors(settingBlocks[0])).toEqual(stoppedSelectors(osBlocks[0]))
  })
})
