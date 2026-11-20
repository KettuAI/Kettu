import AppKit
import SwiftUI

/// An agent's mark from the renderer's SVG, with an added agent's dot as the window draws it.
enum MarkImages {
  private static var cache: [String: NSImage] = [:]

  static func image(_ harness: String) -> NSImage? {
    if let hit = cache[harness] { return hit }
    guard let svg = markSVG[harness], let image = NSImage(data: Data(svg.utf8)), image.isValid
    else { return nil }
    cache[harness] = image
    return image
  }
}

struct MarkView: View {
  let agent: IslandAgent
  let size: CGFloat

  var body: some View {
    ZStack(alignment: .bottomTrailing) {
      Group {
        if let image = MarkImages.image(agent.harness) {
          Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
        } else {
          // A mark the system cannot draw: the agent's initial on a tile.
          RoundedRectangle(cornerRadius: size * 0.28, style: .continuous)
            .fill(Theme.card)
            .overlay(
              Text(String(agent.name.prefix(1)).uppercased())
                .font(Fonts.ui(size * 0.55, .semibold))
                .foregroundColor(Theme.text))
        }
      }
      .frame(width: size, height: size)
      if let name = agent.color, let hex = agentDotHex[name] {
        // The renderer's proportions: a quarter of the mark, ringed in the surface.
        let diameter = max(3, min(7, (size / 4).rounded()))
        let ring = min(1.5, diameter / 4)
        Circle()
          .fill(Color(hex: hex))
          .frame(width: diameter, height: diameter)
          .background(
            Circle().fill(Theme.surface).frame(
              width: diameter + 2 * ring, height: diameter + 2 * ring)
          )
          .offset(x: ring, y: ring)
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// Up to three marks, the first in front, each ringed in black where they overlap.
struct MarkStack: View {
  let agents: [IslandAgent]
  var size: CGFloat = Metrics.wingMark

  var body: some View {
    HStack(spacing: -(Metrics.markOverlap + 4)) {
      ForEach(Array(agents.prefix(3).enumerated()), id: \.offset) { index, agent in
        MarkView(agent: agent, size: size)
          .padding(2)
          .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.surface))
          .zIndex(Double(3 - index))
      }
    }
  }
}

/// The running turn's nine dots, with the renderer's patterns: every dot only changes its opacity,
/// on its own offset into the loop. Core Animation runs them, so the helper itself stays idle.
struct TurnDots: NSViewRepresentable {
  enum Pattern: Equatable {
    case chase
    case think
  }

  let pattern: Pattern
  var size: CGFloat = 12
  let reduceMotion: Bool

  func makeNSView(context: Context) -> DotsView { DotsView() }

  func updateNSView(_ view: DotsView, context: Context) {
    view.configure(pattern: pattern, size: size, reduceMotion: reduceMotion)
  }

  func sizeThatFits(_ proposal: ProposedViewSize, nsView: DotsView, context: Context) -> CGSize? {
    CGSize(width: size, height: size)
  }
}

final class DotsView: NSView {
  private var shown: (TurnDots.Pattern, CGFloat, Bool)?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
  }

  required init?(coder: NSCoder) { nil }

  override var isFlipped: Bool { true }

  // Each dot's place on the ring, clockwise from the top left by row; the centre is not on it.
  private static let ring = [0, 1, 2, 7, -1, 3, 6, 5, 4]
  // When in the loop each dot twinkles, scattered so no order shows.
  private static let twinkle = [0, 0.53, 0.21, 0.78, 0.37, 0.91, 0.12, 0.66, 0.45]

  private struct Loop {
    let duration: Double
    let keyTimes: [Double]
    let values: [Double]
    let easeInOut: Bool
  }

  private static let trail = Loop(
    duration: 0.96, keyTimes: [0, 0.4, 1], values: [1, 0.22, 0.22], easeInOut: false)
  private static let twinkling = Loop(
    duration: 2.0, keyTimes: [0, 0.15, 0.3, 1], values: [0.22, 1, 0.22, 0.22], easeInOut: true)

  /// Where in its loop a dot starts, from 0 to 1, or nil for a still dot.
  private static func phase(_ pattern: TurnDots.Pattern, _ index: Int) -> Double? {
    switch pattern {
    case .chase:
      let place = ring[index]
      return place < 0 ? nil : (1 - Double(place) / 8).truncatingRemainder(dividingBy: 1)
    case .think:
      return twinkle[index]
    }
  }

  private static func value(_ loop: Loop, at phase: Double) -> Double {
    for i in 1..<loop.keyTimes.count where phase <= loop.keyTimes[i] {
      let t0 = loop.keyTimes[i - 1]
      let t1 = loop.keyTimes[i]
      let f = t1 > t0 ? (phase - t0) / (t1 - t0) : 0
      return loop.values[i - 1] + (loop.values[i] - loop.values[i - 1]) * f
    }
    return loop.values.last ?? 0.22
  }

  func configure(pattern: TurnDots.Pattern, size: CGFloat, reduceMotion: Bool) {
    if let shown, shown.0 == pattern, shown.1 == size, shown.2 == reduceMotion { return }
    shown = (pattern, size, reduceMotion)
    for dot in layer?.sublayers ?? [] { dot.removeFromSuperlayer() }
    let unit = size / 12
    let loop = pattern == .chase ? Self.trail : Self.twinkling
    for index in 0..<9 {
      let x = index % 3
      let y = index / 3
      let dot = CALayer()
      let radius = 1.4 * unit
      dot.frame = CGRect(
        x: (2 + CGFloat(x) * 4) * unit - radius, y: (2 + CGFloat(y) * 4) * unit - radius,
        width: radius * 2, height: radius * 2)
      dot.cornerRadius = radius
      dot.backgroundColor = Theme.turnDots.cgColor
      dot.opacity = 0.22
      if let phase = Self.phase(pattern, index) {
        if reduceMotion {
          // Reduce motion holds the frame the loop starts on, as the window does.
          dot.opacity = Float(Self.value(loop, at: phase))
        } else {
          let animation = CAKeyframeAnimation(keyPath: "opacity")
          animation.values = loop.values
          animation.keyTimes = loop.keyTimes.map { NSNumber(value: $0) }
          animation.duration = loop.duration
          animation.repeatCount = .infinity
          animation.timeOffset = phase * loop.duration
          animation.calculationMode = .linear
          if loop.easeInOut {
            animation.timingFunctions = Array(
              repeating: CAMediaTimingFunction(name: .easeInEaseOut), count: loop.values.count - 1)
          }
          animation.isRemovedOnCompletion = false
          dot.add(animation, forKey: "opacity")
        }
      }
      layer?.addSublayer(dot)
    }
  }
}

struct WaitingDot: View {
  var size: CGFloat = 8

