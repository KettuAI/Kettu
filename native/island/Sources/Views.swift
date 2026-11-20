import AppKit
import SwiftUI

/// The island's outline: flat along the top, where two small concave shoulders meet the menu bar
/// or the notch, with round bottom corners.
struct IslandShape: Shape {
  var radius: CGFloat
  var shoulders = true

  var animatableData: CGFloat {
    get { radius }
    set { radius = newValue }
  }

  func path(in rect: CGRect) -> Path {
    let r = max(0, min(radius, rect.height / 2, rect.width / 2))
    let s = shoulders ? Metrics.shoulder : 0
    var p = Path()
    p.move(to: CGPoint(x: rect.minX - s, y: rect.minY))
    p.addLine(to: CGPoint(x: rect.maxX + s, y: rect.minY))
    p.addQuadCurve(
      to: CGPoint(x: rect.maxX, y: rect.minY + s), control: CGPoint(x: rect.maxX, y: rect.minY))
    p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - r))
    p.addArc(
      tangent1End: CGPoint(x: rect.maxX, y: rect.maxY),
      tangent2End: CGPoint(x: rect.maxX - r, y: rect.maxY), radius: r)
    p.addLine(to: CGPoint(x: rect.minX + r, y: rect.maxY))
    p.addArc(
      tangent1End: CGPoint(x: rect.minX, y: rect.maxY),
      tangent2End: CGPoint(x: rect.minX, y: rect.maxY - r), radius: r)
    p.addLine(to: CGPoint(x: rect.minX, y: rect.minY + s))
    p.addQuadCurve(
      to: CGPoint(x: rect.minX - s, y: rect.minY), control: CGPoint(x: rect.minX, y: rect.minY))
    p.closeSubpath()
    return p
  }
}

/// The content's change as the outline moves: the old leaves in 90 ms, the new comes in from
/// 6 pt below once the outline is a third of the way. Less motion keeps only the fade.
private func swap(_ reduceMotion: Bool) -> AnyTransition {
  let removal = AnyTransition.opacity.animation(.easeOut(duration: 0.09))
  if reduceMotion { return .asymmetric(insertion: .opacity.animation(.easeOut(duration: 0.15)), removal: removal) }
  return .asymmetric(
    insertion: .opacity.combined(with: .offset(y: 6))
      .animation(.easeOut(duration: 0.18).delay(0.1)),
    removal: removal)
}

struct IslandRoot: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    let size = model.frameSize()
    let radius = model.radius()
    VStack(spacing: 0) {
      ZStack(alignment: .top) {
        IslandShape(radius: radius)
          .fill(Theme.surface)
          .shadow(color: .black.opacity(model.mode == .open ? 0.35 : 0), radius: 18, y: 8)
        ZStack(alignment: .top) {
          switch model.mode {
          case .hidden:
            Color.clear
          case .collapsed:
            CollapsedContent(model: model).transition(swap(model.reduceMotion))
          case .grown:
            GrownContent(model: model).transition(swap(model.reduceMotion))
          case .open:
            PanelContent(model: model).transition(swap(model.reduceMotion))
          }
        }
        .frame(width: size.width, height: size.height, alignment: .top)
        .clipShape(IslandShape(radius: radius, shoulders: false))
      }
      .frame(width: size.width, height: size.height)
      .opacity(model.mode == .hidden ? 0 : 1)
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    // The panel laid out unseen before it opens, so the island grows to its height in one move.
    .overlay(alignment: .top) {
      if model.measuring && model.mode != .open {
        PanelBody(model: model)
          .padding(.horizontal, 10)
          .padding(.top, 2)
          .padding(.bottom, 8)
          .frame(width: model.openWidth)
          .fixedSize(horizontal: false, vertical: true)
          .background(
            GeometryReader { proxy in
              Color.clear
                .onAppear { model.setPanelHeight(proxy.size.height) }
                .onChange(of: proxy.size.height) { model.setPanelHeight($0) }
            }
          )
          .hidden()
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
    }
    .environment(\.colorScheme, .dark)
  }
}

extension IslandModel {
  var openWidth: CGFloat { max(Metrics.openWidth, geometry.notchWidth + 300) }

  /// The middle of the collapsed island: the notch, or where no notch is in the way the band the
  /// title sits in, so the island keeps one outline on every screen.
  var middleWidth: CGFloat { geometry.hasNotch ? geometry.notchWidth : Metrics.plainMiddle }

  /// The island's size in each mode. Collapsed, its two wings match so the middle stays centred
  /// and follow their content, so it never shows empty black.
  func frameSize() -> CGSize {
    let g = geometry
    switch mode {
    case .hidden:
      return CGSize(width: max(g.notchWidth, 1), height: g.notchHeight)
    case .collapsed:
      return CGSize(width: middleWidth + 2 * wing(), height: g.notchHeight)
    case .grown:
      return CGSize(
        width: max(Metrics.grownWidth, middleWidth + 160), height: g.notchHeight + Metrics.grownBody)
    case .open:
      let body = min(max(panelHeight, 60), g.maxHeight - g.notchHeight)
      return CGSize(width: openWidth, height: g.notchHeight + body)
    }
  }

