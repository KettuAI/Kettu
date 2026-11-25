// What the Files tree puts in a folder from outside the project: files and folders dropped from
// the file manager, or files chosen to upload. A project on this computer copies them from the
// paths main grants; another host's, or any in the web client, gets their bytes. A name that is
// taken asks Replace or Skip first.

import { useRef, useState, type DragEvent } from 'react'
import { create } from 'zustand'
import { ATTACHMENT_BYTES } from '@shared/attachments'
import { lastingToast, toast } from '@renderer/components/ui/toast'
import { errorCode, errorMessage, host } from '@renderer/lib/host'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { isWeb } from '@renderer/lib/platform'
import { loadFiles, useFilesStore } from '@renderer/stores/files'
import { joinPath, nameOf } from './paths'

/** A file dropped or chosen; `folder` when the drop said it is a folder. */
export interface Incoming {
  file: File
  folder: boolean
}

export type ReplaceChoice = 'replace' | 'skip' | 'stop'

/** A taken name the upload waits on, in the side panel it started from. */
export interface ReplaceAsk {
  panel: string
  name: string
  folder: boolean
  /** Where it goes: the folder's path, or the project's own folder's name. */
  place: string
  /** Items after this one, which an answer for all of them covers. */
  rest: number
  answer(choice: ReplaceChoice, all: boolean): void
}

export const useUploadStore = create<{ asks: ReplaceAsk[] }>()(() => ({ asks: [] }))

/** Shows the question and waits for its answer, which takes it away. */
function ask(question: Omit<ReplaceAsk, 'answer'>): {
  answer: Promise<{ choice: ReplaceChoice; all: boolean }>
  stop: () => void
} {
  let asked!: ReplaceAsk
  const answer = new Promise<{ choice: ReplaceChoice; all: boolean }>((resolve) => {
    let answered = false
    asked = {
      ...question,
      answer: (choice, all) => {
        if (answered) return
        answered = true
        useUploadStore.setState((s) => ({ asks: s.asks.filter((one) => one !== asked) }))
        resolve({ choice, all })
      },
    }
  })
  useUploadStore.setState((s) => ({ asks: [...s.asks, asked] }))
  return { answer, stop: () => asked.answer('stop', false) }
}

const MEGABYTE = 1024 * 1024

/** Whether the tree's list already has something at `path`, so it is asked before bytes go. */
function listed(projectPath: string, path: string): boolean {
  const files = useFilesStore.getState().byProject[projectPath]
  if (!files) return false
  const prefix = `${path}/`
  return (
    files.known.has(path) ||
    files.folders.includes(path) ||
    files.ignored.includes(path) ||
    files.ignoredFolders.includes(path) ||
    files.paths.some((listedPath) => listedPath.startsWith(prefix))
  )
}

/** Sends one item: by main's grant on this computer, else its bytes. */
async function send(
  projectPath: string,
  path: string,
  item: Incoming,
  byPath: boolean,
  replace: boolean,
): Promise<void> {
  const params = { projectPath, path, replace }
  if (byPath) {
    const [grant] = await window.kettu.attachments.fromFiles([item.file])
    if (grant) return host('files.upload', { ...params, source: { grantId: grant.grantId } })
  }
  if (item.folder) throw new Error(i18n.t('files:upload.noFolders'))
  if (item.file.size > ATTACHMENT_BYTES) {
    throw new Error(i18n.t('files:upload.tooLarge', { limit: `${ATTACHMENT_BYTES / MEGABYTE} MB` }))
  }
  const bytes = await item.file.arrayBuffer().catch(() => {
    throw new Error(i18n.t('files:upload.unreadable'))
  })
  return host('files.upload', { ...params, source: { bytes } })
}

/** What the toast after an upload says. */
function report(
  place: string,
  total: number,
  uploaded: readonly string[],
  skipped: number,
  failed: readonly { name: string; reason: string }[],
  stopped: boolean,
): void {
  const t = i18n.t
  const shown = failed
    .slice(0, 2)
    .map(({ name, reason }) => t('files:upload.why', { name, reason }))
  if (failed.length > shown.length) {
    shown.push(t('files:upload.moreFailed', { count: failed.length - shown.length }))
  }
  if (skipped > 0) shown.push(t('files:upload.skipped', { count: skipped }))
  const description = shown.length > 0 ? shown.join(' · ') : undefined
  const count = uploaded.length
  const title = stopped
    ? t('files:upload.stopped', { count })
    : failed.length === 0
      ? count === 0
        ? t('files:upload.none')
        : count === 1
          ? t('files:upload.doneOne', { name: nameOf(uploaded[0]!), place })
          : t('files:upload.done', { count, place })
      : count === 0
        ? total === 1
          ? t('files:upload.failedOne', { name: failed[0]!.name })
          : t('files:upload.failed', { count: failed.length })
        : t('files:upload.partly', { count, total })
  const tone = failed.length > 0 ? 'warning' : count > 0 && !stopped ? 'success' : 'info'
  toast(title, undefined, { tone, ...(description !== undefined && { description }) })
}

