import AppKit
import SwiftUI

extension Color {
  /// A color written as `#rrggbb`; an unreadable one is white, so a mistake shows.
  init(hex: String) {
    var value: UInt64 = 0xFFFFFF
    let digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    if digits.count == 6 { Scanner(string: digits).scanHexInt64(&value) }
    self.init(
      .sRGB,
      red: Double((value >> 16) & 0xFF) / 255,
      green: Double((value >> 8) & 0xFF) / 255,
      blue: Double(value & 0xFF) / 255)
  }
}

/// The island's colors. It continues the hardware notch, so it is black in both color modes; the
/// signals take the dark theme's tokens, which the build reads from the renderer.
enum Theme {
  static func token(_ name: String) -> Color { Color(hex: tokenHex[name] ?? "#ffffff") }

  static let surface = Color.black
  static let card = Color(hex: "#1c1c1f")
  /// The session the expanded island leads with, a step above the panel.
  static let focusCard = Color(hex: "#121215")
  static let line = Color(hex: "#232327")
  static let track = Color(hex: "#2c2c30")
  static let cardHover = Color(hex: "#26262a")
  static let rowHover = Color(hex: "#151518")
  static let button = Color(hex: "#2a2a2e")
  static let buttonHover = Color(hex: "#333338")
  static let primaryButton = Color(hex: "#f5f5f7")
  static let text = Color(hex: "#f2f2f7")
  static let quote = Color(hex: "#c7c7cc")
  static let secondary = Color(hex: "#8e8e93")
  static let tertiary = Color(hex: "#6e6e76")
  static let faint = Color(hex: "#48484e")

  static var attentionDot: Color { token("attention-dot") }
  static var attention: Color { token("attention") }
  static var danger: Color { token("danger") }
  static var success: Color { token("success") }
  static var warning: Color { token("warning") }
  static var usageRed: Color { token("usage-red") }
  static var usageGreen: Color { token("usage-green") }
  static var turnDots: NSColor { NSColor(Color(hex: tokenHex["send"] ?? "#f2581b")) }
  static var unread: Color { token("shell-accent") }
  static var running: Color { token("shell-accent") }
  static var planDone: Color { token("success") }
  static var merged: Color { token("merged") }
  static let chip = Color(hex: "#232327")

}

/// Sizes in points, from the hi-fi.
enum Metrics {
  static let shoulder: CGFloat = 7
  static let collapsedRadius: CGFloat = 12
  static let grownWidth: CGFloat = 380
  /// The grown island's text under the band of its marks and state.
  static let grownBody: CGFloat = 44
  static let grownRadius: CGFloat = 20
  static let openWidth: CGFloat = 460
  /// The panel's wings beside the notch, together.
  static let openWings: CGFloat = 260
  static let openRadius: CGFloat = 28
  static let wingMark: CGFloat = 18
  static let markOverlap: CGFloat = 5
  static let wingMin: CGFloat = 30
  static let maxHeightShare: CGFloat = 0.7
  /// Room around the island inside its window, for the shoulders and the shadow.
  static let margin: CGFloat = 28
  /// The height of the island's top band on a screen without a notch whose menu bar hides itself.
  static let bandHeight: CGFloat = 32
  /// The sessions the expanded list shows before it folds the rest into one line.
  static let listRows = 6
  /// Up to this many sessions, each row takes a second line.
  static let twoLineRows = 4
  /// The middle of the collapsed island where no notch is in the way, which holds the title.
  static let plainMiddle: CGFloat = 185
}

enum Fonts {
  static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight)
  }
  static func mono(_ size: CGFloat) -> Font { .system(size: size, design: .monospaced) }
}
