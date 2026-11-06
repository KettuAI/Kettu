import { composerCss, css as startCss } from '@renderer/components/affect/assistant-home'

/** The tray and its links as affectUI's start screen draws them, for the composer's last row. */
export function TrayStyles() {
  return (
    <style href="ui-screen-composer" precedence="default">
      {composerCss}
    </style>
  )
}

/** affectUI's start screen: the greeting and the composer in the middle of the main area. */
export function StartStyles() {
  return (
    <style href="ui-screen-assistant-home" precedence="default">
      {startCss}
    </style>
  )
}
