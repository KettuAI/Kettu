import { useState } from 'react'
import {
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  FileDiffIcon,
  GitBranchIcon,
  GitPullRequestCreateArrowIcon,
  RefreshCwIcon,
} from 'lucide-react'
import type { GitStatus, PullRequest } from '@shared/git'
import { Button, buttonVariants } from '@renderer/components/ui/button'
import { Separator } from '@renderer/components/ui/separator'
import { Spinner } from '@renderer/components/ui/spinner'
import { longAgo, plural, shortAgo } from '@renderer/lib/format'
import { errorMessage, host } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { cn } from '@renderer/lib/utils'
import { receiveGitStatus, useGitStore } from '@renderer/stores/git'
import { BranchLane } from './branch-lane'
import { PrDetails } from './pr-chip'

export function BranchPopover({ status, pr }: { status: GitStatus; pr: PullRequest | null }) {
  const now = useNow()
  const tools = useGitStore((s) => s.tools)
  const [commitsShown, setCommitsShown] = useState(5)
  const { head, upstream, base, changes, commits } = status
  const branch = head.detached ? (head.oid?.slice(0, 7) ?? 'HEAD') : (head.branch ?? 'HEAD')
  const unpushed = commits.filter((c) => !c.pushed).length
  const pushed = commits.length - unpushed
  const dirty = changes.staged + changes.unstaged + changes.untracked + changes.conflicted > 0
  const files = changes.staged + changes.unstaged + changes.untracked
  const rest = [
    changes.staged ? `${changes.staged} staged` : null,
    changes.untracked ? `${changes.untracked} new` : null,
    changes.conflicted ? plural(changes.conflicted, 'conflict') : null,
  ].filter(Boolean)
  const github = status.remote?.github

  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 px-3.5 pt-3 pb-2.5">
        <div className="flex flex-col gap-[3px]">
          <div className="flex items-center gap-2">
            <GitBranchIcon className="size-[15px] shrink-0" />
            <span
              className="min-w-0 flex-1 font-mono text-[12.5px] font-medium [overflow-wrap:anywhere]"
              data-selectable=""
            >
              {branch}
            </span>
            <CopyButton text={branch} label="Copy branch name" />
          </div>
          {(base || upstream) && (
            <span className="pl-[23px] text-xs text-muted-foreground">
              {base && head.branch !== base.name && (
                <>
                  from <span className="font-mono text-[11.5px]">{shortRef(base.name)}</span>
                </>
              )}
              {base && head.branch !== base.name && (upstream || !head.detached) && ' · '}
              {upstream ? (
                <>
                  tracking <span className="font-mono text-[11.5px]">{upstream.name}</span>
                </>
              ) : (
                !head.detached && 'not published'
              )}
            </span>
          )}
        </div>

        {base && commits.length > 0 && head.branch !== base.name && (
          <BranchLane
            base={shortRef(base.name)}
            pushed={upstream ? pushed : 0}
            unpushed={upstream ? unpushed : commits.length}
            behind={base.behind}
            dirty={dirty}
            upstream={!!upstream}
          />
        )}

        {commits.length > 0 && (
          <ul className={cn('flex flex-col', commitsShown > 5 && 'max-h-[240px] overflow-y-auto')}>
            {commits.slice(0, commitsShown).map((c) => (
              <li key={c.oid} className="flex h-6 items-center gap-2.5 text-xs">
                <span className="w-[54px] shrink-0 font-mono text-[11.5px] text-muted-foreground">
                  {c.oid.slice(0, 7)}
                </span>
                <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                {!c.pushed && upstream && (
                  <ArrowUpIcon
                    role="img"
                    aria-label="Not pushed"
                    strokeWidth={2}
                    className="size-3 shrink-0"
                  />
                )}
                <span className="w-6 shrink-0 text-right text-muted-foreground tabular">
                  {shortAgo(c.authoredAt * 1000, now)}
                </span>
              </li>
            ))}
            {commits.length > commitsShown && (
              <li>
                <Button
                  variant="quiet"
                  size="xs"
                  className="-ml-2 h-6"
                  onClick={() => setCommitsShown(20)}
                >
                  {commits.length - commitsShown} more
                </Button>
              </li>
            )}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground tabular">
          <FileDiffIcon className="size-[13px]" />
          {files || changes.conflicted ? (
            <>
              <span className="text-foreground">{plural(files, 'file')} changed</span>
              {(changes.insertions > 0 || changes.deletions > 0) && (
                <span className="font-mono text-[11.5px]">
                  <span className="text-success">+{changes.insertions}</span>{' '}
                  <span className="text-destructive">−{changes.deletions}</span>
                </span>
              )}
              {rest.length > 0 && <span>{rest.join(' · ')}</span>}
            </>
          ) : (
            <span>No changes in the working tree</span>
          )}
        </div>
      </div>

      <Separator className="bg-border-soft" />
      <PullRequestPart status={status} pr={pr} tools={tools} github={!!github} />
      <Separator className="bg-border-soft" />

      <FetchFooter status={status} />
    </div>
  )
}

function PullRequestPart({
  status,
  pr,
  tools,
  github,
}: {
  status: GitStatus
  pr: PullRequest | null
  tools: ReturnType<typeof useGitStore.getState>['tools']
  github: boolean
}) {
  if (!github) return null
  if (tools?.gh.state === 'not-installed') {
    return (
      <p className="px-3.5 py-3 text-xs text-muted-foreground">
        Install the{' '}
        <a
          href="https://cli.github.com"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          GitHub CLI
        </a>{' '}
        to see pull requests.
      </p>
    )
  }
  if (tools?.gh.state === 'signed-out') {
    return (
      <div className="flex items-center gap-2 px-3.5 py-2.5 text-xs text-muted-foreground">
        <span className="flex-1">Sign in to the GitHub CLI to see pull requests:</span>
        <code className="rounded-[5px] bg-muted px-1.5 py-0.5 font-mono text-[11.5px] text-foreground">
          gh auth login
        </code>
        <CopyButton text="gh auth login" label="Copy command" />
      </div>
    )
  }
  if (pr) {
    return (
      <div className="px-3.5 py-3">
        <PrDetails pr={pr} />
      </div>
    )
  }
  const remote = status.remote?.github
  if (status.upstream && status.head.branch && remote) {
    const compare = `https://github.com/${remote.owner}/${remote.repo}/compare/${encodeURIComponent(status.head.branch)}?expand=1`
    return (
      <div className="flex items-center gap-2 py-2 pr-2 pl-3.5 text-xs text-muted-foreground">
        <span className="flex-1">No pull request for this branch.</span>
        <a
          href={compare}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: 'quiet', size: 'xs' })}
        >
          <GitPullRequestCreateArrowIcon data-icon="inline-start" />
          Create pull request
        </a>
      </div>
    )
  }
  return null
}

