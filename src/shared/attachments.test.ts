import { describe, expect, it } from 'vitest'
import { lineCount, promptShare, readTextThumb, textThumb } from './attachments'

describe('pasted texts', () => {
  it('counts lines as an editor shows them, with no empty one after a final break', () => {
    expect(lineCount('')).toBe(0)
    expect(lineCount('one')).toBe(1)
    expect(lineCount('one\n')).toBe(1)
    expect(lineCount('one\r\ntwo\rthree\nfour')).toBe(4)
    expect(lineCount('\n\n')).toBe(2)
  })

  it('keeps the first three lines and the line count in the thumb', () => {
    const thumb = textThumb('a,b%\n\n  indented\nfourth\n')
    expect(thumb.startsWith('data:text/plain;charset=utf-8;lines=4,')).toBe(true)
    expect(readTextThumb(thumb)).toEqual({ lines: ['a,b%', '', '  indented'], count: 4 })
    expect(readTextThumb(textThumb('only'))).toEqual({ lines: ['only'], count: 1 })
  })

  it('cuts long lines, so the thumb stays small', () => {
    const preview = readTextThumb(textThumb('x'.repeat(50_000)))
    expect(preview?.lines[0]).toHaveLength(120)
    expect(preview?.count).toBe(1)
  })

  it('reads no preview from an image thumbnail or a broken one', () => {
    expect(readTextThumb('data:image/webp;base64,AAAA')).toBeNull()
    expect(readTextThumb('data:text/plain;charset=utf-8;lines=2,%E0%A4%A')).toBeNull()
    expect(readTextThumb(null)).toBeNull()
  })

  it('counts a pasted text toward the prompt as it is sent', () => {
    expect(promptShare({ type: 'text', mimeType: 'text/plain', size: 12_000 })).toBe(12_000)
  })
})
