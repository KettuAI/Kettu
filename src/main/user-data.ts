import { join, resolve } from 'node:path'

/** The folder beside the installed app's own that unpackaged runs use. */
export const DEV_DATA_FOLDER = 'OverBench Dev'

export interface UserDataInput {
  isPackaged: boolean
  /** Electron's own `--user-data-dir` switch was passed. */
  hasSwitch: boolean
  /** `app.getPath('appData')`. */
  appData: string
  /** The value of `OVERBENCH_USER_DATA`, if set. */
  override: string | undefined
  /** Where a relative `override` is resolved from. */
  cwd: string
}

/**
 * The data folder an unpackaged run must switch to, or null to keep Electron's default. The
 * switch always wins, and a packaged build ignores the variable, so that nothing inherited from a
 * shell can move an installed app's data.
 */
export function devUserDataPath(input: UserDataInput): string | null {
  if (input.isPackaged || input.hasSwitch) return null
  const override = input.override?.trim()
  return override ? resolve(input.cwd, override) : join(input.appData, DEV_DATA_FOLDER)
}
