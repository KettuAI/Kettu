// An agent's settings tools reach the settings through whoever keeps the file, the desktop app's
// main or the daemon: a read, or a change that goes through the same checks as the Settings page.

import type { SettingFacts, SettingsCallAnswer } from '@shared/host-control'
import type { SettingsStore } from './settings'

export interface SettingsOwner {
  settings: Pick<SettingsStore, 'get' | 'update'>
  /** The desktop app, whose window's and computer's rows apply. */
  desktop: boolean
  /** What the owner reads beyond the file; never a secret's value. */
  facts(): SettingFacts
  /** A change was applied, for the action records. */
  changed?(patch: unknown): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function answerSettingsCall(call: unknown, owner: SettingsOwner): SettingsCallAnswer {
  if (!isRecord(call) || (call.kind !== 'read' && call.kind !== 'change')) {
    return { error: 'Not a settings call.' }
  }
  if (call.kind === 'change') {
    try {
      owner.settings.update(call.patch, { plugins: call.plugins === true })
    } catch (error) {
      return { error: (error as Error).message }
    }
    owner.changed?.(call.patch)
  }
  let facts: SettingFacts = {}
  try {
    facts = owner.facts()
  } catch {
    // The rows the facts name read as not read here.
  }
  return { result: { file: owner.settings.get(), desktop: owner.desktop, facts } }
}
