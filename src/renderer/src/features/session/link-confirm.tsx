import { Fragment, useRef, useState } from 'react'
import { ExternalLinkIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
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
import { addressParts, readableRest } from '@renderer/features/browser/address'
import { CopyButton } from '@renderer/features/git/copy-button'

/**
 * The address as the browser pane's field draws it, with a break before each separator and
 * escaped characters shown as characters. Rendered only while the dialog is open.
 */
function Address({ host, rest }: { host: string; rest: string }) {
  return (
    <p
      dir="ltr"
      data-selectable=""
      className="my-0.5 max-h-25 min-w-0 flex-1 overflow-y-auto text-ui leading-5 [overflow-wrap:anywhere]"
    >
      <span className="text-primary">{host}</span>
      <span className="text-tertiary">
        {readableRest(rest)
          .split(/(?=[/?#&=])/)
          .map((part, i) => (
            <Fragment key={i}>
              <wbr />
              {part}
            </Fragment>
          ))}
      </span>
    </p>
  )
}

/**
 * Asks before a web link opens in the default browser. The title names the host as the URL
 * parser reads it, so text before "@" or a look-alike host cannot pass for another site.
 */
export function LinkConfirm({
  url,
  isOpen,
  onClose,
  onConfirm,
}: {
  url: string
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation(['session', 'common'])
  const cancel = useRef<HTMLButtonElement>(null)
  const open = useRef<HTMLButtonElement>(null)
  const parsed = URL.parse(url)
  const parts = addressParts(url)
  if (!parsed || !parts) return null
  const userinfo = parsed.username !== '' || parsed.password !== ''
  return (
    <AlertDialog open={isOpen} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent initialFocus={userinfo ? cancel : open}>
        <AlertDialogHeader>
          <AlertDialogTitle className="[overflow-wrap:anywhere]">
            {t('link.title', { host: parts.host })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {userinfo ? t('link.userinfo') : t('link.opens')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-start gap-1 rounded-xl bg-subtle py-1.5 ps-3 pe-1.5">
          <Address host={parts.host} rest={parts.rest} />
          <CopyButton text={url} label={t('link.copy')} />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancel}>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            ref={open}
            onClick={() => {
              onConfirm()
              onClose()
            }}
          >
            {t('link.open')}
            <ExternalLinkIcon data-icon="inline-end" />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** A web address in plain text, such as a notice's, which opens through the confirmation. */
export function ConfirmedLink({ url }: { url: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        // The classes of a reply's link button, which Streamdown draws in medium weight.
        className="thread-link text-left font-medium [overflow-wrap:anywhere]"
      >
        {url}
      </button>
      <LinkConfirm
        url={url}
        isOpen={open}
        onClose={() => setOpen(false)}
        // As a reply's link opens: main hands it to the default browser.
        onConfirm={() => window.open(url, '_blank', 'noreferrer')}
      />
    </>
  )
}
