// What a permission mode looks like in the composer, from the ids Claude Code and Codex give
// their modes; any other agent's mode reads as one that asks.

import { isFullAccessMode } from '@shared/agents'

export type ModeLook = 'asks' | 'edits' | 'plan' | 'auto' | 'full'

const LOOKS: Record<string, ModeLook> = {
  default: 'asks',
  'read-only': 'asks',
  'workspace-write': 'asks',
  acceptEdits: 'edits',
  plan: 'plan',
  auto: 'auto',
  agent: 'auto',
}

export function modeLook(value: string | undefined): ModeLook {
  if (isFullAccessMode(value)) return 'full'
  return (value !== undefined && Object.hasOwn(LOOKS, value) && LOOKS[value]) || 'asks'
}

/** The mode a number key chooses, 1 for the first to 9 for the ninth. */
export function numberedMode<T>(choices: readonly T[], key: string): T | undefined {
  return /^[1-9]$/.test(key) ? choices[Number(key) - 1] : undefined
}

/** The mode after `value` in the agent's order, round from the last to the first. */
export function nextChoice(
  choices: readonly { value: string }[],
  value: string | undefined,
): string | undefined {
  if (choices.length === 0) return undefined
  const at = choices.findIndex((c) => c.value === value)
  return choices[(at + 1) % choices.length]!.value
}

/** The mode Shift+Tab moves to: the next in the agent's order, past any that gives full access. */
export function nextMode(
  choices: readonly { value: string }[],
  value: string | undefined,
): string | undefined {
  return nextChoice(
    choices.filter((c) => modeLook(c.value) !== 'full' || c.value === value),
    value,
  )
}
