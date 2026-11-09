import { describe, expect, it } from 'vitest'
import { frontmatter } from './frontmatter'

describe('frontmatter', () => {
  it('reads plain values, as the catalog writes most of them', () => {
    const text = [
      '---',
      'name: pdf',
      'description: Use this skill for PDF files: reading, merging and OCR.',
      'license: Complete terms in LICENSE.txt',
      '---',
      '',
      '# PDF',
    ].join('\n')
    expect(frontmatter(text)).toEqual({
      name: 'pdf',
      description: 'Use this skill for PDF files: reading, merging and OCR.',
      license: 'Complete terms in LICENSE.txt',
    })
  })

  it('reads quoted values with their escapes', () => {
    const text = [
      '---',
      'name: "web-tests"',
      'description: "Say \\"hi\\" twice"',
      "title: 'It''s quoted'",
      '---',
    ].join('\n')
    expect(frontmatter(text)).toEqual({
      name: 'web-tests',
      description: 'Say "hi" twice',
      title: "It's quoted",
    })
  })

  it('folds a > block into one line and keeps the lines of a | block', () => {
    const text = [
      '---',
      'name: claude-api',
      'description: >-',
      '  Reference for the API,',
      '  in one paragraph.',
      '',
      '  A second one.',
      'notes: |-',
      '  first line',
      '  second line',
      '---',
    ].join('\n')
    expect(frontmatter(text)).toEqual({
      name: 'claude-api',
      description: 'Reference for the API, in one paragraph.\nA second one.',
      notes: 'first line\nsecond line',
    })
  })

  it('continues a plain value on indented lines, and drops a trailing comment', () => {
    const text = ['---', 'description: one', '  two', 'name: x # the name', '---'].join('\n')
    expect(frontmatter(text)).toEqual({ description: 'one two', name: 'x' })
  })

  it('passes over nested maps and lists, and reads CRLF files with a BOM', () => {
    const text = [
      '﻿---',
      'name: tool',
      'metadata:',
      '  version: 2',
      'allowed-tools:',
      '  - Bash',
      'description: Does things',
      '---',
    ].join('\r\n')
    expect(frontmatter(text)).toEqual({ name: 'tool', description: 'Does things' })
  })

  it('finds nothing without a closed frontmatter block', () => {
    expect(frontmatter('# Title\nname: x')).toEqual({})
    expect(frontmatter('---\nname: x\n')).toEqual({})
  })
})
