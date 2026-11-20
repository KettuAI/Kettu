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

private let fade = AnyTransition.asymmetric(
  insertion: .opacity.animation(.easeOut(duration: 0.18).delay(0.08)),
  removal: .opacity.animation(.easeOut(duration: 0.1)))

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
            CollapsedContent(model: model).transition(fade)
          case .grown:
            GrownContent(model: model).transition(fade)
          case .open:
            PanelContent(model: model).transition(fade)
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
    .environment(\.colorScheme, .dark)
  }
}

extension IslandModel {
  /// The island's size in each mode. Collapsed over a notch, its two wings match so the notch
  /// stays in the middle and follow their content, so it never shows empty black; without a
  /// notch it is one band as wide as its content.
  func frameSize() -> CGSize {
    let g = geometry
    switch mode {
    case .hidden:
      return CGSize(width: max(g.notchWidth, 1), height: g.notchHeight)
    case .collapsed:
      if g.hasNotch { return CGSize(width: g.notchWidth + 2 * wing(), height: g.notchHeight) }
      return CGSize(width: max(120, bandWidth()), height: g.notchHeight)
    case .grown:
      return CGSize(
        width: max(Metrics.grownWidth, g.notchWidth + 160),
        height: grownLead + Metrics.grownBody + (g.hasNotch ? 0 : 4))
    case .open:
      let body = min(max(panelHeight, 60), g.maxHeight - g.notchHeight)
      return CGSize(width: max(Metrics.openWidth, g.notchWidth + 300), height: g.notchHeight + body)
    }
  }

  /// What the grown island keeps above its line: the notch, or a little air under the menu bar.
  var grownLead: CGFloat { geometry.hasNotch ? geometry.notchHeight : 4 }

  func radius() -> CGFloat {
    switch mode {
    case .hidden, .collapsed: return Metrics.collapsedRadius
    case .grown: return Metrics.grownRadius
    case .open: return Metrics.openRadius
    }
  }

  /// The collapsed island's wings: each side's content as laid out, plus its padding; both wings
  /// take the wider, so the notch stays in the middle.
  func wing() -> CGFloat {
    max(
      10 + (parts["left"] ?? Metrics.wingMark) + 8, 8 + (parts["right"] ?? 0) + 12, Metrics.wingMin)
  }

  /// The collapsed island's width where no notch is in the way: its content in one band.
  private func bandWidth() -> CGFloat {
    let title = min(parts["title"] ?? 0, Metrics.titleWidth)
    let right = parts["right"] ?? 0
    return 10 + (parts["left"] ?? Metrics.wingMark) + (title > 0 ? 10 + title : 0) + 14 + right + 12
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

/// How many sessions the island lists, on a small grey tile.
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

  var body: some View {
    if let agents = collapsed?.agents, !agents.isEmpty {
      MarkStack(agents: agents)
    } else {
      BrandFox().padding(2)
    }
  }
}

/// The signal, its word and the count badge, as the right of the collapsed island.
struct TrailingStatus: View {
  let collapsed: Collapsed?
  let reduceMotion: Bool

