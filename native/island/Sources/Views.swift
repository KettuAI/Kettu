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
          case .hidden, .rest:
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
      .opacity(model.mode == .hidden || model.mode == .rest ? 0 : 1)
      .animation(model.animation(to: .collapsed), value: model.parts)
      .animation(model.animation(to: .open), value: model.panelHeight)
      .animation(model.animation(to: model.mode), value: model.mode)
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
  var openWidth: CGFloat { max(Metrics.openWidth, geometry.notchWidth + Metrics.openWings) }

  /// The middle of the collapsed island: the notch, or where no notch is in the way the band the
  /// title sits in, so the island keeps one outline on every screen.
  var middleWidth: CGFloat { geometry.hasNotch ? geometry.notchWidth : Metrics.plainMiddle }

  /// The island's size in each mode. Collapsed, its two wings match so the middle stays centred
  /// and follow their content, so it never shows empty black.
  func frameSize() -> CGSize {
    let g = geometry
    switch mode {
    case .hidden, .rest:
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
    case .hidden, .rest, .collapsed: return Metrics.collapsedRadius
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
  private static let image = Data(base64Encoded: brandFoxPNG).flatMap { NSImage(data: $0) }

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

/// The fact beside the signal: a count, the plan or a word.
struct FactView: View {
  let fact: Fact

  var body: some View {
    switch fact {
    case .count(let count):
      CountBadge(count: count)
    case .plan(let done, let step, let total):
      HStack(spacing: 5) {
        PlanRing(done: done, total: total, size: 13)
        Text("\(step)/\(total)")
      }
      .font(Fonts.ui(13, .semibold))
      .foregroundColor(Theme.text)
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
    case "limit-near": return ("", Theme.usageRed)
    case "limit-reached": return (text("pop.limitReached"), Theme.danger)
    case "limit-reset": return (text("pop.limitReset"), Theme.success)
    case "update": return (text("pop.update"), Theme.running)
    case "update-manual": return (text("pop.updateManual"), Theme.running)
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
            if let row {
              MarkView(agent: row.agent, size: g.hasNotch ? 20 : 17)
            } else if let mark = pop.mark {
              MarkView(agent: mark.agent, size: g.hasNotch ? 20 : 17)
            } else {
              BrandFox(size: g.hasNotch ? 20 : 17)
            }
          }
          .padding(.leading, 14)
          Spacer(minLength: model.middleWidth)
          HStack(spacing: 6) {
            if model.queued > 0 { Pill(text: "+\(model.queued)", color: Theme.secondary, dot: false) }
            if pop.kind == "limit-near", let percent = pop.percent {
              LimitPill(percent: percent)
            } else {
              Pill(text: label, color: color)
            }
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
    .onTapGesture { model.tapPop() }
  }
}

extension IslandMark {
  /// As a row's agent, for the same mark: a mark the system cannot draw falls back to its initial.
  var agent: IslandAgent { IslandAgent(id: harness, name: harness, harness: harness, color: color) }
}

/// A plan limit window near full on a pop: its ring and how much is used, in the limit's red.
struct LimitPill: View {
  let percent: Double

  var body: some View {
    HStack(spacing: 6) {
      UsageRing(percent: percent)
      Text("\(Int(percent.rounded()))%").monospacedDigit()
    }
    .font(Fonts.ui(11.5, .semibold))
    .foregroundColor(Theme.usageRed)
    .padding(.horizontal, 9)
    .frame(height: 24)
    .background(Capsule().fill(Theme.usageRed.opacity(0.16)))
    .fixedSize()
  }
}

/// A plan limit window's use as the window's rings draw it: the used part on a tinted disc.
struct UsageRing: View {
  let percent: Double

  var body: some View {
    let share = min(1, max(0, percent / 100))
    ZStack {
      Circle().fill(Theme.usageRed.opacity(0.18))
      Circle().trim(from: 0, to: share)
        .stroke(Theme.usageRed, style: StrokeStyle(lineWidth: 2.2, lineCap: .butt))
        .rotationEffect(.degrees(-90))
        .padding(1.1)
    }
    .frame(width: 12, height: 12)
  }
}

// MARK: Expanded

struct PanelContent: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    let g = model.geometry
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        // A request's card names the session; its agent's mark heads the island, once.
        if model.note == nil, let request = model.requests.first {
          if let row = model.row(request.row) {
            MarkView(agent: row.agent, size: Metrics.wingMark)
          } else {
            BrandFox().padding(2)
          }
        } else {
          LeadMarks(collapsed: model.collapsed)
        }
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
/// its word shows for a moment and the next card or the list follows. The list is the sessions as
/// the sidebar lists them, a few with the rest folded into one line, then the way to a new session
/// or Kettu.
struct PanelBody: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let note = model.note {
        NoteView(note: note).padding(.vertical, 4)
      } else if let request = model.requests.first {
        RequestCard(model: model, request: request).padding(.vertical, 4)
      } else {
        if model.rows.isEmpty {
          EmptyPanel(model: model)
        } else {
          let oneLine = model.rows.count > Metrics.twoLineRows
          VStack(spacing: oneLine ? 1 : 2) {
            ForEach(model.listRows, id: \.key) { row in
              SessionRow(model: model, row: row, oneLine: oneLine)
            }
          }
          .padding(.top, 2)
          let more = model.rows.count - model.listRows.count
          if more > 0 { MoreRow(model: model, count: more) }
        }
        if !model.notices.isEmpty {
          VStack(spacing: 1) {
            ForEach(model.notices, id: \.key) { notice in
              NoticeRow(model: model, notice: notice)
            }
          }
          .padding(.top, 6)
          .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
          .padding(.top, 6)
        }
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
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(hover ? Theme.rowHover : Color.clear)
    )
    .contentShape(Rectangle())
    .onHover { hover = $0 }
    .onTapGesture { model.open(row: nil) }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isButton)
  }
}

