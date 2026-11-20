import AppKit
import SwiftUI

/// The island's outline: flat along the top, where two small concave shoulders meet the menu bar,
/// with round bottom corners. A floating island, on a screen without a notch, is round all over.
struct IslandShape: Shape {
  var attached: Bool
  var radius: CGFloat
  var shoulders = true

  var animatableData: CGFloat {
    get { radius }
    set { radius = newValue }
  }

  func path(in rect: CGRect) -> Path {
    let r = max(0, min(radius, rect.height / 2, rect.width / 2))
    guard attached else { return Path(roundedRect: rect, cornerRadius: r, style: .continuous) }
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
    let g = model.geometry
    let size = model.frameSize()
    let radius = model.radius()
    VStack(spacing: 0) {
      ZStack(alignment: .top) {
        IslandShape(attached: g.attached, radius: radius)
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
        .clipShape(IslandShape(attached: g.attached, radius: radius, shoulders: false))
      }
      .frame(width: size.width, height: size.height)
      .opacity(model.mode == .hidden ? 0 : 1)
      .padding(.top, 0)
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .environment(\.colorScheme, .dark)
  }
}

extension IslandModel {
  /// The island's size in each mode: the collapsed wings follow their content, so the island
  /// never shows empty black, and both match so the notch stays in the middle.
  func frameSize() -> CGSize {
    let g = geometry
    switch mode {
    case .hidden:
      return CGSize(width: g.notchWidth, height: g.notchHeight)
    case .collapsed:
      return CGSize(width: g.notchWidth + 2 * wing(), height: g.notchHeight)
    case .grown:
      return CGSize(
        width: max(Metrics.grownWidth, g.notchWidth + 160),
        height: grownLead + Metrics.grownBody + (g.attached ? 0 : 4))
    case .open:
      let body = min(max(panelHeight, 60), g.maxHeight - g.notchHeight)
      return CGSize(width: max(Metrics.openWidth, g.notchWidth + 300), height: g.notchHeight + body)
    }
  }

  /// What the grown island keeps above its line: the notch, or a little air when floating.
  var grownLead: CGFloat { geometry.attached ? geometry.notchHeight : 4 }

  func radius() -> CGFloat {
    switch mode {
    case .hidden, .collapsed:
      return geometry.attached ? Metrics.collapsedRadius : geometry.notchHeight / 2
    case .grown: return Metrics.grownRadius
    case .open: return Metrics.openRadius
    }
  }

  func wing() -> CGFloat {
    guard let collapsed else { return 0 }
    let marks = min(3, collapsed.agents.count)
    let left = marks == 0 ? 0 : 12 + Metrics.wingMark + CGFloat(marks - 1) * 13 + 8
    var right: CGFloat = 8 + 14 + 12
    if let text = collapsed.text {
      let font = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
      right += 7 + (text as NSString).size(withAttributes: [.font: font]).width.rounded(.up)
    }
    return max(left, right, Metrics.wingMin)
  }
}

// MARK: Collapsed

struct CollapsedContent: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    let c = model.collapsed
    HStack(spacing: 0) {
      if let c { MarkStack(agents: c.agents).padding(.leading, 10) }
      Spacer(minLength: model.geometry.notchWidth)
      if let c {
        HStack(spacing: 7) {
          SignalView(signal: c.signal, reduceMotion: model.reduceMotion)
          if let text = c.text {
            Text(text).font(Fonts.ui(13, .semibold)).monospacedDigit().foregroundColor(Theme.text)
          }
        }
        .padding(.trailing, 12)
      }
    }
    .frame(height: model.geometry.notchHeight)
    .contentShape(Rectangle())
    .onTapGesture { model.expand(byClick: true) }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(model.islandLabel)
    .accessibilityAddTraits(.isButton)
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

struct HostTag: View {
  let host: IslandHost
  let offline: String

