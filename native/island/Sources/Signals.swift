import AppKit
import SwiftUI

/// An agent's mark from the renderer's SVG, or the PNG Chromium drew of one CoreSVG cannot draw.
enum MarkImages {
  private static var cache: [String: NSImage] = [:]

  static func image(_ harness: String) -> NSImage? {
    if let hit = cache[harness] { return hit }
    let data =
      markPNG[harness].flatMap { Data(base64Encoded: $0) } ?? markSVG[harness].map { Data($0.utf8) }
    guard let data, let image = NSImage(data: data), image.isValid else { return nil }
    cache[harness] = image
    return image
  }

  /// CoreSVG's first drawing in a process takes about 45 ms; one done off the main thread at launch
  /// keeps it out of the island's first motion.
  static func warmUp() {
    guard let svg = markSVG.values.first else { return }
    DispatchQueue.global(qos: .userInitiated).async {
      guard let image = NSImage(data: Data(svg.utf8)),
        let rep = NSBitmapImageRep(
          bitmapDataPlanes: nil, pixelsWide: 16, pixelsHigh: 16, bitsPerSample: 8,
          samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
          bytesPerRow: 0, bitsPerPixel: 0)
      else { return }
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
      image.draw(in: NSRect(x: 0, y: 0, width: 16, height: 16))
      NSGraphicsContext.restoreGraphicsState()
    }
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

/// The running turn's nine dots, with the renderer's patterns for each phase: every dot only
/// changes its opacity, on its own offset into the loop. Core Animation runs them, so the helper
/// itself stays idle.
struct TurnDots: NSViewRepresentable {
  enum Pattern: String, Equatable {
    case chase, think, read, search, edit, fetch, compact, write

    /// The pattern of a phase main names; anything else runs the default chase.
    init(phase: String?) {
      switch phase {
      case "think": self = .think
      case "read": self = .read
      case "search": self = .search
      case "edit": self = .edit
      case "fetch": self = .fetch
      case "compact": self = .compact
      case "write": self = .write
      default: self = .chase
      }
    }
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

  /// One of the renderer's keyframes: opacity at each point of the loop.
  private struct Keys {
    let times: [Double]
    let values: [Double]
  }

  private static let trail = Keys(times: [0, 0.4, 1], values: [1, 0.22, 0.22])
  private static let twinkle = Keys(times: [0, 0.15, 0.3, 1], values: [0.22, 1, 0.22, 0.22])
  private static let swap = Keys(times: [0, 0.5, 1], values: [0.22, 1, 0.22])
  private static let sweepEdge = Keys(
    times: [0, 0.125, 0.25, 0.75, 0.875, 1], values: [1, 0.74, 0.22, 0.22, 0.74, 1])
  private static let sweepMid = Keys(
    times: [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875, 1],
    values: [0.22, 0.36, 1, 0.36, 0.22, 0.36, 1, 0.36, 0.22])
  private static let fill = Keys(times: [0, 0.55, 0.62, 1], values: [1, 1, 0.22, 0.22])

  // Each dot's place on the ring, clockwise from the top left by row; the centre is not on it.
  private static let ring = [0, 1, 2, 7, -1, 3, 6, 5, 4]
  // When in the loop each dot twinkles, scattered so no order shows.
  private static let twinkles = [0, 0.53, 0.21, 0.78, 0.37, 0.91, 0.12, 0.66, 0.45]

  /// A pattern's loop: its length, whether it eases, and each dot's keyframes and where in the
  /// loop it starts, from 0 to 1, or nil for a still dot. The renderer's turn-dot-patterns.
  private static func loop(_ pattern: TurnDots.Pattern) -> (
    seconds: Double, eases: Bool, dot: (Int, Int) -> (Keys, Double)?
  ) {
    let centre = { (x: Int, y: Int) in hypot(Double(x) - 1, Double(y) - 1) }
    switch pattern {
    case .chase:
      return (
        0.96, false,
        { x, y in
          let place = ring[y * 3 + x]
          return place < 0 ? nil : (trail, Double(place) / 8)
        }
      )
    case .think:
      return (2.0, true, { x, y in (twinkle, (1 - twinkles[y * 3 + x]).truncatingRemainder(dividingBy: 1)) })
    case .read:
      return (1.5, false, { x, y in (trail, (Double(y) * 1.2 + Double(x) * 0.3) / 3.6) })
    case .search:
      return (1.6, false, { x, _ in x == 1 ? (sweepMid, 0) : (sweepEdge, Double(x) / 4) })
    case .edit:
      return (1.4, true, { x, y in (swap, (x + y) % 2 == 1 ? 0.5 : 0) })
    case .fetch:
      return (1.2, false, { x, y in (trail, centre(x, y) / 2.6) })
    case .compact:
      return (1.2, false, { x, y in (trail, (2.0.squareRoot() - centre(x, y)) / 2.6) })
    case .write:
      return (1.8, false, { x, y in (fill, Double(y * 3 + x) * 0.05) })
    }
  }

  private static func value(_ keys: Keys, at phase: Double) -> Double {
    for i in 1..<keys.times.count where phase <= keys.times[i] {
      let t0 = keys.times[i - 1]
      let t1 = keys.times[i]
      let f = t1 > t0 ? (phase - t0) / (t1 - t0) : 0
      return keys.values[i - 1] + (keys.values[i] - keys.values[i - 1]) * f
    }
    return keys.values.last ?? 0.22
  }

  func configure(pattern: TurnDots.Pattern, size: CGFloat, reduceMotion: Bool) {
    if let shown, shown.0 == pattern, shown.1 == size, shown.2 == reduceMotion { return }
    shown = (pattern, size, reduceMotion)
    for dot in layer?.sublayers ?? [] { dot.removeFromSuperlayer() }
    let unit = size / 12
    let loop = Self.loop(pattern)
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
      if let (keys, at) = loop.dot(x, y) {
        // The renderer delays each dot by (at - 1) loops, which starts it this far into the loop.
        let start = (1 - at).truncatingRemainder(dividingBy: 1)
        if reduceMotion {
          // Reduce motion holds the frame the loop starts on, as the window does.
          dot.opacity = Float(Self.value(keys, at: start))
        } else {
          let animation = CAKeyframeAnimation(keyPath: "opacity")
          animation.values = keys.values
          animation.keyTimes = keys.times.map { NSNumber(value: $0) }
          animation.duration = loop.seconds
          animation.repeatCount = .infinity
          animation.timeOffset = start * loop.seconds
          animation.calculationMode = .linear
          if loop.eases {
            animation.timingFunctions = Array(
              repeating: CAMediaTimingFunction(name: .easeInEaseOut), count: keys.values.count - 1)
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

/// A faint ring with a quarter arc turning on it, as the sidebar draws a run in progress. Core
/// Animation turns it, so the helper itself stays idle.
struct SpinnerRing: NSViewRepresentable {
  var size: CGFloat = 9
  let reduceMotion: Bool

  func makeNSView(context: Context) -> SpinnerView { SpinnerView() }

  func updateNSView(_ view: SpinnerView, context: Context) {
    view.configure(size: size, reduceMotion: reduceMotion)
  }

  func sizeThatFits(_ proposal: ProposedViewSize, nsView: SpinnerView, context: Context) -> CGSize? {
    CGSize(width: size, height: size)
  }
}

final class SpinnerView: NSView {
  private var shown: (CGFloat, Bool)?

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
  }

  required init?(coder: NSCoder) { nil }

  func configure(size: CGFloat, reduceMotion: Bool) {
    if let shown, shown.0 == size, shown.1 == reduceMotion { return }
    shown = (size, reduceMotion)
    for layer in layer?.sublayers ?? [] { layer.removeFromSuperlayer() }
    let width = size * 0.14
    let radius = (size - width) / 2
    let center = CGPoint(x: size / 2, y: size / 2)
    let color = NSColor(Theme.secondary)
    let bounds = CGRect(x: 0, y: 0, width: size, height: size)

    let track = CAShapeLayer()
    track.frame = bounds
    track.path = CGPath(
      ellipseIn: CGRect(x: width / 2, y: width / 2, width: size - width, height: size - width),
      transform: nil)
    track.fillColor = nil
    track.strokeColor = color.withAlphaComponent(0.18).cgColor
    track.lineWidth = width

    // From the top to the right: the quarter turns clockwise, which is negative in this layer.
    let arc = CAShapeLayer()
    arc.frame = bounds
    let path = CGMutablePath()
    path.addArc(
      center: center, radius: radius, startAngle: .pi / 2, endAngle: 0, clockwise: true)
    arc.path = path
    arc.fillColor = nil
    arc.strokeColor = color.cgColor
    arc.lineWidth = width
    arc.lineCap = .round
    if !reduceMotion {
      let spin = CABasicAnimation(keyPath: "transform.rotation.z")
      spin.fromValue = 0
      spin.toValue = -2 * Double.pi
      spin.duration = 1
      spin.repeatCount = .infinity
      spin.isRemovedOnCompletion = false
      arc.add(spin, forKey: "spin")
    }
    layer?.addSublayer(track)
    layer?.addSublayer(arc)
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

/// A plan's progress as a ring, green for the steps done, as the session's plan chip draws it.
struct PlanRing: View {
  let done: Int
  let total: Int
  var size: CGFloat = 13

  var body: some View {
    let share = total > 0 ? CGFloat(done) / CGFloat(total) : 0
    ZStack {
      Circle().stroke(Theme.track, lineWidth: 2.2)
      Circle().trim(from: 0, to: share)
        .stroke(Theme.planDone, style: StrokeStyle(lineWidth: 2.2, lineCap: .round))
        .rotationEffect(.degrees(-90))
    }
    .padding(1.1)
    .frame(width: size, height: size)
  }
}
