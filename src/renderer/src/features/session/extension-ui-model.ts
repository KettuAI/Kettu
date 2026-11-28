import type {
  ExtensionStatusView,
  ExtensionUiView,
  ExtensionWidgetPlacement,
  ExtensionWidgetView,
} from '@shared/thread'

const EMPTY_STATUSES: readonly ExtensionStatusView[] = []
const EMPTY_WIDGETS: readonly ExtensionWidgetView[] = []

/** Returns live extension status entries for a session view. */
export function extensionStatusesOf(
  ui: ExtensionUiView | null | undefined,
): readonly ExtensionStatusView[] {
  return ui && ui.statuses.length > 0 ? ui.statuses : EMPTY_STATUSES
}

/** Returns live extension text widgets matching a placement (`aboveEditor` or `belowEditor`). */
export function extensionWidgetsOf(
  ui: ExtensionUiView | null | undefined,
  placement: ExtensionWidgetPlacement,
): readonly ExtensionWidgetView[] {
  if (!ui || ui.widgets.length === 0) return EMPTY_WIDGETS
  const matched = ui.widgets.filter((widget) => widget.placement === placement)
  return matched.length > 0 ? matched : EMPTY_WIDGETS
}