/// A notice under the sessions: Kettu's update with Restart, the agents' updates, or the fullest
/// plan limit window. Its button acts in place; a click anywhere else on it does the same.
struct NoticeRow: View {
  @ObservedObject var model: IslandModel
  let notice: IslandNotice
  @State private var hover = false

  var body: some View {
    HStack(spacing: 8) {
      lead
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Text(notice.title).font(Fonts.ui(13, .medium)).foregroundColor(Theme.text)
          .layoutPriority(1)
        if let detail = notice.detail {
          Text(detail).font(Fonts.ui(12)).foregroundColor(Theme.tertiary)
        }
      }
      .lineLimit(1)
      .truncationMode(.tail)
      Spacer(minLength: 8)
      if let meter = notice.meter {
        HStack(spacing: 5) {
          if meter.reached { LimitRing(size: 12) } else { UsageRing(percent: meter.percent) }
          Text(meter.text).monospacedDigit()
        }
        .font(Fonts.ui(12, .medium))
        .foregroundColor(Theme.usageRed)
        .fixedSize()
      }
      if let trailing = notice.trailing { TimeText(text: trailing) }
      if let button = notice.button {
        Text(button)
          .font(Fonts.ui(12, .semibold))
          .foregroundColor(Theme.text)
          .padding(.horizontal, 9)
          .frame(height: 22)
          .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
              .fill(hover ? Theme.buttonHover : Theme.button))
          .fixedSize()
      }
      if let link = notice.link {
        Text(link + " ↗").font(Fonts.ui(12, .medium)).foregroundColor(Theme.secondary).fixedSize()
      }
    }
    .padding(.horizontal, 10)
    .frame(height: 32)
    .background(
      RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(hover ? Theme.rowHover : Color.clear)
    )
    .contentShape(Rectangle())
    .onHover { hover = $0 }
    .onTapGesture { model.act(notice.key) }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isButton)
  }

  @ViewBuilder private var lead: some View {
    if notice.marks.isEmpty {
      BrandFox(size: 14)
    } else if notice.marks.count == 1 {
      MarkView(agent: notice.marks[0].agent, size: 14)
    } else {
      // Ringed in black where they overlap; the title moves over for the marks behind the first.
      HStack(spacing: -4) {
        ForEach(Array(notice.marks.enumerated()), id: \.offset) { index, mark in
          MarkView(agent: mark.agent, size: 14)
            .padding(1)
            .background(Circle().fill(Theme.surface))
            .zIndex(Double(notice.marks.count - index))
        }
      }
    }
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
  func title(of row: IslandRow) -> String { row.title.isEmpty ? text("untitled") : row.title }

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

  /// A cache in its last stretch, as the sidebar marks it: the share of that stretch left.
  func cacheEnding(_ cache: IslandCache?) -> Double? {
    guard let cache, cache.endingMs > 0 else { return nil }
    let left = cache.expiresAt - now.timeIntervalSince1970 * 1000
    guard left > 0, left <= cache.endingMs else { return nil }
    return left / cache.endingMs
  }
}

/// A session as the sidebar's row draws it: its agent's mark, its title and its project, and at
/// the end one status in a fixed slot: waiting, failed, the turn's nine dots, a cache in its last
/// minutes, or unread. With few sessions a second line says what it is doing or what came of it,
/// with the plan's progress or a time on its right; with many the row keeps one line and only
/// that progress or time.
struct SessionRow: View {
  @ObservedObject var model: IslandModel
  let row: IslandRow
  let oneLine: Bool
  @State private var hover = false

