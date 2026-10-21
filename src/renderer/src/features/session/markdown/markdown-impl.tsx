import 'streamdown/styles.css'
import { memo, useDeferredValue } from 'react'
import { cjk } from '@streamdown/cjk'
import { createCodePlugin } from '@streamdown/code'
import {
  defaultComponents,
  Streamdown,
  type Components,
  type LinkSafetyModalProps,
} from 'streamdown'
import { GITHUB_PULL_REQUEST_URL } from '@shared/git'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { PrChip } from '@renderer/features/git/pr-chip'
import { cn } from '@renderer/lib/utils'

const plugins = {
  code: createCodePlugin({ themes: ['github-light-default', 'github-dark-default'] }),
  cjk,
}

const DefaultLink = defaultComponents.a

const components: Components = {
  a: (props) => {
    const href = typeof props.href === 'string' ? props.href : ''
    if (GITHUB_PULL_REQUEST_URL.test(href)) return <PrChip url={href} />
    return <DefaultLink {...props} />
  },
}

function LinkConfirm({ isOpen, onClose, onConfirm, url }: LinkSafetyModalProps) {
  return (
    <AlertDialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Open this link?</AlertDialogTitle>
          <AlertDialogDescription className="font-mono text-xs break-all" data-selectable="">
            {url}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Open in browser</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

const linkSafety = {
  enabled: true,
  renderModal: (props: LinkSafetyModalProps) => <LinkConfirm {...props} />,
}

// Module constants: Streamdown's context depends on these, and a new object per render would
// re-render every code block and table on each streamed chunk.
const controls = {
  code: { copy: true, download: false },
  table: { copy: true, download: false, fullscreen: false },
  mermaid: false,
}

/**
 * Agent prose. Raw HTML never renders. Streaming mode splits the text into memoized blocks, and
 * the mode never changes: static mode renders one tree, so switching when a message finishes
 * would rebuild all of it. Finishing only turns off incomplete-markdown repair and the caret.
 */
function MarkdownImpl({
  markdown,
  streaming = false,
  className,
}: {
  markdown: string
  streaming?: boolean
  className?: string
}) {
  // Finishing re-renders every code block and table to enable their controls; deferring it lets
  // React split that work across frames instead of blocking one.
  const live = useDeferredValue(streaming)
  return (
    <Streamdown
      mode="streaming"
      parseIncompleteMarkdown={live}
      isAnimating={live}
      skipHtml
      plugins={plugins}
      components={components}
      linkSafety={linkSafety}
      controls={controls}
      codeBlockMaxHeight={480}
      lineNumbers={false}
      className={cn('markdown', className)}
    >
      {markdown}
    </Streamdown>
  )
}

export default memo(MarkdownImpl)
