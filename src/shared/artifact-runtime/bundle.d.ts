// The page runtime as one script, which tools/build/page-runtime.ts bundles at build time.
declare module 'virtual:kettu-page-runtime' {
  const script: string
  export default script
}
