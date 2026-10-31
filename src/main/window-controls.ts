// Where the window controls sit, level with the renderer's chrome: its --top-bar and --title-bar in
// globals.css, which these must match.

// macOS: the top bar at the window's top edge.
const TOP_BAR_HEIGHT = 44
const TRAFFIC_LIGHTS_HEIGHT = 12
// Windows and Linux: the band of desk across the window's top, where the overlay draws the controls.
const TITLE_BAR_HEIGHT = 40

/**
 * The page zoom scales the top bar but not the traffic lights, so they move to stay level with the
 * bar's centre: { x: 20, y: 16 } at 100%. The renderer leaves them their unzoomed width
 * (--traffic-lights).
 */
export function trafficLightPosition(zoom: number): { x: number; y: number } {
  return {
    x: Math.round(20 * zoom),
    y: Math.round((TOP_BAR_HEIGHT / 2) * zoom - TRAFFIC_LIGHTS_HEIGHT / 2),
  }
}

/** The title bar overlay's height in window pixels: the band's, which the zoom scales. */
export function titleBarHeight(zoom: number): number {
  return Math.round(TITLE_BAR_HEIGHT * zoom)
}