  func radius() -> CGFloat {
    switch mode {
    case .hidden, .collapsed: return Metrics.collapsedRadius
    case .grown: return Metrics.grownRadius
    case .open: return Metrics.openRadius
    }
  }

  /// The collapsed island's wings: each side's content as laid out, plus its padding; both wings
  /// take the wider, so the middle stays centred.
  func wing() -> CGFloat {
    max(
      10 + (parts["left"] ?? Metrics.wingMark) + 8, 8 + (parts["right"] ?? 0) + 12, Metrics.wingMin)
  }
}

// MARK: Collapsed

/// The icon's shaded fox, which stands in for the marks while nothing needs one.
struct BrandFox: View {
  var size: CGFloat = Metrics.wingMark
  private static let image = NSImage(data: Data(brandFoxSVG.utf8))

  var body: some View {
    Group {
      if let image = Self.image {
        Image(nsImage: image).resizable().interpolation(.high).aspectRatio(contentMode: .fit)
      } else {
        Color.clear
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// A count on a small grey tile.
struct CountBadge: View {
  let count: Int

  var body: some View {
    Text("\(count)")
      .font(Fonts.ui(11.5, .semibold))
      .monospacedDigit()
      .foregroundColor(Theme.quote)
      .padding(.horizontal, 6)
      .frame(minWidth: 20, minHeight: 20)
      .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.button))
      .fixedSize()
  }
}

/// The marks of the group the island is about, or the fox.
struct LeadMarks: View {
  let collapsed: Collapsed?
  var size: CGFloat = Metrics.wingMark

  var body: some View {
    if let agents = collapsed?.agents, !agents.isEmpty {
      MarkStack(agents: agents, size: size)
    } else {
      BrandFox(size: size).padding(2)
    }
  }
}

/// The fact beside the signal: a count, the plan, the cache's time left or a word.
struct FactView: View {
  let fact: Fact

  var body: some View {
    switch fact {
    case .count(let count):
      CountBadge(count: count)
    case .plan(let done, let total):
      HStack(spacing: 5) {
        PlanRing(done: done, total: total, size: 13)
        Text("\(done)/\(total)")
      }
      .font(Fonts.ui(13, .semibold))
      .foregroundColor(Theme.text)
    case .cache(let text, let ending):
      HStack(spacing: 4) {
        Image(systemName: "timer").font(.system(size: 11, weight: .medium))
        Text(text)
      }
      .font(Fonts.ui(12, .semibold))
      .foregroundColor(ending ? Theme.warning : Theme.secondary)
    case .word(let text):
      Text(text).font(Fonts.ui(13, .semibold)).foregroundColor(Theme.text)
    }
  }
}

/// The signal and its fact, as the right of the collapsed island.
struct TrailingStatus: View {
  let collapsed: Collapsed?
  let reduceMotion: Bool

  var body: some View {
    HStack(spacing: 7) {
      if let signal = collapsed?.signal { SignalView(signal: signal, reduceMotion: reduceMotion) }
      if let fact = collapsed?.fact { FactView(fact: fact).monospacedDigit().lineLimit(1) }
    }
  }
}

struct CollapsedContent: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    let g = model.geometry
    let c = model.collapsed
    HStack(spacing: 0) {
      LeadMarks(collapsed: c).fixedSize().measured("left", model).padding(.leading, 10)
      Spacer(minLength: 8)
      Group {
        if !g.hasNotch, let title = c?.title {
          Text(title)
            .font(Fonts.ui(13, .medium))
            .foregroundColor(c?.signal == nil ? Theme.secondary : Theme.text)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 6)
        }
      }
      .frame(width: model.middleWidth)
      Spacer(minLength: 8)
      TrailingStatus(collapsed: c, reduceMotion: model.reduceMotion)
        .fixedSize()
        .measured("right", model)
        .padding(.trailing, 12)
    }
    .frame(height: g.notchHeight)
    .contentShape(Rectangle())
    .onTapGesture { model.expand(byClick: true) }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(model.islandLabel)
    .accessibilityAddTraits(.isButton)
  }
}

extension View {
  /// Reports this view's laid-out width to the model, which sizes the island by it.
  func measured(_ name: String, _ model: IslandModel) -> some View {
    background(
      GeometryReader { proxy in
        Color.clear
          .onAppear { model.setPart(name, proxy.size.width) }
          .onChange(of: proxy.size.width) { model.setPart(name, $0) }
      })
  }
}

extension IslandModel {
  var islandLabel: String {
    let summary = summaryText
    return text("a11y.island", ["summary": summary.isEmpty ? text("a11y.quiet") : summary])
  }
}

// MARK: Grown

struct Pill: View {
  let text: String
  let color: Color
  var dot = true

  var body: some View {
    HStack(spacing: 5) {
      if dot { Circle().fill(color).frame(width: 6, height: 6) }
      Text(text).font(Fonts.ui(11.5, .semibold)).lineLimit(1)
    }
    .foregroundColor(color)
    .padding(.horizontal, dot ? 9 : 7)
    .frame(height: 22)
    .background(Capsule().fill(color.opacity(0.16)))
    .fixedSize()
  }
}

