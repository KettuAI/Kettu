import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importTitle, readImport } from './import'
import { HTML_BYTES } from './tools'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function write(name: string, content: string | Uint8Array): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'overbench-import-'))
  dirs.push(dir)
  const file = path.join(dir, name)
  writeFileSync(file, content)
  return file
}

describe('importTitle', () => {
  it('takes the first title element, tidied', () => {
    expect(
      importTitle('<head><TITLE lang="en">\n  Q3  &amp; Q4\tplan </TITLE></head>', 'a.html'),
    ).toBe('Q3 & Q4 plan')
    expect(importTitle('<title>One</title><title>Two</title>', 'a.html')).toBe('One')
    expect(
      importTitle('<title>&lt;b&gt; &quot;x&quot; &#39;y&#39; &#x4F60;&#22909;</title>', 'a.html'),
    ).toBe('<b> "x" \'y\' 你好')
  })

  it('keeps an entity it does not know, and refuses a number that is no character', () => {
    expect(importTitle('<title>&nbsp;a&#0;b&#xD800;c&#9999999;</title>', 'a.html')).toBe(
      '&nbsp;a&#0;b&#xD800;c&#9999999;',
    )
  })

  it('falls back to the file name without its extension, then to Untitled', () => {
    expect(importTitle('<p>hi</p>', '/x/My  report.final.html')).toBe('My report.final')
    expect(importTitle('<title>  \n </title>', '/x/notes.htm')).toBe('notes')
    expect(importTitle('<titles>no</titles>', '/x/page.html')).toBe('page')
    expect(importTitle('<p>hi</p>', '/x/.html')).toBe('.html')
    expect(importTitle('<p>hi</p>', '')).toBe('Untitled')
  })

  it('cuts a title to 120 code points without splitting one', () => {
    const emoji = '😀'.repeat(130)
    expect(Array.from(importTitle(`<title>${emoji}</title>`, 'a.html'))).toHaveLength(120)
    expect(importTitle(`<title>${'a'.repeat(119)} bcd</title>`, 'a.html')).toBe('a'.repeat(119))
    expect(Array.from(importTitle('<p></p>', `/x/${'n'.repeat(200)}.html`))).toHaveLength(120)
  })
})

describe('readImport', () => {
  it('reads the HTML, its title and its pages', async () => {
    const html =
      '<title>Deck</title><body><section data-page="One">1</section>' +
      '<section data-page="Two">2</section></body>'
    expect(await readImport(write('deck.html', html))).toEqual({ html, title: 'Deck', pages: 2 })
  })

  it('drops a leading byte order mark', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>café</p>')])
    expect(await readImport(write('bom.html', bytes))).toEqual({
      html: '<p>café</p>',
      title: 'bom',
      pages: 0,
    })
  })

  it('refuses a file that is not UTF-8', async () => {
    expect(await readImport(write('latin.html', Buffer.from([0x3c, 0x70, 0x3e, 0xe9])))).toEqual({
      failed: 'not_utf8',
    })
  })

  it('takes exactly 5 MiB and refuses more', async () => {
    const full = await readImport(write('full.html', 'x'.repeat(HTML_BYTES)))
    expect(full).toMatchObject({ title: 'full' })
    expect(await readImport(write('big.html', 'x'.repeat(HTML_BYTES + 1)))).toEqual({
      failed: 'too_large',
    })
  })

  it('refuses a missing file and a folder', async () => {
    const file = write('a.html', '<p>a</p>')
    expect(await readImport(path.join(path.dirname(file), 'missing.html'))).toEqual({
      failed: 'unreadable',
    })
    const folder = path.join(path.dirname(file), 'folder.html')
    mkdirSync(folder)
    expect(await readImport(folder)).toEqual({ failed: 'unreadable' })
  })
})