  var body: some View {
    let status = model.status(of: row)
    VStack(alignment: .leading, spacing: 5) {
      HStack(spacing: 8) {
        MarkView(agent: row.agent, size: 14)
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(model.title(of: row))
            .font(Fonts.ui(13, .medium))
            .foregroundColor(row.group == "idle" ? Theme.quote : Theme.text)
            .layoutPriority(1)
          if !row.project.isEmpty {
            Text(row.project).font(Fonts.ui(12)).foregroundColor(Theme.tertiary)
          }
          if let host = row.host {
            Text(host.offline ? "\(host.name) · \(model.text("offline"))" : host.name)
              .font(Fonts.ui(12))
              .foregroundColor(Theme.tertiary)
          }
        }
        .lineLimit(1)
        .truncationMode(.tail)
        Spacer(minLength: 8)
        if oneLine { trailingItems(status) }
        indicator(status).frame(width: 16, height: 16)
      }
      if !oneLine {
        HStack(spacing: 8) {
          detail(status)
            .font(Fonts.ui(12))
            .lineLimit(1)
            .truncationMode(.tail)
          Spacer(minLength: 8)
          trailingItems(status)
        }
        .padding(.leading, 22)
      }
    }
    .padding(.leading, row.parent?.kind == "session" ? 24 : 10)
    .padding(.trailing, 10)
    .padding(.top, oneLine ? 0 : 7)
    .padding(.bottom, oneLine ? 0 : 8)
    .frame(height: oneLine ? 32 : nil)
    .background(
      RoundedRectangle(cornerRadius: oneLine ? 8 : 9, style: .continuous)
        .fill(hover || model.selected == row.key ? Theme.rowHover : Color.clear)
    )
    .opacity(row.host?.offline == true ? 0.5 : 1)
    .contentShape(Rectangle())
    .onHover { hover = $0 }
    .onTapGesture { model.open(row: row.key) }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(model.rowLabel(row))
    .accessibilityValue(row.subagents?.text ?? "")
    .accessibilityAddTraits(.isButton)
  }

  /// The sub-agents at work, then the plan's progress or a time.
  @ViewBuilder private func trailingItems(_ status: String) -> some View {
    HStack(spacing: 8) {
      if let subagents = row.subagents {
        SubagentBadge(subagents: subagents, reduceMotion: model.reduceMotion)
      }
      trailing(status)
    }
  }

  /// What it is doing or what came of it, in its state's color.
  @ViewBuilder private func detail(_ status: String) -> some View {
    switch status {
    case "running", "starting":
      Text(row.line).foregroundColor(Theme.running)
    case "stuck":
      let minutes = row.toolSince.map { max(1, Int(model.now.timeIntervalSince1970 - $0 / 1000) / 60) }
      let stuck = minutes.map {
        model.text("row.stuck", ["time": model.text("duration.minutes", ["m": "\($0)"])])
      }
      Text([stuck, row.line].compactMap { $0 }.joined(separator: " · "))
        .foregroundColor(Theme.warning)
    case "waiting", "sign_in":
      Text(row.line).foregroundColor(Theme.attention)
    case "unread":
      Text(row.line).foregroundColor(Theme.success)
    case "failed", "limited":
      Text(row.line).foregroundColor(Theme.danger)
    default:
      if let left = model.cacheLeft(row.cache) {
        Text(model.text("cache.left", ["time": left.text]))
          .foregroundColor(left.ending ? Theme.warning : Theme.tertiary)
          .monospacedDigit()
      } else {
        Text(row.line).foregroundColor(Theme.tertiary)
      }
    }
  }

  /// The plan's progress while it runs, else how long the turn has run, when a used-up limit
  /// resets, or how long ago it ended.
  @ViewBuilder private func trailing(_ status: String) -> some View {
    switch status {
    case "running", "starting", "stuck":
      if let plan = row.plan {
        PlanProgress(model: model, plan: plan)
      } else if let time = model.duration(since: row.turnStartedAt ?? row.since) {
        TimeText(text: time)
      }
    case "limited":
      if let resets = row.limit?.resetsAt {
        TimeText(text: model.text("resets", ["day": model.resetDay(resets)]))
      }
    case "sign_in":
      EmptyView()
    default:
      if let time = model.ago(since: row.since) { TimeText(text: time) }
    }
  }

  @ViewBuilder private func indicator(_ status: String) -> some View {
    switch status {
    case "waiting", "sign_in":
      WaitingDot(size: 8)
    case "failed", "limited", "stuck":
      SignalView(signal: model.signal(of: row) ?? .failed, size: 14, reduceMotion: model.reduceMotion)
    case "running", "starting":
      TurnDots(
        pattern: status == "starting" ? .think : TurnDots.Pattern(phase: row.phase), size: 12,
        reduceMotion: model.reduceMotion)
    default:
      if let share = model.cacheEnding(row.cache) {
        CacheRing(share: share)
      } else if status == "unread" {
        Circle().fill(Theme.unread).frame(width: 6, height: 6)
      }
    }
  }
}