extension IslandModel {
  func pill(for kind: String) -> (String, Color) {
    switch kind {
    case "permission": return (text("status.waiting"), Theme.attention)
    case "error": return (text("status.failed"), Theme.danger)
    case "routine-paused": return (text("paused"), Theme.warning)
    default: return (text("status.unread"), Theme.success)
    }
  }
}

/// A computer's name on a small tile, beside a title.
struct HostTag: View {
  let host: IslandHost
  let offline: String

  var body: some View {
    Text(host.offline ? "\(host.name) · \(offline)" : host.name)
      .font(Fonts.ui(10.5, .medium))
      .foregroundColor(Theme.secondary)
      .padding(.horizontal, 5)
      .padding(.vertical, 3)
      .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Theme.card))
      .lineLimit(1)
      .fixedSize()
  }
}

/// What popped out: the marks in the left wing and its state in the right, on the band beside the
/// notch, with the session and what happened on the lines under it, so no band stays empty.
struct GrownContent: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    let g = model.geometry
    VStack(alignment: .leading, spacing: 0) {
      if let pop = model.pop {
        let row = model.row(pop.row)
        let (label, color) = model.pill(for: pop.kind)
        HStack(spacing: 0) {
          Group {
            if let row { MarkView(agent: row.agent, size: g.hasNotch ? 20 : 17) } else {
              BrandFox(size: g.hasNotch ? 20 : 17)
            }
          }
          .padding(.leading, 14)
          Spacer(minLength: model.middleWidth)
          HStack(spacing: 6) {
            if model.queued > 0 { Pill(text: "+\(model.queued)", color: Theme.secondary, dot: false) }
            Pill(text: label, color: color)
          }
          .padding(.trailing, 10)
        }
        .frame(height: g.notchHeight)
        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: 5) {
            // The session's own title: the pop's is the notification's, which names its state too.
            (Text(row.map { model.title(of: $0) } ?? pop.title).foregroundColor(Theme.text)
              + Text(row.map { $0.project.isEmpty ? "" : " · \($0.project)" } ?? "")
              .foregroundColor(Theme.secondary).fontWeight(.medium))
              .font(Fonts.ui(13, .semibold))
              .lineLimit(1)
            if let host = row?.host { HostTag(host: host, offline: model.text("offline")) }
          }
          Text(pop.body).font(Fonts.ui(12)).foregroundColor(Theme.secondary).lineLimit(1)
        }
        .padding(.horizontal, 16)
        .padding(.top, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
      }
    }
    .frame(maxHeight: .infinity, alignment: .top)
    .contentShape(Rectangle())
    .onTapGesture { model.expand(byClick: true) }
  }
}

// MARK: Expanded

struct PanelContent: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    let g = model.geometry
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        LeadMarks(collapsed: model.collapsed)
        if let signal = model.collapsed?.signal {
          SignalView(signal: signal, reduceMotion: model.reduceMotion)
        }
        Spacer(minLength: model.middleWidth)
        Text(model.summaryText)
          .font(Fonts.ui(11.5, .medium))
          .foregroundColor(Theme.secondary)
          .lineLimit(1)
      }
      .padding(.leading, 10)
      .padding(.trailing, 16)
      .frame(height: g.notchHeight)
      .contentShape(Rectangle())
      // The bare top of the island opens Kettu itself.
      .onTapGesture { model.open(row: nil) }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(model.text("openKettu"))
      .accessibilityAddTraits(.isButton)
      ScrollView(.vertical) {
        PanelBody(model: model)
          .padding(.horizontal, 10)
          .padding(.top, 2)
          .padding(.bottom, 8)
          .background(
            GeometryReader { proxy in
              Color.clear
                .onAppear { model.setPanelHeight(proxy.size.height) }
                .onChange(of: proxy.size.height) { model.setPanelHeight($0) }
            })
      }
      .scrollIndicators(.never)
      .frame(height: max(0, model.frameSize().height - g.notchHeight))
    }
  }
}

/// While a request waits, the panel is that card alone, the one thing the user has to do; answered,
/// its word shows for a moment and the next card or the list follows. The list, from top to
/// bottom: the session the island is about, a few other sessions with the rest folded into one
/// line, the agents' plan limits, and the way to a new session or Kettu.
struct PanelBody: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let note = model.note {
        NoteView(note: note).padding(.vertical, 4)
      } else if let request = model.requests.first {
        RequestCard(model: model, request: request).padding(.vertical, 4)
      } else if model.rows.isEmpty {
        EmptyPanel(model: model)
        if !model.limits.isEmpty { UsageStrip(model: model) }
        PanelFooter(model: model)
      } else {
        if let focus = model.focusRow { FocusCard(model: model, row: focus) }
        let others = model.otherRows
        let shown = model.shownRows
        if !shown.isEmpty {
          HStack(spacing: 6) {
            Text(model.text("others"))
            Text("\(others.count)").foregroundColor(Theme.faint)
          }
          .font(Fonts.ui(11, .medium))
          .foregroundColor(Theme.tertiary)
          .padding(.horizontal, 10)
          .padding(.top, model.focusRow == nil ? 2 : 12)
          .padding(.bottom, 6)
          ForEach(shown, id: \.key) { row in OtherRow(model: model, row: row) }
          if others.count > shown.count {
            MoreRow(model: model, count: others.count - shown.count)
          }
        }
        if !model.limits.isEmpty { UsageStrip(model: model) }
        PanelFooter(model: model)
      }
    }
  }
}

