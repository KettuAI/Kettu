// VT Code mark: ACP Registry, https://github.com/agentclientprotocol/registry (Apache-2.0).
export const viewBox = '0 0 16 16'

/** The mark in `currentColor`, at every size. */
export function Body() {
  return (
    <>
      <path
        d="M0.5 5.5L2.5 8 0.5 10.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <text
        x="3.2"
        y="11.5"
        fontFamily="'SF Mono', 'Fira Code', 'Consolas', monospace"
        fontSize={10}
        fontWeight={600}
        letterSpacing="-0.5"
        fill="currentColor"
      >
        VT
      </text>
    </>
  )
}