  var body: some View {
    Text(host.offline ? "\(host.name) · \(offline)" : host.name)
      .font(Fonts.ui(10.5, .medium))
      .foregroundColor(Theme.secondary)
      .padding(.horizontal, 5)
      .padding(.vertical, 2)
      .background(RoundedRectangle(cornerRadius: 5).fill(Theme.card))
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
          if let row { MarkView(agent: row.agent, size: 24) }
          VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
              (Text(pop.title).foregroundColor(Theme.text)
                + Text(row.map { $0.project.isEmpty ? "" : " · \($0.project)" } ?? "")
                .foregroundColor(Theme.secondary).fontWeight(.medium))
                .font(Fonts.ui(13.5, .semibold))
                .lineLimit(1)
              if let host = row?.host { HostTag(host: host, offline: model.text("offline")) }
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
        if let c = model.collapsed {
          MarkStack(agents: c.agents)
          SignalView(signal: c.signal, reduceMotion: model.reduceMotion)
        }
        Spacer(minLength: g.notchWidth)
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
          .padding(.top, 4)
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

struct PanelBody: View {
  @ObservedObject var model: IslandModel

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let note = model.note {
        NoteView(note: note)
      } else if let request = model.requests.first {
        RequestCard(model: model, request: request)
      }
      ForEach(model.groups, id: \.group) { group in
        HStack(spacing: 6) {
          Text(model.text("group.\(group.group)")).foregroundColor(Theme.tertiary)
          Text("\(group.rows.count)").foregroundColor(Theme.faint)
        }
        .font(Fonts.ui(11.5, .medium))
        .padding(.horizontal, 8)
        .padding(.top, 12)
        .padding(.bottom, 3)
        .accessibilityAddTraits(.isHeader)
        ForEach(group.rows, id: \.key) { row in RowView(model: model, row: row) }
      }
      if model.idleCount > 0 {
        Divider().overlay(Theme.card).padding(.top, 6)
        Text(model.counted("idle", model.idleCount))
          .font(Fonts.ui(12.5))
          .foregroundColor(Theme.secondary)
          .padding(.leading, 34)
          .padding(.top, 10)
          .padding(.bottom, 2)
      }
    }
  }
}

struct RowView: View {
  @ObservedObject var model: IslandModel
  let row: IslandRow
  @State private var hover = false

  var body: some View {
    let status = model.status(of: row)
    let title = row.title.isEmpty ? model.text("untitled") : row.title
    HStack(spacing: 10) {
      MarkView(agent: row.agent, size: 16)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 4) {
          (Text(title).foregroundColor(Theme.text)
            + Text(row.project.isEmpty ? "" : " · \(row.project)").foregroundColor(Theme.secondary))
            .font(Fonts.ui(13))
            .lineLimit(1)
          if let host = row.host { HostTag(host: host, offline: model.text("offline")) }
        }
        Text(line(status))
          .font(Fonts.ui(12))
          .foregroundColor(lineColor(status))
          .lineLimit(1)
      }
      Spacer(minLength: 8)
      VStack(alignment: .trailing, spacing: 1) {
        if let name = row.model { Text(name).foregroundColor(Theme.secondary) }
        if let time = model.duration(since: row.since) {
          Text(time).foregroundColor(Theme.tertiary).monospacedDigit()
        }
      }
      .font(Fonts.ui(11.5))
      .lineLimit(1)
      Group {
        if let signal = model.signal(of: row) {
          SignalView(signal: signal, size: 13, reduceMotion: model.reduceMotion)
        } else {
          Color.clear
        }
      }
      .frame(width: 14, height: 14)
    }
    .padding(.horizontal, 8)
    .padding(.vertical, 7)
    .frame(minHeight: 46)
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
    .accessibilityLabel(
      model.text(
        "a11y.row",
        [
          "title": title, "status": model.text("status.\(status == "sign_in" ? "signIn" : status)"),
          "agent": row.agent.name,
        ])
    )
    .accessibilityAddTraits(.isButton)
  }

  private func line(_ status: String) -> String {
    var parts: [String] = []
    if status == "stuck", let time = model.duration(since: row.toolSince) {
      parts.append(model.text("stuck", ["time": time]))
    }
    if !row.line.isEmpty { parts.append(row.line) }
    if let plan = row.plan {
      parts.append(model.text("plan", ["done": "\(plan.done)", "total": "\(plan.total)"]))
    }
    if let subagents = row.subagents { parts.append(subagents.text) }
    if row.parent?.kind == "task", let task = row.parent?.title { parts.append(task) }
    return parts.joined(separator: " · ")
  }

  private func lineColor(_ status: String) -> Color {
    switch status {
    case "waiting", "sign_in": return Theme.attention
    case "failed", "limited": return Theme.danger
    case "stuck": return Theme.warning
    default: return Theme.secondary
    }
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
