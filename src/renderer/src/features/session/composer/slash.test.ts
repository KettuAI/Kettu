import { describe, expect, it } from 'vitest'
import type { SlashCommand } from '@shared/thread'
import {
  activeSlashItems,
  applySlashChoice,
  insertSkill,
  keepsCompletedSlash,
  leadingCommand,
  placeCommand,
  slashAt,
  slashPopoverAt,
} from './slash'

const COMPACT: SlashCommand = { name: 'compact', description: 'Compact context' }
const STATUS: SlashCommand = { name: 'status', description: 'Show status' }
const REVIEW_SKILL: SlashCommand = {
  name: 'code-review',
  description: 'Review changes',
  kind: 'skill',
}
const AUDIT_SKILL: SlashCommand = {
  name: 'security-audit',
  description: 'Audit security',
  kind: 'skill',
}
const FORMAT_SKILL: SlashCommand = {
  name: 'release-notes',
  description: 'Format notes',
  kind: 'skill',
}
const COMMANDS: SlashCommand[] = [COMPACT, STATUS, REVIEW_SKILL, AUDIT_SKILL, FORMAT_SKILL]

describe('composer slash commands and stackable skills', () => {
  it('selects a single skill at the start or inline without moving the caret unexpectedly', () => {
    const atStart = applySlashChoice('/code', slashAt('/code', 5)!, REVIEW_SKILL, COMMANDS)
    expect(atStart).toEqual({ text: '/code-review ', caret: 13 })

    const inline = applySlashChoice(
      'Check auth with /code please',
      slashAt('Check auth with /code please', 21)!,
      REVIEW_SKILL,
      COMMANDS,
    )
    expect(inline).toEqual({ text: 'Check auth with /code-review please', caret: 29 })
  })

  it('allows selecting two or more skills in one message without replacing earlier ones', () => {
    const first = applySlashChoice('/code', slashAt('/code', 5)!, REVIEW_SKILL, COMMANDS)
    expect(first).toEqual({ text: '/code-review ', caret: 13 })

    const typedSecond = `${first.text}Review auth and apply /sec`
    const second = applySlashChoice(
      typedSecond,
      slashAt(typedSecond, typedSecond.length)!,
      AUDIT_SKILL,
      COMMANDS,
    )
    expect(second).toEqual({
      text: '/code-review Review auth and apply /security-audit ',
      caret: 51,
    })

    const typedThird = `${second.text}/rel`
    const third = applySlashChoice(
      typedThird,
      slashAt(typedThird, typedThird.length)!,
      FORMAT_SKILL,
      COMMANDS,
    )
    expect(third).toEqual({
      text: '/code-review Review auth and apply /security-audit /release-notes ',
      caret: 66,
    })
  })

  it('inserts a skill inline right next to another skill without doubling spaces', () => {
    const text = '/code-review /sec checks'
    const next = insertSkill(text, slashAt(text, 17)!, 'security-audit')
    expect(next).toEqual({ text: '/code-review /security-audit checks', caret: 29 })
  })

  it('keeps exclusive leading-command replacement semantics unchanged', () => {
    const text = '/compact hello /stat'
    const next = applySlashChoice(text, slashAt(text, text.length)!, STATUS, COMMANDS)
    expect(next).toEqual({ text: '/status hello ', caret: 14 })
    expect(leadingCommand(next.text, ['compact', 'status'])).toBe(7)
  })

  it('preserves a leading exclusive command when adding inline skills', () => {
    const text = '/status check auth /code'
    const next = applySlashChoice(text, slashAt(text, text.length)!, REVIEW_SKILL, COMMANDS)
    expect(next).toEqual({ text: '/status check auth /code-review ', caret: 32 })
  })

  it('places an exclusive command at the start without deleting a leading skill', () => {
    const text = '/code-review check auth /stat'
    const next = applySlashChoice(text, slashAt(text, text.length)!, STATUS, COMMANDS)
    expect(next).toEqual({ text: '/status /code-review check auth ', caret: 32 })
  })

  it('tracks active exclusive command and distinct skills, and updates cleanly after deleting one', () => {
    const both = activeSlashItems(
      '/status Use /code-review then /security-audit and /code-review',
      COMMANDS,
    )
    expect(both.command).toBe(STATUS)
    expect(both.skills).toEqual([REVIEW_SKILL, AUDIT_SKILL])

    // Removing the first skill leaves the second skill active.
    const afterDelete = activeSlashItems('/status Use  then /security-audit', COMMANDS)
    expect(afterDelete.command).toBe(STATUS)
    expect(afterDelete.skills).toEqual([AUDIT_SKILL])

    // Exclusive commands in the middle of text are not active.
    const midExclusive = activeSlashItems('please run /compact later /code-review', COMMANDS)
    expect(midExclusive.command).toBeNull()
    expect(midExclusive.skills).toEqual([REVIEW_SKILL])
  })

  it('keeps placeCommand working directly for callers passing exclusive names', () => {
    const text = '/compact foo /stat bar'
    const placed = placeCommand(text, slashAt(text, 18)!, 'status', ['compact', 'status'])
    expect(placed).toEqual({ text: '/status foo bar', caret: 12 })
  })
})

