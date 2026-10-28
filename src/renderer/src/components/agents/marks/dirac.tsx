// Dirac mark: ACP Registry, https://github.com/agentclientprotocol/registry (Apache-2.0).
export const viewBox = '0 0 16 16'

/** The mark in `currentColor`, as the registry draws it. */
export function Body() {
  return (
    <>
      <g fill="currentColor">
        <text
          x="8"
          y="10"
          textAnchor="middle"
          fontSize="10.5"
          fontFamily="Georgia, serif"
          fontStyle="italic"
          fill="currentColor"
        >
          &#948;
        </text>
        <line
          x1="1"
          y1="14"
          x2="15"
          y2="14"
          stroke="currentColor"
          strokeOpacity="0.4"
          strokeWidth="1"
          strokeLinecap="round"
        />
        <line
          x1="8"
          y1="14"
          x2="8"
          y2="12"
          stroke="currentColor"
          strokeWidth="1"
          strokeLinecap="round"
        />
        <circle cx="8" cy="11.5" r="0.7" fill="currentColor" />
      </g>
    </>
  )
}