  var body: some View {
    Circle()
      .fill(Theme.attentionDot)
      .frame(width: size, height: size)
      .background(
        Circle().fill(Theme.attentionDot.opacity(0.24)).frame(width: size + 6, height: size + 6)
      )
      .frame(width: 14, height: 14)
  }
}

struct LimitRing: View {
  var size: CGFloat = 13

  var body: some View {
    ZStack {
      Circle().fill(Theme.usageRed.opacity(0.22))
      Circle().stroke(Theme.usageRed, lineWidth: size * 0.17).padding(size * 0.15)
    }
    .frame(width: size, height: size)
  }
}

/// A status as one small signal: the sidebar's, plus a clock for stuck and a ring for a used-up
/// plan limit.
enum Signal: Equatable {
  case waiting
  case failed
  case running(TurnDots.Pattern)
  case stuck
  case limited
  case unread
}

struct SignalView: View {
  let signal: Signal
  var size: CGFloat = 14
  let reduceMotion: Bool

  var body: some View {
    switch signal {
    case .waiting:
      WaitingDot(size: size >= 14 ? 8 : 7)
    case .failed:
      Image(systemName: "exclamationmark.triangle")
        .font(.system(size: size - 2, weight: .medium))
        .foregroundColor(Theme.danger)
        .frame(width: size, height: size)
    case .running(let pattern):
      TurnDots(pattern: pattern, size: 12, reduceMotion: reduceMotion)
        .frame(width: size, height: size)
    case .stuck:
      Image(systemName: "clock")
        .font(.system(size: size - 2, weight: .medium))
        .foregroundColor(Theme.warning)
        .frame(width: size, height: size)
    case .limited:
      LimitRing(size: size - 1)
        .frame(width: size, height: size)
    case .unread:
      let dot: CGFloat = size >= 14 ? 8 : 6
      Circle().fill(Theme.unread).frame(width: dot, height: dot).frame(width: size, height: size)
    }
  }
}
