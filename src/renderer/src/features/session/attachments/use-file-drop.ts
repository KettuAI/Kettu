import { useRef, useState, type DragEvent } from 'react'
import { emitAppEvent } from '@renderer/app/events'

/** Whether a drag carries files, so dragging text into the box works as before. */
const carriesFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files')

/**
 * Files and folders dropped anywhere on a column go to the composer of `draft`, a session's or New
 * session's; null takes no drop. Drag events fire on each element the pointer crosses, so a count
 * of entries tells when it has left.
 */
export function useFileDrop(draft: string | null, starting: boolean) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  const leave = () => {
    depth.current = 0
    setOver(false)
  }
  if (!draft) return { over: false, handlers: {} }
  return {
    over,
    handlers: {
      onDragEnter: (event: DragEvent) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        depth.current += 1
        setOver(true)
      },
      onDragOver: (event: DragEvent) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = starting ? 'none' : 'copy'
      },
      onDragLeave: (event: DragEvent) => {
        if (!carriesFiles(event)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      },
      onDrop: (event: DragEvent) => {
        if (!carriesFiles(event)) return
        event.preventDefault()
        leave()
        if (starting) return
        emitAppEvent({ kind: 'drop-attachments', draft, files: [...event.dataTransfer.files] })
      },
    },
  }
}