/// The sessions past the list's few, folded into one line that opens Kettu.
struct MoreRow: View {
  @ObservedObject var model: IslandModel
  let count: Int
  @State private var hover = false

  var body: some View {
    HStack {
      Text(model.text("moreSessions", ["count": "\(count)"])).foregroundColor(Theme.secondary)
      Spacer(minLength: 8)
      Text(model.text("viewInKettu") + " ↗").foregroundColor(Theme.tertiary)
    }
    .font(Fonts.ui(12, .medium))
    .padding(.horizontal, 10)
    .frame(height: 30)
    .background(
      RoundedRectangle(cornerRadius: 9, style: .continuous)
        .fill(hover ? Theme.rowHover : Color.clear)
    )
    .contentShape(Rectangle())
    .onHover { hover = $0 }
    .onTapGesture { model.open(row: nil) }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isButton)
  }
}

struct EmptyPanel: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    VStack(spacing: 6) {
      BrandFox(size: 30)
      Text(model.text("empty.title")).font(Fonts.ui(13, .semibold)).foregroundColor(Theme.text)
      Text(model.text("empty.body")).font(Fonts.ui(12)).foregroundColor(Theme.secondary)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 18)
  }
}

extension IslandModel {
  /// How long until a time, as the duration strings write it; nil once it has passed.
  func until(_ ms: Double?) -> String? {
    guard let ms, ms > now.timeIntervalSince1970 * 1000 else { return nil }
    return short(since: 2 * now.timeIntervalSince1970 * 1000 - ms)
  }

  /// A length of time in ms, as the duration strings write it.
  func length(_ ms: Double) -> String? {
    duration(since: now.timeIntervalSince1970 * 1000 - ms)
  }

  /// What the focus card's second line says: what the session does, waits for or did.
  func line(of row: IslandRow) -> String {
    switch status(of: row) {
    case "stuck":
      let time = duration(since: row.toolSince) ?? ""
      return [text("stuck", ["time": time]), row.line].filter { !$0.isEmpty }.joined(
        separator: " · ")
    case "unread":
      if let ms = focus?.turnMs, let time = length(ms) { return text("doneIn", ["time": time]) }
      return row.line
    case "limited":
      guard let reset = until(row.limit?.resetsAt) else { return row.line }
      return "\(row.line) · \(text("resets", ["time": reset]))"
    case "idle":
      if let background = row.background {
        return text("runsInBackground", ["command": background.first])
      }
      return short(since: row.since).map { text("endedAgo", ["time": $0]) } ?? row.line
    default:
      return row.line
    }
  }

  func lineColor(of row: IslandRow) -> Color {
    switch status(of: row) {
    case "waiting", "sign_in": return Theme.attention
    case "failed", "limited": return Theme.danger
    case "stuck": return Theme.warning
    case "running", "starting": return Theme.running
    case "unread": return Theme.success
    default: return Theme.secondary
    }
  }

  func title(of row: IslandRow) -> String { row.title.isEmpty ? text("untitled") : row.title }

  /// How long a row has been as it is: a running turn's time, else how long ago it changed.
  func time(of row: IslandRow) -> String? {
    guard let time = short(since: row.since) else { return nil }
    switch status(of: row) {
    case "running", "starting", "stuck", "waiting", "sign_in": return time
    default: return text("ago", ["time": time])
    }
  }

  func rowLabel(_ row: IslandRow) -> String {
    let status = status(of: row)
    return text(
      "a11y.row",
      [
        "title": title(of: row),
        "status": text("status.\(status == "sign_in" ? "signIn" : status)"),
        "agent": row.agent.name,
      ])
  }
}

/// Facts in a row that wraps onto the next line when it runs out of room.
struct FlowLayout: Layout {
  var spacing: CGFloat = 12
  var lineSpacing: CGFloat = 6

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let width = proposal.width ?? .infinity
    var x: CGFloat = 0
    var y: CGFloat = 0
    var line: CGFloat = 0
    var widest: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x > 0 && x + size.width > width {
        y += line + lineSpacing
        x = 0
        line = 0
      }
      widest = max(widest, x + size.width)
      x += size.width + spacing
      line = max(line, size.height)
    }
    return CGSize(width: min(widest, width), height: y + line)
  }

  func placeSubviews(
    in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()
  ) {
    var x = bounds.minX
    var y = bounds.minY
    var line: CGFloat = 0
    for view in subviews {
      let size = view.sizeThatFits(.unspecified)
      if x > bounds.minX && x + size.width > bounds.maxX {
        y += line + lineSpacing
        x = bounds.minX
        line = 0
      }
      view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
      x += size.width + spacing
      line = max(line, size.height)
    }
  }
}

