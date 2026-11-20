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
}

/// Sizes in points, from the hi-fi.
enum Metrics {
  static let shoulder: CGFloat = 7
  static let collapsedRadius: CGFloat = 12
  static let grownWidth: CGFloat = 400
  static let grownBody: CGFloat = 56
  static let grownRadius: CGFloat = 26
  static let openWidth: CGFloat = 520
  static let openRadius: CGFloat = 28
  static let wingMark: CGFloat = 18
  static let markOverlap: CGFloat = 5
  static let wingMin: CGFloat = 30
  static let maxHeightShare: CGFloat = 0.7
  /// Room around the island inside its window, for the shoulders and the shadow.
  static let margin: CGFloat = 28
  /// The gap a floating island keeps between its wings, where a notch would be.
  static let floatingGap: CGFloat = 24
}

enum Fonts {
  static func ui(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight)
  }
  static func mono(_ size: CGFloat) -> Font { .system(size: size, design: .monospaced) }
}
