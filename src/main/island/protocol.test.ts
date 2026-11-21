import { describe, expect, it } from 'vitest'
import { islandLine, LineReader, MAX_LINE_BYTES, parseIslandLine } from './protocol'

describe('parseIslandLine', () => {
  it('takes the messages the helper may send', () => {
    expect(parseIslandLine('{"type":"ready","protocol":1,"version":"0.1.0"}')).toEqual({
      type: 'ready',
      protocol: 1,
      version: '0.1.0',
    })
    expect(parseIslandLine('{"type":"answer","id":"a1","request":"s#t","option":"o"}')).toEqual({
      type: 'answer',
      id: 'a1',
      request: 's#t',
      option: 'o',
    })
    expect(parseIslandLine('{"type":"open","row":"s1"}')).toEqual({ type: 'open', row: 's1' })
    expect(parseIslandLine('{"type":"open","row":null}')).toEqual({ type: 'open', row: null })
    expect(parseIslandLine('{"type":"open"}')).toEqual({ type: 'open', row: null })
    expect(parseIslandLine('{"type":"openRequest","request":"task:local/t1"}')).toEqual({
      type: 'openRequest',
      request: 'task:local/t1',
    })
    expect(parseIslandLine('{"type":"notice","notice":"app-update"}')).toEqual({
      type: 'notice',
      notice: 'app-update',
    })
    expect(parseIslandLine('{"type":"newSession"}')).toEqual({ type: 'newSession' })
    expect(parseIslandLine('{"type":"expanded"}')).toEqual({ type: 'expanded' })
    expect(parseIslandLine('{"type":"resync"}')).toEqual({ type: 'resync' })
  })

  it('keeps only the fields it knows', () => {
    expect(parseIslandLine('{"type":"expanded","method":"sessions.show"}')).toEqual({
      type: 'expanded',
    })
    expect(
      parseIslandLine('{"type":"answer","id":"a","request":"r","option":"o","method":"x"}'),
    ).toEqual({ type: 'answer', id: 'a', request: 'r', option: 'o' })
  })

  it('refuses what is not a message, or one with fields of the wrong kind or size', () => {
    const refused = [
      '',
      'not json',
      'null',
      '[]',
      '"ready"',
      '{}',
      '{"type":"quit"}',
      '{"type":"hello"}',
      '{"type":"request","method":"sessions.show","params":{}}',
      '{"type":"ready","protocol":"1","version":"x"}',
      '{"type":"ready","protocol":1.5,"version":"x"}',
      '{"type":"ready","protocol":1}',
      `{"type":"ready","protocol":1,"version":"${'v'.repeat(65)}"}`,
      '{"type":"answer","id":"","request":"r","option":"o"}',
      '{"type":"answer","id":1,"request":"r","option":"o"}',
      '{"type":"answer","id":"a","request":"r"}',
      `{"type":"answer","id":"a","request":"${'r'.repeat(129)}","option":"o"}`,
      '{"type":"answer","id":"a","request":{"key":"r"},"option":"o"}',
      '{"type":"open","row":7}',
      '{"type":"open","row":""}',
      '{"type":"openRequest"}',
      '{"type":"notice"}',
      '{"type":"notice","notice":""}',
      '{"type":"notice","notice":{"action":"restart"}}',
      `{"type":"notice","notice":"${'n'.repeat(129)}"}`,
      '{"type":"openRequest","request":""}',
      '{"type":"openRequest","request":{"taskId":"t1"}}',
    ]
    for (const line of refused) expect(parseIslandLine(line), line).toBeNull()
  })
})

describe('islandLine', () => {
  it('writes one line of JSON', () => {
    expect(islandLine({ type: 'quit' })).toBe('{"type":"quit"}\n')
  })

  it('refuses a message past the line limit, counted in UTF-8 bytes', () => {
    const fits = 'x'.repeat(MAX_LINE_BYTES - 100)
    expect(islandLine({ type: 'appearance', colorMode: 'dark', pad: fits } as never)).not.toBeNull()
    // Three bytes each in UTF-8, so a third of the limit in characters is already too long.
    const wide = '界'.repeat(MAX_LINE_BYTES / 3)
    expect(islandLine({ type: 'pop', row: null, kind: 'error', title: wide, body: '' })).toBeNull()
  })
})

describe('LineReader', () => {
  function reader() {
    const lines: string[] = []
    const bad: string[] = []
    const r = new LineReader(
      (line) => lines.push(line),
      (reason) => bad.push(reason),
    )
    return { push: (text: string | Uint8Array) => r.push(bytes(text)), lines, bad }
  }
  const bytes = (text: string | Uint8Array) =>
    typeof text === 'string' ? new TextEncoder().encode(text) : text

  it('splits lines across chunks and skips blank ones', () => {
    const r = reader()
    r.push('{"a":1}\n{"b"')
    r.push(':2}\r\n\n  \n{"c":3}')
    expect(r.lines).toEqual(['{"a":1}', '{"b":2}'])
    r.push('\n')
    expect(r.lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}'])
    expect(r.bad).toEqual([])
  })

  it('keeps a character split between chunks', () => {
    const r = reader()
    const all = new TextEncoder().encode('"界"\n')
    r.push(all.subarray(0, 2))
    r.push(all.subarray(2))
    expect(r.lines).toEqual(['"界"'])
  })

  it('drops a line past the limit up to its newline, and reads on after it', () => {
    const r = reader()
    const chunk = 'x'.repeat(64 * 1024)
    for (let i = 0; i < 17; i++) r.push(chunk)
    r.push('tail\n{"ok":true}\n')
    expect(r.bad).toEqual(['too_long'])
    expect(r.lines).toEqual(['{"ok":true}'])
  })

  it('takes a line of exactly the limit', () => {
    const r = reader()
    r.push(`${'x'.repeat(MAX_LINE_BYTES)}\n`)
    expect(r.bad).toEqual([])
    expect(r.lines[0]?.length).toBe(MAX_LINE_BYTES)
  })

  it('reports a line that is not UTF-8', () => {
    const r = reader()
    r.push(new Uint8Array([0xff, 0xfe, 0x0a]))
    r.push('{"ok":1}\n')
    expect(r.bad).toEqual(['not_utf8'])
    expect(r.lines).toEqual(['{"ok":1}'])
  })
})
