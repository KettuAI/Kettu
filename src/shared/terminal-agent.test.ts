import { describe, expect, it } from 'vitest'
import { parseReplyRunNotice, replyCommandProblem, replyRunNotice } from './terminal-agent'

describe("a reply's code block the user runs", () => {
  it('runs only what it shows', () => {
    expect(replyCommandProblem('cd /tmp/app && pnpm dev\n\tpnpm test')).toBeNull()
    expect(replyCommandProblem('  \n')).toBe('empty')
    expect(replyCommandProblem('a'.repeat(16 * 1024 + 1))).toBe('too_long')
    for (const command of ['ls\r', 'ls\x1b[A', 'ls\x07', 'ls\x85']) {
      expect(replyCommandProblem(command)).toBe('control')
    }
    for (const command of ['rm -rf a‮b', 'cd​/tmp', 'ls﻿', 'echo⁦x⁩']) {
      expect(replyCommandProblem(command)).toBe('invisible')
    }
  })

  it("names the terminal and the block in the agent's notice, and reads them back", () => {
    for (const command of ['pnpm dev', 'echo "```"\nls', 'printf `date`']) {
      const notice = replyRunNotice('3f2a-77', command)
      expect(parseReplyRunNotice(notice)).toEqual({ terminalId: '3f2a-77', command })
    }
    expect(parseReplyRunNotice('I ran this from your reply in terminal, I think')).toBeNull()
  })
})
