// Nova mark: ACP Registry, https://github.com/agentclientprotocol/registry (Apache-2.0).
export const viewBox = '0 0 16 16'

/** The mark in `currentColor`, as the registry draws it. */
export function Body() {
  return (
    <>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1" />
      <circle
        cx="8"
        cy="8"
        r="4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.3"
        opacity="0.5"
      />
      <line
        x1="8"
        y1="8"
        x2="13.5"
        y2="13.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <polygon points="14.5,14.5 12.3,13.5 13.5,12.3" fill="currentColor" />
      <line
        x1="8"
        y1="8"
        x2="2.5"
        y2="2.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <polygon points="1.5,1.5 3.7,2.5 2.5,3.7" fill="currentColor" />
      <circle cx="8" cy="8" r="1.3" fill="currentColor" />
      <circle
        cx="8"
        cy="8"
        r="0.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="0.5"
        opacity="0.7"
      />
    </>
  )
}
