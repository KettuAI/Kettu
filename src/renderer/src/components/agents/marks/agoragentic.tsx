// Agoragentic mark: ACP Registry, https://github.com/agentclientprotocol/registry (Apache-2.0).
export const viewBox = '0 0 16 16'

/** The mark in `currentColor`, as the registry draws it. */
export function Body() {
  return (
    <>
      <g fill="none">
        <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M5.5 10.5L8 4L10.5 10.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <line
          x1="6.25"
          y1="8.75"
          x2="9.75"
          y2="8.75"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </g>
    </>
  )
}
