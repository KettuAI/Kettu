// The log readers, one per agent that keeps its own usage on disk.

import type { LogReader } from '../model'
import { claudeReader } from './claude'
import { codexReader } from './codex'
import { opencodeReader } from './opencode'

export const LOG_READERS: readonly LogReader[] = [claudeReader, codexReader, opencodeReader]