describe('slashPopoverAt and completed-slash suppression', () => {
  it('closes immediately after choosing a skill and does not reopen at its trailing boundary', () => {
    const chosen = applySlashChoice('/code', slashAt('/code', 5)!, REVIEW_SKILL, COMMANDS)
    const completed = { start: 0, name: REVIEW_SKILL.name }

    // Caret after the trailing space closes the popover.
    expect(slashPopoverAt(chosen.text, chosen.caret, COMMANDS, completed)).toBeNull()
    expect(keepsCompletedSlash(chosen.text, completed, slashAt(chosen.text, chosen.caret))).toBe(
      true,
    )

    // Caret settling on the chip edge right before the space must not reopen the popover.
    expect(slashPopoverAt(chosen.text, chosen.caret - 1, COMMANDS, completed)).toBeNull()
    expect(slashPopoverAt(chosen.text, chosen.caret - 1, COMMANDS, null)).toBeNull()

    // Deleting the trailing space right after choosing keeps the popover closed until the chip goes.
    const withoutSpace = chosen.text.trimEnd()
    expect(slashPopoverAt(withoutSpace, withoutSpace.length, COMMANDS, completed)).toBeNull()
    expect(
      keepsCompletedSlash(withoutSpace, completed, slashAt(withoutSpace, withoutSpace.length)),
    ).toBe(true)
  })

  it('reopens cleanly when typing a second slash after a chosen skill', () => {
    const completed = { start: 0, name: REVIEW_SKILL.name }
    const text = '/code-review /sec'
    const raw = slashAt(text, text.length)

    expect(keepsCompletedSlash(text, completed, raw)).toBe(false)
    expect(slashPopoverAt(text, text.length, COMMANDS, completed)).toEqual({
      start: 13,
      query: 'sec',
    })
  })

  it('clears completed suppression once the chosen token is removed or edited', () => {
    const completed = { start: 0, name: REVIEW_SKILL.name }

    expect(keepsCompletedSlash('', completed, slashAt('', 0))).toBe(false)
    expect(keepsCompletedSlash('/code-revie', completed, slashAt('/code-revie', 11))).toBe(false)
    expect(slashPopoverAt('/code-revie', 11, COMMANDS, null)).toEqual({
      start: 0,
      query: 'code-revie',
    })
  })

  it('still opens while typing a prefix or editing in the middle of a slash word', () => {
    // Still typing at end of text (no trailing space yet).
    expect(slashPopoverAt('/code-review', 12, COMMANDS, null)).toEqual({
      start: 0,
      query: 'code-review',
    })
    // Caret in the middle of a word before whitespace.
    expect(slashPopoverAt('/code-review ', 5, COMMANDS, null)).toEqual({
      start: 0,
      query: 'code-review',
    })
    // Leading exclusive command edge before whitespace stays closed.
    expect(slashPopoverAt('/compact ', 8, COMMANDS, null)).toBeNull()
  })
})
