// Shared contract for previewing and safely undoing a single turn's file changes.

/** The filesystem action required to undo a turn's edits to one file. */
export type TurnUndoAction = 'revert' | 'delete' | 'restore'

/** Verification state of one affected file before applying an undo. */
export type TurnUndoFileStatus = 'ready' | 'conflict' | 'unsupported'

/** Machine-readable reason why a file cannot be undone cleanly. */
export type TurnUndoReason =
  | 'content_mismatch'
  | 'ambiguous_match'
  | 'modified_after_turn'
  | 'file_missing'
  | 'file_already_exists'
  | 'missing_before_snapshot'
  | 'replace_all_unsupported'
  | 'binary_or_unreadable'
  | 'outside_workspace'
  | 'symlink_not_allowed'
  | 'directory_in_way'
  | 'too_large'
  | 'unsupported_operation'

/** Exact current-state fingerprint of one file on disk, verified again before applying. */
export interface TurnUndoFileDigest {
  /** Workspace-relative path using '/' separators, or the raw path when outside the workspace. */
  path: string
  /** Whether the file existed on disk when fingerprinted. */
  exists: boolean
  /** SHA-256 hex digest of raw file bytes; null when absent or unreadable. */
  sha256: string | null
  /** File byte length; null when absent or unreadable. */
  size: number | null
}

/** Preview details for one file touched in the target turn. */
export interface TurnUndoFilePreview {
  /** Workspace-relative path using '/' separators, or the original path if outside workspace. */
  path: string
  /** Path as originally recorded in the turn's tool entries. */
  displayPath: string
  action: TurnUndoAction
  status: TurnUndoFileStatus
  reason?: TurnUndoReason
  /** Current text on disk (LF-normalized for diff rendering); null when missing or unreadable. */
  beforeText: string | null
  /** Resulting text after undo (LF-normalized); null when deleting or when undo is blocked. */
  afterText: string | null
  /** Number of recorded file-change operations in this turn for this file. */
  editCount: number
}

/** One file blocking the turn undo from proceeding. */
export interface TurnUndoConflict {
  path: string
  reason: TurnUndoReason
}

/** Full preview and verification snapshot for undoing one turn's file changes. */
export interface TurnUndoPreview {
  /** Combined SHA-256 fingerprint across all `fileDigests`. */
  fingerprint: string
  /** Per-file current-state digests captured during this verification pass. */
  fileDigests: TurnUndoFileDigest[]
  /** Every file touched by the turn, with its reverse diff or conflict reason. */
  affectedFiles: TurnUndoFilePreview[]
  /** Every file that currently blocks applying the undo. */
  conflicts: TurnUndoConflict[]
  /** True only when every affected file is ready, there are no conflicts, and not already undone. */
  canApply: boolean
  /** True when this turn's file changes were already undone earlier. */
  alreadyUndone: boolean
}

/** Outcome of `sessions.undoTurn`: all-or-nothing apply, stale re-check, or conflict block. */
export type TurnUndoResult =
  | {
      status: 'applied'
      revertedFiles: string[]
      deletedFiles: string[]
      restoredFiles: string[]
    }
  | {
      status: 'stale'
      changedPaths: string[]
      preview: TurnUndoPreview
    }
  | {
      status: 'conflict'
      preview: TurnUndoPreview
    }
