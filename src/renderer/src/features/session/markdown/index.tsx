import { lazy, Suspense } from 'react'
import { cn } from '@renderer/lib/utils'
import { loadedMarkdown, loadMarkdown } from './preload'

const MarkdownImpl = lazy(loadMarkdown)
const DiffImpl = lazy(() => import('./diff-impl'))

interface MarkdownProps {
  markdown: string
  streaming?: boolean
  className?: string
}

/** Streamdown, loaded the first time a session shows prose; until then the plain text. */
export function Markdown(props: MarkdownProps) {
  const Loaded = loadedMarkdown()
  // The loaded module's component is a singleton, so its identity never changes between renders.
  // eslint-disable-next-line react-hooks/static-components
  if (Loaded) return <Loaded {...props} />
  return (
    <Suspense
      fallback={
        <div className={cn('markdown whitespace-pre-wrap', props.className)}>{props.markdown}</div>
      }
    >
      <MarkdownImpl {...props} />
    </Suspense>
  )
}

export interface DiffProps {
  path: string
  oldText: string | null
  newText: string
  className?: string
}

/** One file's change in unified style, highlighted off the main thread. */
export function Diff(props: DiffProps) {
  return (
    <Suspense fallback={<div className="h-16" />}>
      <DiffImpl {...props} />
    </Suspense>
  )
}
