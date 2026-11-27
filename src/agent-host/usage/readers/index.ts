// The log readers, one per agent that keeps its own usage on disk.

import type { LogReader } from '../model'
import { antigravityReader } from './antigravity'
import { claudeReader } from './claude'
import { codexReader } from './codex'
import { opencodeReader } from './opencode'
import { piReader } from './pi'

export const LOG_READERS: readonly LogReader[] = [
  claudeReader,
  codexReader,
  opencodeReader,
  piReader,
  antigravityReader,
]
