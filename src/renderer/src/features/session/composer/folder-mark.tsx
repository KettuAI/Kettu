/**
 * A project that is not open: the start screen's blue folder with its front shut over its tab, as
 * the sidebar draws closed projects.
 */
export function FolderClosedMark() {
  return (
    <svg className="ui-as-tray-link__folder kettu-folder" viewBox="0 0 67 67" aria-hidden>
      <path
        className="kettu-folder__tab"
        d="M11.17 15.35v15.36h44.67v-6.98c0-3.86-3.13-6.98-6.98-6.98H33.5l-3.93-5.89a5.58 5.58 0 0 0-4.64-2.49h-6.78c-3.86 0-6.98 3.13-6.98 6.98Z"
      />
      <path
        className="kettu-folder__tab-edge"
        d="M33.5 16.75l-3.93-5.89a5.58 5.58 0 0 0-4.64-2.49h-6.78c-3.86 0-6.98 3.13-6.98 6.98v15.36h44.67v-6.98c0-3.86-3.13-6.98-6.98-6.98H33.5Zm0 0h-9.77"
        strokeWidth="4.19"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        className="kettu-folder__front"
        d="M18.15 16.75h30.71c3.86 0 6.98 3.13 6.98 6.98v25.83c0 3.86-3.13 6.98-6.98 6.98H18.15c-3.86 0-6.98-3.13-6.98-6.98V23.73c0-3.86 3.13-6.98 6.98-6.98Z"
        strokeWidth="4.19"
        strokeLinejoin="round"
      />
    </svg>
  )
}