/// One fact: a small icon and its words, grey unless its level colors it.
struct FactChip<Icon: View>: View {
  let text: String
  var color: Color = Theme.secondary
  var mono = false
  @ViewBuilder let icon: () -> Icon

  var body: some View {
    HStack(spacing: 5) {
      icon()
      Text(text)
        .font(mono ? Fonts.mono(11) : Fonts.ui(11.5, .medium))
        .lineLimit(1)
    }
    .foregroundColor(color)
    .monospacedDigit()
    .fixedSize()
  }
}

private func symbol(_ name: String, _ color: Color? = nil) -> some View {
  Image(systemName: name)
    .font(.system(size: 10.5, weight: .medium))
    .foregroundColor(color)
    .frame(width: 12, height: 12)
}

/// The session the panel leads with: who and how long, what it does, its plan, its last reply or a
/// word on its cache, then the facts that matter now.
struct FocusCard: View {
  @ObservedObject var model: IslandModel
  let row: IslandRow
  @State private var hover = false

  var body: some View {
    let status = model.status(of: row)
    let focus = model.focus
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 10) {
        MarkView(agent: row.agent, size: 20)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(model.title(of: row))
            .font(Fonts.ui(13.5, .semibold))
            .foregroundColor(Theme.text)
          if !row.project.isEmpty {
            Text(row.project).font(Fonts.ui(12)).foregroundColor(Theme.tertiary)
          }
          if let host = row.host { HostTag(host: host, offline: model.text("offline")) }
        }
        .lineLimit(1)
        Spacer(minLength: 8)
        if let time = model.time(of: row) {
          Text(time).font(Fonts.ui(11.5)).foregroundColor(Theme.tertiary).monospacedDigit()
        }
      }
      HStack(spacing: 7) {
        if status == "running" || status == "starting" {
          TurnDots(
            pattern: status == "starting" ? .think : TurnDots.Pattern(phase: row.phase), size: 12,
            reduceMotion: model.reduceMotion)
        }
        Text(model.line(of: row)).lineLimit(1).truncationMode(.tail)
      }
      .font(Fonts.ui(12.5))
      .foregroundColor(model.lineColor(of: row))
      .padding(.leading, 30)
      .padding(.top, 6)
      middle(status: status, focus: focus)
      facts(status: status)
    }
    .padding(.horizontal, 12)
    .padding(.top, 11)
    .padding(.bottom, 10)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(hover || model.selected == row.key ? Theme.cardHover : Theme.focusCard)
    )
    .padding(.top, 2)
    .opacity(row.host?.offline == true ? 0.5 : 1)
    .contentShape(Rectangle())
    .onHover { hover = $0 }
    .onTapGesture { model.open(row: row.key) }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(model.rowLabel(row))
    .accessibilityAddTraits(.isButton)
  }

  /// At most one of: the plan's progress and its step in progress while it runs, the last reply
  /// once it ended, or the cache's cost once it expired.
  @ViewBuilder private func middle(status: String, focus: IslandFocus?) -> some View {
    if ["running", "starting", "stuck"].contains(status), let plan = row.plan {
      HStack(spacing: 6) {
        PlanRing(done: plan.done, total: plan.total, size: 12)
        Text("\(plan.done)/\(plan.total)").fontWeight(.semibold).monospacedDigit()
        if let current = plan.current {
          Text(current).foregroundColor(Theme.quote).lineLimit(1).truncationMode(.tail)
        }
      }
      .font(Fonts.ui(12))
      .foregroundColor(Theme.text)
      .padding(.leading, 30)
      .padding(.top, 6)
    } else if ["unread", "failed"].contains(status), let reply = focus?.reply {
      Text(reply)
        .font(Fonts.ui(12.5))
        .foregroundColor(Theme.quote)
        .lineLimit(2)
        .lineSpacing(2)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .leading) { Rectangle().fill(Theme.track).frame(width: 2) }
        .padding(.leading, 30)
        .padding(.top, 7)
    } else if status == "idle", model.cacheLeft(row.cache) == nil, model.justExpired(row.cache) {
      Text(
        row.cache?.tokens.map {
          model.text("cache.expired", ["tokens": Self.tokens($0)])
        } ?? model.text("cache.expiredShort")
      )
      .font(Fonts.ui(11.5))
      .foregroundColor(Theme.tertiary)
      .lineSpacing(2)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.leading, 30)
      .padding(.top, 6)
    }
  }

  /// A token count as the composer writes it: 70K, 1.2M.
  static func tokens(_ count: Double) -> String {
    if count >= 1_000_000 { return String(format: "%.1fM", count / 1_000_000) }
    if count >= 1000 { return "\(Int((count / 1000).rounded()))K" }
    return "\(Int(count))"
  }

  /// Context, cache, branch, pull request, sub-agents, background, task, model; only what holds.
  @ViewBuilder private func facts(status: String) -> some View {
    FlowLayout(spacing: 12, lineSpacing: 6) {
      if let context = row.context {
        FactChip(
          text: model.text("context", ["percent": "\(context.percent)"]),
          color: context.level == "ok" ? Theme.secondary : Theme.limit(context.level)
        ) { ContextRing(percent: context.percent, level: context.level, size: 12) }
      }
      if !["running", "starting", "stuck"].contains(status), let left = model.cacheLeft(row.cache) {
        FactChip(
          text: model.text("cache.left", ["time": left.text]),
          color: left.ending ? Theme.warning : Theme.secondary
        ) { symbol("timer") }
      }
      if let branch = row.branch, !branch.name.isEmpty {
        FactChip(text: branch.name, mono: true) {
          symbol(branch.worktree ? "folder" : "arrow.triangle.branch")
        }
      }
      if let pr = row.pr {
        FactChip(text: "#\(pr.number)") { symbol("arrow.triangle.pull", Self.color(pr.state)) }
      }
      if let subagents = row.subagents {
        FactChip(text: subagents.text) { symbol("person.2") }
      }
      if let background = row.background {
        FactChip(text: model.text("background", ["count": "\(background.count)"])) {
          symbol("terminal")
        }
      }
      if row.parent?.kind == "task", let task = row.parent?.title {
        FactChip(
          text: row.parent?.step.map {
            model.text(
              "taskStep", ["task": task, "index": "\($0.index)", "total": "\($0.total)"])
          } ?? model.text("task", ["task": task])
        ) { symbol("checklist") }
      }
      if let name = row.model {
        FactChip(text: name) { EmptyView() }
      }
    }
    .padding(.leading, 30)
    .padding(.top, 9)
  }

  static func color(_ state: String) -> Color {
    switch state {
    case "merged": return Theme.merged
    case "closed": return Theme.danger
    case "draft": return Theme.secondary
    default: return Theme.success
    }
  }
}