/// A time on a row's right: how long, how long ago, or when a limit resets.
struct TimeText: View {
  let text: String

  var body: some View {
    Text(text)
      .font(Fonts.ui(12))
      .foregroundColor(Theme.tertiary)
      .lineLimit(1)
      .fixedSize()
  }
}

/// A plan's progress as the session's plan chip draws it: the ring and the step it is on.
struct PlanProgress: View {
  @ObservedObject var model: IslandModel
  let plan: IslandPlan

  var body: some View {
    HStack(spacing: 5) {
      PlanRing(done: plan.done, total: plan.total, size: 12)
      Text(model.text("plan", ["step": "\(plan.step)", "total": "\(plan.total)"]))
        .foregroundColor(Theme.tertiary)
        .monospacedDigit()
    }
    .font(Fonts.ui(12))
    .fixedSize()
  }
}

/// A session's sub-agents at work, as the sidebar's badge draws them: a bot, how many, and a
/// spinner while any runs.
struct SubagentBadge: View {
  let subagents: IslandSubagents
  let reduceMotion: Bool

  var body: some View {
    HStack(spacing: 4) {
      BotShape()
        .stroke(
          Theme.tertiary,
          style: StrokeStyle(lineWidth: 1.9 * 11 / 24, lineCap: .round, lineJoin: .round)
        )
        .frame(width: 11, height: 11)
      Text("\(subagents.running)").monospacedDigit()
      if subagents.running > 0 { SpinnerRing(reduceMotion: reduceMotion) }
    }
    .font(Fonts.ui(11, .medium))
    .foregroundColor(Theme.secondary)
    .padding(.leading, 4)
    .padding(.trailing, 5)
    .frame(height: 18)
    .background(Capsule().fill(Theme.card))
    .fixedSize()
  }
}

/// A prompt cache in its last minutes, as the sidebar's ring: the part left in the warning color.
struct CacheRing: View {
  let share: Double

  var body: some View {
    ZStack {
      Circle().stroke(Theme.track, lineWidth: 1.6)
      Circle().trim(from: 0, to: share)
        .stroke(Theme.warning, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
        .rotationEffect(.degrees(-90))
    }
    .frame(width: 11, height: 11)
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

/// The sidebar's bot glyph, on its 24-unit grid. Its tail is left out, so the rest sits lower to
/// stay centered.
struct BotShape: Shape {
  func path(in rect: CGRect) -> Path {
    let k = min(rect.width, rect.height) / 24
    func at(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
      CGPoint(x: rect.minX + x * k, y: rect.minY + (y + 1.3) * k)
    }
    func circle(_ x: CGFloat, _ y: CGFloat, _ r: CGFloat) -> CGRect {
      CGRect(
        x: rect.minX + (x - r) * k, y: rect.minY + (y - r + 1.3) * k, width: 2 * r * k,
        height: 2 * r * k)
    }
    var p = Path()
    // Ears.
    p.move(to: at(4, 15.5))
    p.addCurve(to: at(2, 13.5), control1: at(2.89543, 15.5), control2: at(2, 14.6046))
    p.addCurve(to: at(4, 11.5), control1: at(2, 12.3954), control2: at(2.89543, 11.5))
    p.move(to: at(20, 15.5))
    p.addCurve(to: at(22, 13.5), control1: at(21.1046, 15.5), control2: at(22, 14.6046))
    p.addCurve(to: at(20, 11.5), control1: at(22, 12.3954), control2: at(21.1046, 11.5))
    // Antennas.
    p.move(to: at(7, 7))
    p.addLine(to: at(7, 4))
    p.move(to: at(17, 7))
    p.addLine(to: at(17, 4))
    p.addEllipse(in: circle(7, 3, 1))
    p.addEllipse(in: circle(17, 3, 1))
    // Head, mouth and eyes.
    p.addRoundedRect(
      in: CGRect(x: at(4.5, 7).x, y: at(4.5, 7).y, width: 15 * k, height: 12.4 * k),
      cornerSize: CGSize(width: 3.5 * k, height: 3.5 * k), style: .continuous)
    p.move(to: at(9.5, 15))
    p.addCurve(to: at(12, 16), control1: at(10.0701, 15.6072), control2: at(10.9777, 16))
    p.addCurve(to: at(14.5, 15), control1: at(13.0223, 16), control2: at(13.9299, 15.6072))
    p.move(to: at(9, 11))
    p.addLine(to: at(9.009, 11))
    p.move(to: at(15, 11))
    p.addLine(to: at(15.009, 11))
    return p
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