function FetchFooter({ status }: { status: GitStatus }) {
  const now = useNow()
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetch = async () => {
    setFetching(true)
    setError(null)
    try {
      receiveGitStatus(await host('git.fetch', { projectPath: status.projectPath }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setFetching(false)
    }
  }
  return (
    <div className="flex min-h-10 items-center gap-1.5 py-1 pr-2 pl-3.5 text-xs text-muted-foreground">
      <span
        className={cn('min-w-0 flex-1', error && 'text-destructive')}
        title={error ?? undefined}
      >
        {error
          ? error.split('\n')[0]
          : status.lastFetchedAt
            ? `Fetched ${longAgo(status.lastFetchedAt, now)}`
            : status.remote
              ? 'Never fetched'
              : 'No remote'}
      </span>
      {status.remote && (
        <Button variant="quiet" size="xs" disabled={fetching} onClick={() => void fetch()}>
          {fetching ? (
            <Spinner data-icon="inline-start" className="size-3" />
          ) : (
            <RefreshCwIcon data-icon="inline-start" />
          )}
          Fetch
        </Button>
      )}
    </div>
  )
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="quiet"
      size="icon-xs"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className="shrink-0 rounded-[6px]"
    >
      {copied ? (
        <CheckIcon className="size-3.5 animate-in text-success animation-duration-(--duration-fast) fade-in zoom-in-75" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </Button>
  )
}

function shortRef(name: string): string {
  return name.replace(/^refs\/remotes\//, '').replace(/^refs\/heads\//, '')
}
