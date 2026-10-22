// The theme's manifest, typed by hand so the compiler does not infer a type for 450 KB of JSON.
declare module 'material-icon-theme/dist/material-icons.json' {
  type Names = Record<string, string>
  export const iconDefinitions: Record<string, { iconPath: string }>
  export const file: string
  export const folder: string
  export const folderExpanded: string
  export const fileNames: Names
  export const fileExtensions: Names
  export const folderNames: Names
  export const folderNamesExpanded: Names
  export const light: Partial<
    Record<'fileNames' | 'fileExtensions' | 'folderNames' | 'folderNamesExpanded', Names>
  >
}