/// Any other session on one line: its signal, title and project, one fact, its agent and time.
struct OtherRow: View {
  @ObservedObject var model: IslandModel
  let row: IslandRow
  @State private var hover = false

  var body: some View {
    HStack(spacing: 9) {
      Group {
        if let signal = model.signal(of: row) {
          SignalView(signal: signal, size: 13, reduceMotion: model.reduceMotion)
        } else {
          Circle().fill(Theme.faint).frame(width: 6, height: 6)
        }
      }
      .frame(width: 14, height: 14)
      HStack(alignment: .firstTextBaseline, spacing: 4) {
        Text(model.title(of: row))
          .font(Fonts.ui(12.5))
          .foregroundColor(row.group == "idle" ? Theme.secondary : Theme.text)
        if !row.project.isEmpty {
          Text(row.project).font(Fonts.ui(12)).foregroundColor(Theme.tertiary)
        }
        if let host = row.host { HostTag(host: host, offline: model.text("offline")) }
      }
      .lineLimit(1)
      Spacer(minLength: 8)
      fact
      MarkView(agent: row.agent, size: 13)
      Text(model.short(since: row.since) ?? "")
        .font(Fonts.ui(11.5))
        .foregroundColor(Theme.tertiary)
        .monospacedDigit()
        .lineLimit(1)
        .frame(width: 44, alignment: .trailing)
    }
    .padding(.horizontal, 10)
    .padding(.leading, row.parent?.kind == "session" ? 14 : 0)
    .frame(height: 32)
    .background(
      RoundedRectangle(cornerRadius: 9, style: .continuous)
        .fill(hover || model.selected == row.key ? Theme.rowHover : Color.clear)
    )
    .opacity(row.host?.offline == true ? 0.5 : 1)
    .contentShape(Rectangle())
    .onHover { hover = $0 }
    .onTapGesture { model.open(row: row.key) }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(model.rowLabel(row))
    .accessibilityAddTraits(.isButton)
  }

  /// One fact at most: a running plan's progress, a warm cache's time, or what runs in the
  /// background.
  @ViewBuilder private var fact: some View {
    let status = model.status(of: row)
    if ["running", "starting", "stuck"].contains(status), let plan = row.plan {
      HStack(spacing: 4) {
        PlanRing(done: plan.done, total: plan.total, size: 12)
        Text("\(plan.done)/\(plan.total)")
      }
      .font(Fonts.ui(11.5, .semibold))
      .foregroundColor(Theme.quote)
      .monospacedDigit()
    } else if !["running", "starting", "stuck"].contains(status), let left = model.cacheLeft(row.cache)
    {
      FactChip(text: left.text, color: left.ending ? Theme.warning : Theme.secondary) {
        symbol("timer")
      }
    } else if let background = row.background {
      FactChip(text: background.first) { symbol("terminal") }
        .frame(maxWidth: 150, alignment: .trailing)
    }
  }
}