  var body: some View {
    HStack(spacing: 7) {
      if let signal = collapsed?.signal { SignalView(signal: signal, reduceMotion: reduceMotion) }
      if let text = collapsed?.text {
        Text(text).font(Fonts.ui(13, .semibold)).monospacedDigit().foregroundColor(Theme.text)
      }
      if let count = collapsed?.count, count > 0 { CountBadge(count: count) }
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
      if !g.hasNotch, let title = c?.title {
        // The full title is measured unseen, so the band widens to it up to the cap and the
        // shown copy cuts it short only past that.
        Text(title)
          .font(Fonts.ui(13, .medium))
          .foregroundColor(c?.signal == nil ? Theme.secondary : Theme.text)
          .lineLimit(1)
          .truncationMode(.tail)
          .frame(maxWidth: Metrics.titleWidth, alignment: .leading)
          .background(
            Text(title).font(Fonts.ui(13, .medium)).lineLimit(1).fixedSize().hidden()
              .measured("title", model),
            alignment: .leading
          )
          .padding(.leading, 10)
      }
      Spacer(minLength: g.hasNotch ? g.notchWidth : 14)
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
    HStack(spacing: 6) {
      if dot { Circle().fill(color).frame(width: 6, height: 6) }
      Text(text).font(Fonts.ui(12, .semibold)).lineLimit(1)
    }
    .foregroundColor(color)
    .padding(.horizontal, dot ? 10 : 8)
    .frame(height: 26)
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

/// A small grey label beside a row, as in the menu bar panel's facts.
struct Chip: View {
  var agent: IslandAgent?
  let text: String

  var body: some View {
    HStack(spacing: 4) {
      if let agent { MarkView(agent: agent, size: 11) }
      Text(text).lineLimit(1)
    }
    .font(Fonts.ui(11.5, .medium))
    .foregroundColor(Theme.secondary)
    .padding(.horizontal, 7)
    .padding(.vertical, 3)
    .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.chip))
    .fixedSize()
  }
}

struct GrownContent: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    VStack(spacing: 0) {
      Color.clear.frame(height: model.grownLead)
      if let pop = model.pop {
        let row = model.row(pop.row)
        let (label, color) = model.pill(for: pop.kind)
        HStack(spacing: 11) {
          if let row { MarkView(agent: row.agent, size: 24) } else { BrandFox(size: 24) }
          VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
              (Text(pop.title).foregroundColor(Theme.text)
                + Text(row.map { $0.project.isEmpty ? "" : " · \($0.project)" } ?? "")
                .foregroundColor(Theme.secondary).fontWeight(.medium))
                .font(Fonts.ui(13.5, .semibold))
                .lineLimit(1)
              if let host = row?.host {
                Chip(text: host.offline ? "\(host.name) · \(model.text("offline"))" : host.name)
              }
            }
            Text(pop.body).font(Fonts.ui(12)).foregroundColor(Theme.secondary).lineLimit(1)
          }
          Spacer(minLength: 8)
          if model.queued > 0 { Pill(text: "+\(model.queued)", color: Theme.secondary, dot: false) }
          Pill(text: label, color: color)
        }
        .padding(.leading, 14)
        .padding(.trailing, 12)
        .frame(height: Metrics.grownBody)
        .accessibilityElement(children: .combine)
      }
    }
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
        Spacer(minLength: g.hasNotch ? g.notchWidth : 14)
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
          .padding(.bottom, 10)
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

/// The agents' plan windows on one line: each window's name, the share used in its level's color,
/// and how long until it resets.
struct LimitsLine: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      ForEach(Array(model.limits.enumerated()), id: \.offset) { _, group in
        HStack(spacing: 8) {
          MarkView(
            agent: IslandAgent(
              id: group.agent.harness, name: group.agent.name, harness: group.agent.harness,
              color: group.agent.color),
            size: 13)
          ForEach(Array(group.windows.enumerated()), id: \.offset) { index, window in
            if index > 0 { Text("|").foregroundColor(Theme.faint) }
            HStack(spacing: 4) {
              Text(window.label).foregroundColor(Theme.text)
              Text("\(Int(window.usedPercent))%").foregroundColor(Theme.limit(window.level))
              if let reset = model.until(window.resetsAt) {
                Text(reset).foregroundColor(Theme.tertiary).fontWeight(.regular)
              }
            }
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .font(Fonts.ui(12, .semibold))
    .monospacedDigit()
    .lineLimit(1)
    .padding(.horizontal, 8)
    .padding(.top, 4)
    .padding(.bottom, 8)
    .accessibilityElement(children: .combine)
  }
}

struct PanelBody: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if !model.limits.isEmpty { LimitsLine(model: model) }
      if let note = model.note {
        NoteView(note: note).padding(.bottom, 6)
      } else if let request = model.requests.first {
        RequestCard(model: model, request: request).padding(.bottom, 6)
      }
      if let focus = model.focusRow { FocusRow(model: model, row: focus) }
      ForEach(model.otherRows, id: \.key) { row in CompactRow(model: model, row: row) }
    }
  }
}

extension IslandModel {
  /// How long until a time, as the duration strings write it; nil once it has passed.
  func until(_ ms: Double?) -> String? {
    guard let ms, ms > now.timeIntervalSince1970 * 1000 else { return nil }
    return short(since: 2 * now.timeIntervalSince1970 * 1000 - ms)
  }