/**
 * Puts the items in `folder` of the project ('' for its own), one after another, asking when a
 * name is taken, with a toast that tells how far it is and can stop it before the next item.
 * Lists the files again after, and gives the paths that were written.
 */
export async function uploadInto(
  projectPath: string,
  panel: string,
  folder: string,
  incoming: readonly Incoming[],
): Promise<string[]> {
  if (incoming.length === 0) return []
  const t = i18n.t
  const byPath = !isWeb && hostOfPath(projectPath) === null
  const place =
    folder === '' ? (hostPath(projectPath).split(/[\\/]/).filter(Boolean).at(-1) ?? '') : folder
  const total = incoming.length
  let stopped = false
  let asking: { stop: () => void } | null = null
  const progress = lastingToast(t('files:upload.uploading', { name: incoming[0]!.file.name }), {
    label: t('common:actions.cancel'),
    onClick: () => {
      stopped = true
      asking?.stop()
    },
  })
  // An answer for every item after the one asked about.
  let always: 'replace' | 'skip' | null = null
  const decide = async (item: Incoming, rest: number): Promise<ReplaceChoice> => {
    if (always) return always
    const question = ask({ panel, name: item.file.name, folder: item.folder, place, rest })
    asking = question
    const { choice, all } = await question.answer
    asking = null
    if (all && choice !== 'stop') always = choice
    return choice
  }
  const uploaded: string[] = []
  const failed: { name: string; reason: string }[] = []
  let skipped = 0
  for (const [index, item] of incoming.entries()) {
    if (stopped) break
    const { name } = item.file
    progress.update(
      total === 1
        ? t('files:upload.uploading', { name })
        : t('files:upload.uploadingOf', { current: index + 1, total, name }),
    )
    const path = joinPath(folder, name)
    const rest = total - index - 1
    let replace = always === 'replace'
    let choice: ReplaceChoice | null = null
    if (!replace && listed(projectPath, path)) {
      choice = await decide(item, rest)
      replace = choice === 'replace'
    }
    while (choice === null || choice === 'replace') {
      try {
        await send(projectPath, path, item, byPath, replace)
        uploaded.push(path)
        break
      } catch (error) {
        if (errorCode(error) === 'conflict' && !replace) {
          choice = await decide(item, rest)
          replace = choice === 'replace'
          continue
        }
        const reason =
          errorCode(error) === 'unknown_method' ? t('files:upload.hostTooOld') : errorMessage(error)
        failed.push({ name, reason })
        // An older host takes none of them.
        if (errorCode(error) === 'unknown_method') stopped = true
        break
      }
    }
    if (choice === 'skip') skipped++
    if (choice === 'stop') stopped = true
  }
  progress.close()
  await loadFiles(projectPath)
  report(
    place,
    total,
    uploaded,
    skipped,
    failed,
    stopped && uploaded.length + skipped + failed.length < total,
  )
  return uploaded
}

/** The files a drop carries, with whether each is a folder, which only the drop can tell. */
export function droppedFiles(data: DataTransfer): Incoming[] {
  const items = [...data.items].filter((item) => item.kind === 'file')
  if (items.length === 0) return [...data.files].map((file) => ({ file, folder: false }))
  return items.flatMap((item) => {
    const file = item.getAsFile()
    return file ? [{ file, folder: item.webkitGetAsEntry()?.isDirectory ?? false }] : []
  })
}

/** Whether a drag carries files from outside the page. */
const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')

/**
 * Takes files dragged in from the file manager: `folderAt` names the folder under the pointer,
 * which `over` holds while they hover, and `onDrop` gets them with it. Drag events fire on each
 * element the pointer crosses, so a count of entries tells when it has left.
 */
export function useUploadDrop(
  folderAt: (target: EventTarget | null) => string,
  onDrop: (folder: string, incoming: Incoming[]) => void,
) {
  const [over, setOver] = useState<string | null>(null)
  const depth = useRef(0)
  const take = (event: DragEvent) => {
    if (!carriesFiles(event)) return false
    event.preventDefault()
    event.stopPropagation()
    return true
  }
  return {
    over,
    handlers: {
      onDragEnter: (event: DragEvent) => {
        if (!take(event)) return
        depth.current += 1
        setOver(folderAt(event.target))
      },
      onDragOver: (event: DragEvent) => {
        if (!take(event)) return
        event.dataTransfer.dropEffect = 'copy'
        const folder = folderAt(event.target)
        if (folder !== over) setOver(folder)
      },
      onDragLeave: (event: DragEvent) => {
        if (!take(event)) return
        depth.current = Math.max(0, depth.current - 1)
        // A row the list unmounted under the pointer never says it was left.
        const to = event.relatedTarget
        const left = to instanceof Node && !event.currentTarget.contains(to)
        if (depth.current === 0 || left) {
          depth.current = 0
          setOver(null)
        }
      },
      onDrop: (event: DragEvent) => {
        if (!take(event)) return
        depth.current = 0
        setOver(null)
        const incoming = droppedFiles(event.dataTransfer)
        if (incoming.length > 0) onDrop(folderAt(event.target), incoming)
      },
    },
  }
}
