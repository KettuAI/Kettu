import 'streamdown/styles.css'
import { memo } from 'react'
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

/** Agent prose: streaming mode while text arrives, static afterwards. Raw HTML never renders. */
function MarkdownImpl({
  markdown,
  streaming = false,
  className,
}: {
  markdown: string
  streaming?: boolean
  className?: string
}) {
  return (
    <Streamdown
      mode={streaming ? 'streaming' : 'static'}
      parseIncompleteMarkdown={streaming}
      isAnimating={streaming}
      skipHtml
      plugins={plugins}
      components={components}
      linkSafety={linkSafety}
      controls={{
        code: { copy: true, download: false },
        table: { copy: true, download: false, fullscreen: false },
        mermaid: false,
      }}
      codeBlockMaxHeight={480}
      lineNumbers={false}
      className={cn('markdown', className)}
    >
      {markdown}
    </Streamdown>
  )
}

export default memo(MarkdownImpl)