  /// A row's second line: what it does or waits for, with its plan, sub-agents and task.
  func line(of row: IslandRow) -> String {
    let status = status(of: row)
    var parts: [String] = []
    if status == "stuck", let time = duration(since: row.toolSince) {
      parts.append(text("stuck", ["time": time]))
    }
    if !row.line.isEmpty { parts.append(row.line) }
    if let plan = row.plan {
      parts.append(text("plan", ["done": "\(plan.done)", "total": "\(plan.total)"]))
    }
    if let subagents = row.subagents { parts.append(subagents.text) }
    if row.parent?.kind == "task", let task = row.parent?.title { parts.append(task) }
    return parts.joined(separator: " · ")
  }

  func lineColor(of row: IslandRow) -> Color {
    switch status(of: row) {
    case "waiting", "sign_in": return Theme.attention
    case "failed", "limited": return Theme.danger
    case "stuck": return Theme.warning
    case "running", "starting": return Theme.unread
    case "unread": return Theme.success
    default: return Theme.secondary
    }
  }

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
}

/// A row's facts on the right: its agent, its project or computer, and how long it has been so.
struct RowFacts: View {
  @ObservedObject var model: IslandModel
  let row: IslandRow

  var body: some View {
    HStack(spacing: 6) {
      Chip(agent: row.agent, text: row.model ?? row.agent.name)
      if let host = row.host {
        Chip(text: host.offline ? "\(host.name) · \(model.text("offline"))" : host.name)
      } else if !row.project.isEmpty {
        Chip(text: row.project)
      }
      if let time = model.short(since: row.since) {
        Text(time)
          .font(Fonts.ui(11.5))
          .foregroundColor(Theme.tertiary)
          .monospacedDigit()
          .lineLimit(1)
          .fixedSize()
          .frame(minWidth: 34, alignment: .trailing)
      }
    }
  }
}

/// The session the panel leads with: its mark, title and what it does, in full.
struct FocusRow: View {
  @ObservedObject var model: IslandModel
  let row: IslandRow
  @State private var hover = false

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      MarkView(agent: row.agent, size: 22).padding(.top, 1)
      VStack(alignment: .leading, spacing: 3) {
        Text(model.title(of: row))
          .font(Fonts.ui(14, .semibold))
          .foregroundColor(Theme.text)
          .lineLimit(1)
        Text(model.line(of: row))
          .font(Fonts.ui(12.5))
          .foregroundColor(model.lineColor(of: row))
          .lineLimit(2)
      }
      Spacer(minLength: 8)
      RowFacts(model: model, row: row)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 10)
    .padding(.leading, row.parent?.kind == "session" ? 14 : 0)
    .background(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
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
}

/// Any other session on one line: its signal, title and facts.
struct CompactRow: View {
  @ObservedObject var model: IslandModel
  let row: IslandRow
  @State private var hover = false

  var body: some View {
    HStack(spacing: 10) {
      Group {
        if let signal = model.signal(of: row) {
          SignalView(signal: signal, size: 13, reduceMotion: model.reduceMotion)
        } else {
          Circle().fill(Theme.faint).frame(width: 6, height: 6)
        }
      }
      .frame(width: 14, height: 14)
      Text(model.title(of: row))
        .font(Fonts.ui(13))
        .foregroundColor(row.group == "idle" ? Theme.secondary : Theme.text)
        .lineLimit(1)
      Spacer(minLength: 8)
      RowFacts(model: model, row: row)
    }
    .padding(.horizontal, 10)
    .frame(minHeight: 36)
    .padding(.leading, row.parent?.kind == "session" ? 14 : 0)
    .background(
      RoundedRectangle(cornerRadius: 10, style: .continuous)
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
    .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Theme.card))
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
        if let row { MarkView(agent: row.agent, size: 16) }
        VStack(alignment: .leading, spacing: 1) {
          Text(row.map { $0.title.isEmpty ? model.text("untitled") : $0.title } ?? "")
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
        .font(Fonts.ui(12.5))
        .foregroundColor(Theme.quote)
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
      ActionButton(label: model.text("answerInKettu"), style: "open") {
        model.open(row: request.row)
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
      Button(model.text("openInKettu")) { model.open(row: request.row) }
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
