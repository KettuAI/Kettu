import type { MarkBodyProps } from './index'

// DeepAgents mark: https://github.com/langchain-ai/deepagents/blob/main/.github/images/logo-light.svg
// (MIT), Copyright (c) LangChain, Inc.
const FOLD =
  'M73.7371 42.5435V21.8158H52.3481L52.3482 22.3079C63.4288 22.5936 72.4574 31.6684 73.3601 42.5435H73.7371Z'
const PAGE =
  'M49.7646 21.816H24.729V64.0228C24.729 71.817 30.7399 76.6658 40.4175 76.6658H73.7482V45.8297H49.7646V21.816Z'

export const viewBox = '0 0 100 100'

export function Body({ mono }: MarkBodyProps) {
  if (mono) {
    return (
      <g fill="currentColor" transform="translate(50 50) scale(1.6) translate(-49.24 -49.24)">
        <path d={FOLD} />
        <path d={PAGE} />
      </g>
    )
  }
  return (
    <>
      <rect width="100" height="100" rx="20.0365" fill="var(--brand-deepagents-tile)" />
      <g fill="var(--brand-deepagents)">
        <path d={FOLD} />
        <path d={PAGE} />
      </g>
    </>
  )
}