/// The agents' plan limits at the bottom: each window's name, a small bar and the share used,
/// colored only from the warning level, and when the fullest window resets.
struct UsageStrip: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      ForEach(Array(model.limits.enumerated()), id: \.offset) { _, group in
        HStack(spacing: 9) {
          MarkView(
            agent: IslandAgent(
              id: group.agent.harness, name: group.agent.name, harness: group.agent.harness,
              color: group.agent.color),
            size: 13)
          Text(group.agent.name)
            .font(Fonts.ui(11.5, .semibold))
            .foregroundColor(Theme.quote)
            .lineLimit(1)
            .frame(width: 92, alignment: .leading)
          ForEach(Array(group.windows.enumerated()), id: \.offset) { _, window in
            HStack(spacing: 6) {
              Text(window.label).foregroundColor(Theme.secondary)
              ZStack(alignment: .leading) {
                Capsule().fill(Theme.button)
                Capsule().fill(Theme.limit(window.level))
                  .frame(width: max(1.5, 30 * CGFloat(min(100, window.usedPercent)) / 100))
              }
              .frame(width: 30, height: 4)
              Text("\(Int(window.usedPercent))%")
                .fontWeight(.semibold)
                .foregroundColor(window.level == "ok" ? Theme.quote : Theme.limit(window.level))
                .frame(minWidth: 28, alignment: .leading)
            }
          }
          Spacer(minLength: 4)
          if let fullest = group.windows.max(by: { $0.usedPercent < $1.usedPercent }),
            let reset = model.until(fullest.resetsAt)
          {
            Text(model.text("resets", ["time": reset])).foregroundColor(Theme.tertiary)
          }
        }
        .font(Fonts.ui(11.5, .medium))
        .monospacedDigit()
        .lineLimit(1)
      }
    }
    .padding(.horizontal, 10)
    .padding(.top, 10)
    .padding(.bottom, 2)
    .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    .padding(.top, 8)
    .accessibilityElement(children: .combine)
  }
}

/// A new session, and Kettu itself.
struct PanelFooter: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    HStack {
      FooterButton(label: "+ " + model.text("newSession")) { model.newSession() }
      Spacer()
      FooterButton(label: model.text("openKettu") + " ↗") { model.open(row: nil) }
    }
    .padding(.top, 6)
  }
}

struct FooterButton: View {
  let label: String
  let action: () -> Void
  @State private var hover = false

  var body: some View {
    Button(action: action) {
      Text(label)
        .font(Fonts.ui(11.5, .medium))
        .foregroundColor(hover ? Theme.text : Theme.secondary)
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(hover ? Theme.rowHover : Color.clear))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hover = $0 }
  }
}

struct NoteView: View {
  let note: Note

  var body: some View {
    HStack(spacing: 9) {
      Image(systemName: note.ok ? "checkmark" : "exclamationmark.triangle")
        .font(.system(size: 13, weight: .semibold))
        .foregroundColor(note.ok ? Theme.success : Theme.danger)
      Text(note.text).font(Fonts.ui(12.5)).foregroundColor(Theme.quote)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 12)
    .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Theme.card))
    .accessibilityElement(children: .combine)
  }
}

// MARK: Requests

struct RequestCard: View {
  @ObservedObject var model: IslandModel
  let request: IslandRequest

  var body: some View {
    let row = model.row(request.row)
    let pending = model.pending.contains(request.key)
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 9) {
        if let row { MarkView(agent: row.agent, size: 16) } else { BrandFox(size: 16) }
        VStack(alignment: .leading, spacing: 1) {
          Text(
            request.task?.title ?? row.map { $0.title.isEmpty ? model.text("untitled") : $0.title }
              ?? ""
          )
          .font(Fonts.ui(13, .semibold))
          .foregroundColor(Theme.text)
          Text(subtitle(row))
            .font(Fonts.ui(11.5))
            .foregroundColor(Theme.secondary)
        }
        .lineLimit(1)
        Spacer(minLength: 8)
        if let time = model.duration(since: request.askedAt) {
          Text(model.text("waited", ["time": time]))
            .font(Fonts.ui(11.5))
            .foregroundColor(Theme.secondary)
            .monospacedDigit()
        }
      }
      Text(request.title)
        .font(Fonts.ui(12.5, .semibold))
        .foregroundColor(Theme.attention)
        .padding(.top, 10)
        .padding(.bottom, 6)
        .padding(.horizontal, 2)
      if !request.lines.isEmpty {
        if request.code {
          Text(request.lines.joined(separator: "\n"))
            .font(Fonts.mono(12))
            .foregroundColor(Theme.text)
            .lineLimit(3)
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.surface))
        } else {
          Text(request.lines.joined(separator: "\n"))
            .font(Fonts.ui(12.5))
            .foregroundColor(Theme.text)
            .lineLimit(4)
            .padding(.horizontal, 2)
        }
      }
      if request.kind == "question" && !request.options.isEmpty {
        VStack(spacing: 4) {
          ForEach(Array(request.options.enumerated()), id: \.element.id) { index, option in
            OptionRow(index: index, option: option, recommended: model.text("recommended")) {
              model.answer(request, option: option)
            }
          }
        }
        .padding(.top, 8)
        HStack {
          footer
          Spacer(minLength: 0)
        }
        .padding(.top, 8)
      } else {
        // The footer beside the buttons when they fit, else under them; buttons that do not fit
        // in one row stack.
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 8) {
            footer
            Spacer(minLength: 8)
            buttons
          }
          VStack(alignment: .trailing, spacing: 8) {
            HStack(spacing: 8) { buttons }
            HStack {
              footer
              Spacer(minLength: 0)
            }
          }
          VStack(alignment: .leading, spacing: 6) {
            buttons
            footer
          }
        }
        .padding(.top, 10)
      }
    }
    .padding(12)
    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Theme.card))
    .disabled(pending)
    .opacity(pending ? 0.6 : 1)
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder private var buttons: some View {
    if request.options.isEmpty {
      ActionButton(label: model.text("answerInKettu") + " ↗", style: "open") {
        model.open(request: request)
      }
    } else {
      ForEach(request.options, id: \.id) { option in
        ActionButton(label: option.label, style: option.style) {
          model.answer(request, option: option)
        }
      }
    }
  }

  private func subtitle(_ row: IslandRow?) -> String {
    if let task = request.task { return task.step ?? "" }
    guard let row else { return "" }
    return [row.project, row.agent.name, row.host?.name ?? ""].filter { !$0.isEmpty }
      .joined(separator: " · ")
  }

  @ViewBuilder private var footer: some View {
    let more = model.requests.count - 1
    HStack(spacing: 0) {
      if more > 0 {
        Text(model.counted("moreWaiting", more) + " · ").foregroundColor(Theme.tertiary)
      }
      Button(model.text("openInKettu")) { model.open(request: request) }
        .buttonStyle(.plain)
        .foregroundColor(Theme.secondary)
    }
    .font(Fonts.ui(11.5))
    .lineLimit(1)
  }
}

struct OptionRow: View {
  let index: Int
  let option: IslandOption
  let recommended: String
  let action: () -> Void
  @State private var hover = false

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Text("\(index + 1)")
          .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
          .foregroundColor(Theme.tertiary)
          .padding(.horizontal, 5)
          .padding(.vertical, 3)
          .background(RoundedRectangle(cornerRadius: 5).fill(Theme.card))
        Text(option.label).font(Fonts.ui(12.5, .medium)).foregroundColor(Theme.text).lineLimit(2)
        Spacer(minLength: 8)
        if option.style == "recommended" {
          Text(recommended).font(Fonts.ui(11)).foregroundColor(Theme.success)
        }
      }
      .padding(.horizontal, 11)
      .padding(.vertical, 9)
      .background(
        RoundedRectangle(cornerRadius: 11, style: .continuous)
          .fill(hover ? Theme.cardHover : Theme.surface)
      )
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hover = $0 }
  }
}

/// The permission card's buttons: a red cross for deny, the white primary for once, a green
/// double check for always.
struct ActionButton: View {
  let label: String
  let style: String
  let action: () -> Void
  @State private var hover = false

  private var primary: Bool { ["allow_once", "recommended", "open"].contains(style) }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        switch style {
        case "deny":
          CrossShape().stroke(Theme.danger, style: StrokeStyle(lineWidth: 1.8, lineCap: .round))
            .frame(width: 9, height: 9)
        case "allow_once", "recommended":
          CheckShape().stroke(
            Color.black, style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round)
          )
          .frame(width: 11, height: 9)
        case "allow_always":
          DoubleCheckShape().stroke(
            Theme.usageGreen, style: StrokeStyle(lineWidth: 1.8, lineCap: .round, lineJoin: .round)
          )
          .frame(width: 15, height: 9)
        default:
          EmptyView()
        }
        Text(label).lineLimit(1)
      }
      .font(Fonts.ui(12.5, .semibold))
      .foregroundColor(primary ? .black : Theme.text)
      .padding(.horizontal, 12)
      .frame(height: 30)
      .background(
        RoundedRectangle(cornerRadius: 10, style: .continuous)
          .fill(
            primary
              ? (hover ? Color.white : Theme.primaryButton)
              : (hover ? Theme.buttonHover : Theme.button))
      )
      .contentShape(Rectangle())
      .fixedSize()
    }
    .buttonStyle(.plain)
    .onHover { hover = $0 }
  }
}

struct CrossShape: Shape {
  func path(in rect: CGRect) -> Path {
    var p = Path()
    p.move(to: CGPoint(x: rect.minX, y: rect.minY))
    p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
    p.move(to: CGPoint(x: rect.maxX, y: rect.minY))
    p.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
    return p
  }
}

struct CheckShape: Shape {
  func path(in rect: CGRect) -> Path {
    var p = Path()
    p.move(to: CGPoint(x: rect.minX, y: rect.midY + rect.height * 0.05))
    p.addLine(to: CGPoint(x: rect.minX + rect.width * 0.34, y: rect.maxY))
    p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
    return p
  }
}

struct DoubleCheckShape: Shape {
  func path(in rect: CGRect) -> Path {
    var p = Path()
    let w = rect.width
    p.move(to: CGPoint(x: rect.minX, y: rect.midY + rect.height * 0.05))
    p.addLine(to: CGPoint(x: rect.minX + w * 0.24, y: rect.maxY))
    p.addLine(to: CGPoint(x: rect.minX + w * 0.66, y: rect.minY))
    p.move(to: CGPoint(x: rect.minX + w * 0.44, y: rect.maxY - rect.height * 0.15))
    p.addLine(to: CGPoint(x: rect.minX + w * 0.5, y: rect.maxY))
    p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
    return p
  }
}
